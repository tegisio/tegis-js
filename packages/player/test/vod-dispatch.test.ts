// Lean-VOD auto-dispatch (lean-vod-redesign): `play()` prefers the VOD (shaka-player + clear-key CENC) path
// automatically when the mint grant carries a `vod` object, and falls back to the JIT/MSE feed if that path
// fails for any reason other than an abort — the safety property that makes it deployable mid-backfill, before
// every asset has a VOD package. These tests drive the real `play()` end-to-end through the shared play-harness
// (scripted mint/edge + fake element + fake MediaSource) with a stub shaka injected via `cfg.shaka`, so the
// dispatch, the fallback, and the abort semantics are all verified headlessly. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { harness, settle, withFakeMse, FakeMediaSource, CONTENT_KEY } from "./play-harness.ts";
import { bytesToHex } from "../src/vod.ts";
import type { ShakaLike, ShakaPlayerLike } from "../src/vod.ts";

// The harness serves the gated vod key as base64url(CONTENT_KEY); this is the 32-hex form shaka clearKeys wants.
const KEY_HEX = bytesToHex(CONTENT_KEY);
const KID = "0f0e0d0c0b0a09080706050403020100";
const MANIFEST = "https://edge.test/vod/v1/ast_1/master.m3u8";
// A vod delivery contract for the grant. keyUrl uses the harness's distinct `/vodkey/` path (see play-harness)
// so a test can fail the vod key alone while the JIT content key still resolves.
const VOD = { manifestUrl: MANIFEST, keyUrl: "/vodkey/ast_1", kid: KID };

/** A minimal shaka-player stand-in matching {@link ShakaLike}: records attach/configure/load/destroy so a test
 *  can assert the clear-key path ran, and can simulate an unsupported browser, a load failure, or an abort. */
function fakeShaka(opts: { supported?: boolean; failLoad?: boolean; onAttach?: () => void } = {}) {
  const players: FakePlayer[] = [];
  class FakePlayer implements ShakaPlayerLike {
    attached: unknown;
    configured: unknown;
    loaded?: string;
    destroyed = false;
    errorListeners: Array<(e: { detail?: unknown }) => void> = [];
    constructor() {
      players.push(this);
    }
    async attach(el: HTMLMediaElement): Promise<void> {
      opts.onAttach?.();
      this.attached = el;
    }
    configure(cfg: object): void {
      this.configured = cfg;
    }
    async load(uri: string): Promise<void> {
      this.loaded = uri;
      if (opts.failLoad) throw new Error("shaka load failed: manifest 404 (not backfilled)");
    }
    async destroy(): Promise<void> {
      this.destroyed = true;
    }
    addEventListener(type: string, listener: (e: { detail?: unknown }) => void): void {
      if (type === "error") this.errorListeners.push(listener);
    }
  }
  const Player = FakePlayer as unknown as ShakaLike["Player"];
  Player.isBrowserSupported = () => opts.supported !== false;
  return { shaka: { Player } as ShakaLike, players };
}

const play = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent", ...extra });

// (i) grant carries `vod` → play() drives the shaka/clear-key path, NOT the MSE path.
test("play() auto-dispatches to the shaka/clear-key path when the grant carries vod", async () => {
  await withFakeMse(async () => {
    const fs = fakeShaka();
    const h = harness({ grant: { vod: VOD } }, { telemetry: true }, { shaka: fs.shaka });

    const handle = await play(h);
    await settle();

    // Drove shaka: one player, attached to the caller's element, configured with clear-key CENC, loaded the
    // grant's manifest.
    expect(fs.players).toHaveLength(1);
    const p = fs.players[0]!;
    expect(p.attached).toBe(h.video);
    expect(p.configured).toEqual({ drm: { clearKeys: { [KID]: KEY_HEX } } });
    expect(p.loaded).toBe(MANIFEST);

    // The JIT/MSE path never ran: no SourceBuffer was created and no media segment was fetched.
    expect(FakeMediaSource.lastSourceBuffer).toBeUndefined();
    expect(h.segmentFetches).toHaveLength(0);

    // The entitlement funnel is preserved: attest → mint → granted still beaconed, and no fallback happened.
    expect(h.steps()).toContain("granted");
    expect(h.steps()).not.toContain("vod_fallback");

    // The returned handle tears the shaka player down.
    await handle.stop();
    await settle();
    expect(p.destroyed).toBe(true);
  });
});

