// The asset-duration seam: declaring the asset's real length on the MediaSource so the host gets a stable
// scrubber instead of a total that grows with the buffer, and so watch-through quartiles have a correct
// denominator. See docs/player-streaming-ux-plan.md §3.1 in the core repo.
import { describe, expect, it } from "bun:test";
import { setMediaSourceDuration } from "../src/player.ts";
import { harness, settle, withFakeMse } from "./play-harness.ts";

/** Minimal MediaSource stand-in: records what was assigned, and can reject like a real one does when the
 *  readyState is wrong or a SourceBuffer is updating. */
function fakeMS(opts: { throwOnSet?: boolean } = {}) {
  let stored: number | undefined;
  return {
    get duration() {
      return stored as number;
    },
    set duration(v: number) {
      if (opts.throwOnSet) throw new Error("InvalidStateError");
      stored = v;
    },
    assigned: () => stored,
  } as unknown as MediaSource & { assigned: () => number | undefined };
}

describe("setMediaSourceDuration", () => {
  it("adopts a real duration and reports it back", () => {
    const ms = fakeMS();
    expect(setMediaSourceDuration(ms, 7324.5)).toBe(7324.5);
    expect(ms.assigned()).toBe(7324.5);
  });

  // An origin that reports nothing must leave MSE alone — guessing a total is worse than showing none.
  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -12],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("ignores a %s duration and assigns nothing", (_label, value) => {
    const ms = fakeMS();
    expect(setMediaSourceDuration(ms, value as number | undefined)).toBe(0);
    expect(ms.assigned()).toBeUndefined();
  });

  // MSE throws if the readyState is wrong or a SourceBuffer is updating. A cosmetic timeline must never be
  // able to break playback, so the throw is swallowed and reported as "no duration adopted".
  it("swallows a rejected assignment", () => {
    const ms = fakeMS({ throwOnSet: true });
    expect(setMediaSourceDuration(ms, 120)).toBe(0);
  });

  // A still-encoding asset reports the EXPECTED total, which is exactly what we want on the timeline — the
  // viewer sees the real length from the first frame rather than a number that grows as the encode catches up.
  it("adopts the expected duration of a partial asset", () => {
    const ms = fakeMS();
    expect(setMediaSourceDuration(ms, 600)).toBe(600);
    expect(ms.assigned()).toBe(600);
  });
});

// Documents the arithmetic that made the shipped quartile beacons wrong, and why the fix had to switch
// denominators rather than just guard the existing one.
describe("watch-through quartile denominator", () => {
  const HIGH_WATER_S = 24; // the player's prefetch lead

  /** What `video.duration` reports under MSE when no duration was declared: the buffered end, i.e. the
   *  playhead plus the prefetch lead. */
  const bufferTrackingDuration = (t: number) => t + HIGH_WATER_S;

  it("is independent of asset length when taken from an undeclared MSE duration", () => {
    // The same playhead yields the same "percentage" for a 1-minute clip and a 3-hour film.
    const pctAt = (t: number) => Math.floor((t / bufferTrackingDuration(t)) * 100);
    expect(pctAt(8)).toBe(25);
    expect(pctAt(24)).toBe(50);
    expect(pctAt(72)).toBe(75);
  });

  it("tracks real progress when taken from the asset duration", () => {
    const assetSec = 7200; // 2 hours
    const pctAt = (t: number) => Math.floor((t / assetSec) * 100);
    expect(pctAt(8)).toBe(0);
    expect(pctAt(1800)).toBe(25);
    expect(pctAt(3600)).toBe(50);
    expect(pctAt(5400)).toBe(75);
  });
});

// The arithmetic above documents WHY the denominator changed; these drive the real `timeupdate` handler, which
// is where a plumbing regression would actually bite — `assetDurationSec` is fed by `sink.setDuration(grant
// .duration)`, and anything that makes that resolve 0 silently kills every watched_* beacon fleet-wide with a
// green suite and no user-visible symptom.
describe("watch-through beacons", () => {
  it("fires each quartile exactly once, keyed to the grant's duration", async () => {
    await withFakeMse(async () => {
      const h = harness({ grant: { duration: 100, manifest: ["/s1"] }, renews: [{ manifest: [], window: { from: 0, to: 0 } }] }, { telemetry: true });
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      await settle();
      for (const t of [10, 26, 26, 51, 76, 99, 100]) h.video.progress(t);

      const watched = h.steps().filter((s) => s.startsWith("watched_"));
      expect(watched).toEqual(["watched_25", "watched_50", "watched_75", "watched_100"]);
      await handle.stop();
    });
  });

  it("emits nothing at all when the grant reports no duration", async () => {
    // A ratio taken from `video.duration` under MSE is `t/(t+prefetch)` — the same "percentage" for a one-minute
    // clip and a three-hour film. Emitting nothing is the deliberate choice over emitting that.
    await withFakeMse(async () => {
      const h = harness({ grant: { duration: undefined, manifest: ["/s1"] }, renews: [{ manifest: [], window: { from: 0, to: 0 } }] }, { telemetry: true });
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      await settle();
      for (const t of [10, 50, 90, 200]) h.video.progress(t);

      expect(h.steps().filter((s) => s.startsWith("watched_"))).toHaveLength(0);
      await handle.stop();
    });
  });
});
