// VOD path pure-logic tests (lean-vod-redesign). These verify the transforms that stand between the mint
// grant and shaka-player: grant → vod extraction, the gated key response → hex content key, and the shaka
// clearKeys config object. All headless — no DOM, no shaka. Run: `bun test` from the repo root.

import { test, expect } from "bun:test";
import { b64u } from "../src/crypto.ts";
import {
  extractVod,
  normalizeKid,
  bytesToHex,
  keyB64uToHex,
  parseKeyResponse,
  keyHexFromResponse,
  clearKeysConfig,
  seekTargetFor,
} from "../src/vod.ts";

// The 16-byte key (bytes 0..15) as base64url — the exact shape the gated keyUrl returns. Same vector the
// content-key test uses, so the two decode paths stay in agreement.
const KEY_B64U = "AAECAwQFBgcICQoLDA0ODw";
const KEY_HEX = "000102030405060708090a0b0c0d0e0f";
const KID = "0f0e0d0c0b0a09080706050403020100";

// ── bytesToHex ──────────────────────────────────────────────────────────────────────────────────────────
test("bytesToHex zero-pads each byte to 2 chars", () => {
  expect(bytesToHex(new Uint8Array([0x00, 0x01, 0x0f, 0xa0, 0xff]))).toBe("00010fa0ff");
  expect(bytesToHex(new Uint8Array(16))).toBe("0".repeat(32));
});

// ── normalizeKid ────────────────────────────────────────────────────────────────────────────────────────
test("normalizeKid lowercases, strips dashes, and validates 16 bytes", () => {
  expect(normalizeKid(KID)).toBe(KID);
  expect(normalizeKid("ABCDEF01234567890ABCDEF012345678")).toBe("abcdef01234567890abcdef012345678");
  // UUID-style with dashes → 32 hex chars.
  expect(normalizeKid("0f0e0d0c-0b0a-0908-0706-050403020100")).toBe(KID);
  expect(normalizeKid("  " + KID + "  ")).toBe(KID); // trims
});

test("normalizeKid rejects non-32-hex", () => {
  expect(() => normalizeKid("")).toThrow();
  expect(() => normalizeKid("deadbeef")).toThrow(); // too short
  expect(() => normalizeKid(KID + "00")).toThrow(); // too long
  expect(() => normalizeKid("g".repeat(32))).toThrow(); // non-hex
});

// ── keyB64uToHex ────────────────────────────────────────────────────────────────────────────────────────
test("keyB64uToHex decodes base64url → 32-char hex", () => {
  expect(keyB64uToHex(KEY_B64U)).toBe(KEY_HEX);
  // round-trip a random 16-byte key through our own encoder (independent of a hand-computed literal)
  const raw = crypto.getRandomValues(new Uint8Array(16));
  expect(keyB64uToHex(b64u(raw))).toBe(bytesToHex(raw));
  // all-zero key
  expect(keyB64uToHex(b64u(new Uint8Array(16)))).toBe("0".repeat(32));
});

test("keyB64uToHex rejects wrong-length keys and non-strings", () => {
  expect(() => keyB64uToHex(b64u(new Uint8Array(15)))).toThrow(); // 120-bit
  expect(() => keyB64uToHex(b64u(new Uint8Array(32)))).toThrow(); // 256-bit
  expect(() => keyB64uToHex("")).toThrow();
  // @ts-expect-error — exercising the runtime guard against a non-string
  expect(() => keyB64uToHex(null)).toThrow();
});

// ── parseKeyResponse / keyHexFromResponse ───────────────────────────────────────────────────────────────
test("parseKeyResponse validates the {alg,key} body and defaults alg", () => {
  expect(parseKeyResponse({ alg: "AES-128", key: KEY_B64U })).toEqual({ alg: "AES-128", key: KEY_B64U });
  // alg is optional — defaults to AES-128
  expect(parseKeyResponse({ key: KEY_B64U })).toEqual({ alg: "AES-128", key: KEY_B64U });
  expect(() => parseKeyResponse({})).toThrow();
  expect(() => parseKeyResponse({ key: "" })).toThrow();
  expect(() => parseKeyResponse(null)).toThrow();
  expect(() => parseKeyResponse("nope")).toThrow();
});