// (ii) `vod` present but the gated key fetch fails (a not-yet-backfilled asset) → fall back to the JIT/MSE path,
//      which still yields a working PlaybackHandle.
test("play() falls back to the JIT/MSE path when the vod key fetch fails", async () => {
  await withFakeMse(async () => {
    const fs = fakeShaka();
    const h = harness(
      { grant: { vod: VOD }, renews: [{ manifest: [], window: { from: 0, to: 0 } }] },
      { telemetry: true },
      { shaka: fs.shaka, failVodKey: true },
    );

    const handle = await play(h);
    await settle();

    // Fell back to JIT: a SourceBuffer was created and media segments were fetched + played over MSE.
    expect(FakeMediaSource.lastSourceBuffer).toBeDefined();
    expect(h.segmentFetches.length).toBeGreaterThan(0);
    // A vod_fallback beacon marked WHY, and playback still produced a usable handle.
    expect(h.steps()).toContain("vod_fallback");
    expect(typeof handle.stop).toBe("function");
    // The vod attempt aborted before creating a shaka player (the key fetch is the first network step).
    expect(fs.players).toHaveLength(0);

    await handle.stop();
  });
});

// (ii, variant) `vod` present but shaka fails to load the manifest → fall back to JIT, and the half-built shaka
//               player is destroyed rather than leaked.
test("play() falls back to JIT when shaka fails to load, freeing the half-built player", async () => {
  await withFakeMse(async () => {
    const fs = fakeShaka({ failLoad: true });
    const h = harness(
      { grant: { vod: VOD }, renews: [{ manifest: [], window: { from: 0, to: 0 } }] },
      { telemetry: true },
      { shaka: fs.shaka },
    );

    const handle = await play(h);
    await settle();

    expect(FakeMediaSource.lastSourceBuffer).toBeDefined(); // JIT ran
    expect(h.steps()).toContain("vod_fallback");
    // The player was created, attempted the load, and was destroyed on failure (no leak).
    expect(fs.players).toHaveLength(1);
    expect(fs.players[0]!.loaded).toBe(MANIFEST);
    expect(fs.players[0]!.destroyed).toBe(true);

    await handle.stop();
  });
});

// (iii) no `vod` in the grant → the JIT path runs exactly as before, shaka is never touched.
test("play() uses the JIT/MSE path unchanged when the grant carries no vod", async () => {
  await withFakeMse(async () => {
    const fs = fakeShaka();
    const h = harness({ renews: [{ manifest: [], window: { from: 0, to: 0 } }] }, { telemetry: true }, { shaka: fs.shaka });

    const handle = await play(h);
    await settle();

    expect(FakeMediaSource.lastSourceBuffer).toBeDefined();
    expect(h.segmentFetches.length).toBeGreaterThan(0);
    expect(fs.players).toHaveLength(0); // shaka never constructed
    expect(h.steps()).not.toContain("vod_fallback");

    await handle.stop();
  });
});

// (iv) an abort DURING the vod attempt propagates and must NOT fall back to JIT.
test("an abort during the vod attempt propagates and does NOT fall back to JIT", async () => {
  await withFakeMse(async () => {
    const ac = new AbortController();
    // Abort the caller's signal from inside shaka.attach — the player.load() step's throwIfAborted then trips.
    const fs = fakeShaka({ onAttach: () => ac.abort() });
    const h = harness({ grant: { vod: VOD } }, { telemetry: true }, { shaka: fs.shaka });

    let err: unknown;
    try {
      await play(h, { signal: ac.signal });
    } catch (e) {
      err = e;
    }
    await settle();

    // The abort propagated as an AbortError — playback rejected, it did not resolve.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");

    // It did NOT fall back: the JIT path never ran and no vod_fallback beacon was emitted.
    expect(FakeMediaSource.lastSourceBuffer).toBeUndefined();
    expect(h.segmentFetches).toHaveLength(0);
    expect(h.steps()).not.toContain("vod_fallback");

    // The half-built shaka player was destroyed on the abort.
    expect(fs.players).toHaveLength(1);
    expect(fs.players[0]!.destroyed).toBe(true);
  });
});
