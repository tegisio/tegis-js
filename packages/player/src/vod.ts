// @tegis/player — VOD delivery path (lean-vod-redesign). The pivot away from the bespoke JIT-per-segment
// MSE feed: for pre-recorded content the whole asset is pre-packaged once to CENC-encrypted fMP4 HLS, and
// the browser plays it with shaka-player under a clear-key CENC license. That gives full seek across the
// entire asset (the JIT player could only trail the encode frontier and could not seek) while keeping the
// existing protection model: the content is inert without the mint-gated key.
//
// This module is the delivery-agnostic core: pure functions that turn a mint grant + the gated key response
// into exactly the shaka-player clear-key config. No DOM, no shaka, no fetch here — those live in
// TegisPlayer.playVod (player.ts), which wires these into the entitlement funnel + QoE. Keeping the pure
// logic here is what lets `bun test` verify it headlessly.

import { unb64u } from "./crypto.ts";

/** 32 lowercase hex chars == 16 bytes (a CENC key id or an AES-128 content key). */
const HEX32 = /^[0-9a-f]{32}$/;

/** Lowercase hex-encode raw bytes (the form shaka-player's org.w3.clearkey path wants for both kid and key). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Normalize a CENC key id to 32 lowercase hex chars. Accepts hex with optional dashes (UUID-style) and any
 * case. Throws on anything that isn't 16 bytes of hex — a malformed kid would otherwise surface much later as
 * an opaque shaka "no license" error, so we fail fast and legibly.
 */
export function normalizeKid(kid: string): string {
  const h = String(kid ?? "")
    .trim()
    .replace(/-/g, "")
    .toLowerCase();
  if (!HEX32.test(h)) throw new Error(`vod: kid must be 32 hex chars (16 bytes), got ${JSON.stringify(kid)}`);
  return h;
}

/**
 * Decode the base64url-encoded raw content key (what the gated keyUrl returns) into the 32-char hex string
 * shaka-player's clearKeys map expects. Throws unless it decodes to exactly 16 bytes — an AES-128 CENC key is
 * 128 bits, and a wrong length would silently decrypt to garbage rather than error at the key step.
 */
export function keyB64uToHex(keyB64u: string): string {
  if (typeof keyB64u !== "string" || keyB64u === "") {
    throw new Error("vod: key must be a non-empty base64url string");
  }
  const bytes = unb64u(keyB64u);
  if (bytes.length !== 16) throw new Error(`vod: key must decode to 16 bytes (AES-128), got ${bytes.length}`);
  return bytesToHex(bytes);
}

/** The JSON body the gated keyUrl responds with: `{ alg: "AES-128", key: <base64url raw 16-byte key> }`. */
export interface KeyResponse {
  alg: string;
  key: string;
}

/** Validate the gated keyUrl JSON body. `alg` defaults to `AES-128` (the only scheme today) when absent. */
export function parseKeyResponse(json: unknown): KeyResponse {
  if (!json || typeof json !== "object") throw new Error("vod: key response must be a JSON object");
  const o = json as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "") throw new Error("vod: key response missing `key`");
  const alg = typeof o.alg === "string" && o.alg !== "" ? o.alg : "AES-128";
  return { alg, key: o.key };
}

/** Gated keyUrl JSON body → the 32-char hex content key ready for shaka clearKeys. */
export function keyHexFromResponse(json: unknown): string {
  return keyB64uToHex(parseKeyResponse(json).key);
}

/** The VOD delivery contract the mint's playback grant returns (`grant.vod`). */
export interface VodDelivery {
  /** HLS master playlist URL served by the edge (`/vod/v1/{ast}/master.m3u8`). */
  manifestUrl: string;
  /** Gated URL that returns the content key (`{ alg, key }`), entitlement + attestation enforced. */
  keyUrl: string;
  /** CENC key id — 32 lowercase hex chars (16 bytes), normalized. */
  kid: string;
}

/** A grant that MAY carry a VOD delivery object — kept structural so vod.ts doesn't import player.ts. */
export interface VodGrantLike {
  vod?: Partial<VodDelivery> | null;
}

/**
 * Pull + validate the VOD delivery contract off a mint grant. The kid is normalized to 32 lowercase hex.
 * Throws a legible error when the edge/mint isn't VOD-enabled for the asset (no `vod` object) or when a
 * required field is missing — the caller treats that as "this asset can't be played via the VOD path".
 */
export function extractVod(grant: VodGrantLike | null | undefined): VodDelivery {
  const v = grant?.vod;
  if (!v) {
    throw new Error("vod: grant has no `vod` object — the edge/mint is not VOD-enabled for this asset");
  }
  if (typeof v.manifestUrl !== "string" || v.manifestUrl === "") throw new Error("vod: grant.vod.manifestUrl missing");
  if (typeof v.keyUrl !== "string" || v.keyUrl === "") throw new Error("vod: grant.vod.keyUrl missing");
  return {
    manifestUrl: v.manifestUrl,
    keyUrl: v.keyUrl,
    kid: normalizeKid(String(v.kid ?? "")),
  };
}

/** The shaka-player clearKeys DRM configuration object: `{ drm: { clearKeys: { [kid]: keyHex } } }`. */
export interface ClearKeysConfig {
  drm: { clearKeys: Record<string, string> };
}

/**
 * Build the shaka-player clear-key CENC config for one asset. Both kid and key are 32-char lowercase hex —
 * exactly what shaka's `org.w3.clearkey` path expects — so this is the whole DRM config passed to
 * `player.configure(...)`.
 */
export function clearKeysConfig(kid: string, keyHex: string): ClearKeysConfig {
  const k = normalizeKid(kid);
  if (!HEX32.test(keyHex)) throw new Error("vod: keyHex must be 32 hex chars (16 bytes)");
  return { drm: { clearKeys: { [k]: keyHex } } };
}

/**
 * The seek target used by the VOD verification flow (harness + e2e): default 240s, clamped to `duration/2`
 * when the asset is shorter than twice the target, so a short clip still seeks somewhere real. Pure so the
 * clamp is unit-tested independently of any player.
 */
export function seekTargetFor(durationSec: number, want = 240): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return want;
  return Math.min(want, durationSec / 2);
}

// ── Minimal shaka-player surface ──────────────────────────────────────────────────────────────────────
// TegisPlayer.playVod uses only this slice of shaka-player. Typing against a local minimal interface (rather
// than shaka's generated .d.ts) keeps our emitted declarations self-contained and independent of shaka's
// gnarly clutz types, and lets a host inject a real shaka namespace OR a stub.

export interface ShakaPlayerLike {
  attach(mediaElement: HTMLMediaElement): Promise<void>;
  // `object` (not Record<string, unknown>) so a typed config literal like ClearKeysConfig is assignable.
  configure(config: object): void;
  load(uri: string, startTime?: number | null): Promise<void>;
  destroy(): Promise<void>;
  addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void;
}

export interface ShakaLike {
  Player: {
    new (mediaElement?: HTMLMediaElement | null): ShakaPlayerLike;
    isBrowserSupported?(): boolean;
    version?: string;
  };
  polyfill?: { installAll(): void };
}
