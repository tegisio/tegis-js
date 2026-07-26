// Multi-window renewal (the "play() past one grant window" enhancement). `play()` streams the first grant
// window, then a PLAYBACK-PACED pump renews window-by-window to the asset's true end. These tests drive the
// extracted, MSE-free core loop (`pumpWindows`) with fakes for its collaborators — a scripted mint `renew`, a
// scripted `appendWindow` (returns the true-end flag), a gate `awaitDrain`, and a `pos` reader — so the loop's
// control flow + the mint pacing contract (strictly-advancing seq, honest floored pos) are pinned without a
// browser, MSE, or real timers. Lives under test/ (not src/) so the player `tsc --noEmit` never resolves
// `bun:test`. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { pumpWindows, type Window } from "../src/player.ts";

const SEGS = 15; // a 30s window at segDur=2 — mirrors the mint's ceil(ttl/segDur)

// A fake, contiguous window server mirroring the mint: renew(seq) → the next window {from: seq+1, to: seq+SEGS}
// with SEGS media-segment URLs. Records every (pos, seq) it was asked for so tests can assert the pace inputs.
function fakeMint() {
  const renews: Array<{ pos: number; seq: number }> = [];
  const renew = async (pos: number, seq: number): Promise<Window> => {
    renews.push({ pos, seq });
    const from = seq + 1;
    return { manifest: Array.from({ length: SEGS }, (_, i) => `seg-${from + i}`), window: { from, to: seq + SEGS } };
  };
  return { renews, renew };
}

test("renews window-by-window until a window reaches the true end; seq strictly advances", async () => {
  const m = fakeMint();
  const appended: string[][] = [];
  // The 3rd appended window runs off the end (a 404 inside it) → reachedEnd.
  const appendWindow = async (urls: string[]) => {
    appended.push(urls);
    return appended.length >= 3;
  };
  await pumpWindows({
    windowTo: SEGS,
    reachedEnd: false,
    renew: m.renew,
    appendWindow,
    awaitDrain: async () => true,
    pos: () => 22,
  });
  expect(m.renews.map((r) => r.seq)).toEqual([15, 30, 45]); // last-appended index, strictly increasing per renew
  expect(appended.length).toBe(3);
  expect(appended[0]![0]).toBe("seg-16"); // window 2 starts one past window 1's `to`
});

test("short asset (window 1 already ended) → the pump never renews or appends", async () => {
  const m = fakeMint();
  let appends = 0;
  await pumpWindows({
    windowTo: SEGS,
    reachedEnd: true, // window 1 hit a 404 in play() — a clip that fits one grant window
    renew: m.renew,
    appendWindow: async () => {
      appends++;
      return true;
    },
    awaitDrain: async () => true,
    pos: () => 0,
  });
  expect(m.renews.length).toBe(0);
  expect(appends).toBe(0);
});

test("stops (no renew) when awaitDrain signals playback ended / element gone", async () => {
  const m = fakeMint();
  await pumpWindows({
    windowTo: SEGS,
    reachedEnd: false,
    renew: m.renew,
    appendWindow: async () => false,
    awaitDrain: async () => false, // playback ended before the buffer drained to a renew
    pos: () => 10,
  });
  expect(m.renews.length).toBe(0);
});

test("ends gracefully (no throw, nothing appended) when a renew is rejected", async () => {
  let appends = 0;
  const run = pumpWindows({
    windowTo: SEGS,
    reachedEnd: false,
    renew: async () => {
      throw new Error("renew failed: 403"); // e.g. paced-out at high playback rate, or an expired grant
    },
    appendWindow: async () => {
      appends++;
      return false;
    },
    awaitDrain: async () => true,
    pos: () => 10,
  });
  await expect(run).resolves.toBeUndefined();
  expect(appends).toBe(0);
});

test("stops when the mint returns an empty window (its signal for the true end)", async () => {
  let renews = 0;
  let appends = 0;
  await pumpWindows({
    windowTo: SEGS,
    reachedEnd: false,
    renew: async () => {
      renews++;
      return { manifest: [], window: { from: 16, to: 30 } };
    },
    appendWindow: async () => {
      appends++;
      return false;
    },
    awaitDrain: async () => true,
    pos: () => 10,
  });
  expect(renews).toBe(1);
  expect(appends).toBe(0); // an empty window is never appended
});

test("reports the real playhead (floored) to the pace guard, never a value ahead of playback", async () => {
  const m = fakeMint();
  let windows = 0;
  await pumpWindows({
    windowTo: SEGS,
    reachedEnd: false,
    renew: m.renew,
    appendWindow: async () => ++windows >= 1, // stop after one window
    awaitDrain: async () => true,
    pos: () => 42.9, // real currentTime carries sub-second precision
  });
  expect(m.renews[0]!.pos).toBe(42); // floored — compared against integer wall-seconds by the mint
});