test("keyHexFromResponse is parse + decode", () => {
  expect(keyHexFromResponse({ alg: "AES-128", key: KEY_B64U })).toBe(KEY_HEX);
});

// ── extractVod ──────────────────────────────────────────────────────────────────────────────────────────
test("extractVod pulls and normalizes the delivery contract", () => {
  const grant = {
    playbackId: "pb_1",
    vod: { manifestUrl: "https://edge/vod/v1/ast_1/master.m3u8", keyUrl: "https://mint/key/v1/ast_1?sig=x", kid: KID.toUpperCase() },
  };
  expect(extractVod(grant)).toEqual({
    manifestUrl: "https://edge/vod/v1/ast_1/master.m3u8",
    keyUrl: "https://mint/key/v1/ast_1?sig=x",
    kid: KID, // normalized to lowercase
  });
});

test("extractVod throws legibly when the asset is not VOD-enabled or fields are missing", () => {
  expect(() => extractVod(undefined)).toThrow(/no `vod`/);
  expect(() => extractVod({})).toThrow(/no `vod`/);
  expect(() => extractVod({ vod: { keyUrl: "u", kid: KID } })).toThrow(/manifestUrl/);
  expect(() => extractVod({ vod: { manifestUrl: "m", kid: KID } })).toThrow(/keyUrl/);
  expect(() => extractVod({ vod: { manifestUrl: "m", keyUrl: "u", kid: "bad" } })).toThrow(/kid/);
});

// ── clearKeysConfig ─────────────────────────────────────────────────────────────────────────────────────
test("clearKeysConfig builds the shaka drm.clearKeys object", () => {
  expect(clearKeysConfig(KID, KEY_HEX)).toEqual({ drm: { clearKeys: { [KID]: KEY_HEX } } });
  // kid is normalized (dashes/case) but the key hex is used verbatim
  expect(clearKeysConfig(KID.toUpperCase(), KEY_HEX)).toEqual({ drm: { clearKeys: { [KID]: KEY_HEX } } });
});

test("clearKeysConfig is exactly the object shaka.configure expects (kid → keyHex, both 32-hex)", () => {
  const cfg = clearKeysConfig(KID, KEY_HEX);
  const entries = Object.entries(cfg.drm.clearKeys);
  expect(entries).toHaveLength(1);
  const [k, v] = entries[0]!;
  expect(k).toMatch(/^[0-9a-f]{32}$/);
  expect(v).toMatch(/^[0-9a-f]{32}$/);
});

test("clearKeysConfig rejects a malformed key", () => {
  expect(() => clearKeysConfig(KID, "deadbeef")).toThrow(/keyHex/); // wrong length
  expect(() => clearKeysConfig(KID, KEY_HEX.toUpperCase())).toThrow(/keyHex/); // must be lowercase hex
  expect(() => clearKeysConfig("bad", KEY_HEX)).toThrow(/kid/);
});

// End-to-end pure pipeline: a key response body + a grant → the exact config shaka is handed.
test("grant + key response → shaka clearKeys config (full pure pipeline)", () => {
  const grant = { vod: { manifestUrl: "https://edge/master.m3u8", keyUrl: "https://mint/key", kid: KID } };
  const vod = extractVod(grant);
  const keyHex = keyHexFromResponse({ alg: "AES-128", key: KEY_B64U });
  expect(clearKeysConfig(vod.kid, keyHex)).toEqual({ drm: { clearKeys: { [KID]: KEY_HEX } } });
});

// ── seekTargetFor ───────────────────────────────────────────────────────────────────────────────────────
test("seekTargetFor: default 240s, clamped to duration/2 for short assets", () => {
  expect(seekTargetFor(3600)).toBe(240); // long asset → the default 4-min mark
  expect(seekTargetFor(300)).toBe(150); // 5-min asset → duration/2
  expect(seekTargetFor(480)).toBe(240); // exactly 2× target → still 240
  expect(seekTargetFor(100)).toBe(50); // short clip → duration/2
  // unknown / not-yet-loaded duration → the default
  expect(seekTargetFor(0)).toBe(240);
  expect(seekTargetFor(NaN)).toBe(240);
  expect(seekTargetFor(-5)).toBe(240);
  // custom target respected
  expect(seekTargetFor(3600, 120)).toBe(120);
});
