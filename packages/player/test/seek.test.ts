// Player-side seek behaviour. The mint side is tested in the core repo (cmd/mint/seek_test.go); these cover
// the decisions the player makes before it ever asks the mint.
import { describe, expect, it } from "bun:test";
import { isBuffered, nearestBufferedPos } from "../src/player.ts";
import { harness, settle, withFakeMse } from "./play-harness.ts";

/** A <video> stand-in exposing only `buffered`, as TimeRanges. */
function withBuffered(ranges: [number, number][]): HTMLVideoElement {
  return {
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    },
  } as unknown as HTMLVideoElement;
}

describe("isBuffered", () => {
  // The check that keeps ordinary scrubbing free. A viewer nudging back ten seconds is almost always still
  // inside the buffer, and must not cost a mint round trip — nor burn a slot against the session's
  // distinct-segment budget, which is what would happen if every scrub asked for a new window.
  it("recognises a position inside a buffered range", () => {
    const v = withBuffered([[10, 40]]);
    expect(isBuffered(v, 10)).toBe(true);
    expect(isBuffered(v, 25)).toBe(true);
    expect(isBuffered(v, 40)).toBe(true);
  });

  it("rejects a position outside every range", () => {
    const v = withBuffered([[10, 40]]);
    expect(isBuffered(v, 0)).toBe(false);
    expect(isBuffered(v, 60)).toBe(false);
    expect(isBuffered(v, 5400)).toBe(false); // the far-forward jump that needs a real seek
  });

  it("handles multiple disjoint ranges", () => {
    const v = withBuffered([
      [0, 12],
      [300, 340],
    ]);
    expect(isBuffered(v, 6)).toBe(true);
    expect(isBuffered(v, 320)).toBe(true);
    expect(isBuffered(v, 150)).toBe(false); // the gap between them
  });

  // A seek landing a hair outside a boundary is still effectively buffered; without the margin, a scrub to
  // exactly the edge would trigger a pointless network round trip.
  it("allows a small margin around range boundaries", () => {
    const v = withBuffered([[10, 40]]);
    expect(isBuffered(v, 9.9)).toBe(true);
    expect(isBuffered(v, 40.2)).toBe(true);
    expect(isBuffered(v, 9.0)).toBe(false);
  });

  it("is false when nothing is buffered", () => {
    expect(isBuffered(withBuffered([]), 0)).toBe(false);
    expect(isBuffered({} as HTMLVideoElement, 0)).toBe(false);
  });
});

describe("nearestBufferedPos", () => {
  // Where a refused seek has to put the playhead back. A position outside every range doesn't just show the
  // wrong frame — bufferedAhead() reads 0 for it, so back-pressure can never hold and the loop fetches flat out.
  it("returns the position itself when it is already inside a range", () => {
    expect(nearestBufferedPos(withBuffered([[10, 40]]), 25)).toBe(25);
  });

  it("clamps to the nearest range edge when the position is outside", () => {
    const v = withBuffered([[10, 40]]);
    expect(nearestBufferedPos(v, 0)).toBe(10);
    expect(nearestBufferedPos(v, 5400)).toBe(40);
  });

  it("picks the closest of several disjoint ranges", () => {
    const v = withBuffered([
      [0, 12],
      [300, 340],
    ]);
    expect(nearestBufferedPos(v, 200)).toBe(300); // 100s from the second, 188s from the first
    expect(nearestBufferedPos(v, 100)).toBe(12);
  });

  it("reports nothing when nothing is buffered — there is no better place to be", () => {
    expect(nearestBufferedPos(withBuffered([]), 10)).toBeUndefined();
    expect(nearestBufferedPos({} as HTMLVideoElement, 10)).toBeUndefined();
  });
});

// ---- the seek path inside play() -----------------------------------------------------------------------
//
// These drive the real `play()` against a fake element + scripted mint, because the seek handler, the shared
// heartbeat seq counter and the refusal path exist only inside that closure.

describe("a seek the mint will not authorize", () => {
  // `seek_refused` documents "playback continues from where it was". Before the fix the player left the
  // playhead at the unbuffered target the host had already jumped to: the picture froze there forever AND the
  // surviving feed run downloaded the rest of the asset at full speed, because bufferedAhead() reads 0 outside
  // every range so its back-pressure hold was never satisfied. Neither symptom can raise the stall watchdog,
  // which requires buffered data ahead.
  it("puts the playhead back inside the buffer when the mint rejects it", async () => {
    await withFakeMse(async () => {
      const h = harness({ seeks: ["reject"] }, { currentTime: 0, ranges: [[0, 20]] });
      const errors: Array<{ code: string }> = [];
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, {
        assetId: "ast_1",
        entitlement: "ent",
        onError: (e) => errors.push(e),
      });
      h.video.progress(10); // the viewer is watching at 0:10, inside the buffered range
      h.video.seekTo(5400); // ...and drags to 1:30:00, which is not
      await settle();

      expect(h.seekHbs.length).toBe(1);
      expect(errors.map((e) => e.code)).toContain("seek_refused");
      expect(h.video.currentTime).toBe(10); // back where they were, not parked at 5400
      await handle.stop();
    });
  });

  // Same promise, different shape of refusal: a 200 with an empty manifest ("past the end / nothing to sign").
  it("puts the playhead back when the mint answers with an empty window", async () => {
    await withFakeMse(async () => {
      const h = harness({ seeks: [{ manifest: [], window: { from: 0, to: 0 } }] }, { currentTime: 0, ranges: [[0, 20]] });
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      h.video.progress(12);
      h.video.seekTo(9000);
      await settle();
      expect(h.video.currentTime).toBe(12);
      await handle.stop();
    });
  });

  // The restore writes currentTime, which re-fires `seeking`. That must be recognised as already-buffered and
  // cost nothing — otherwise the restore chases itself round the mint forever.
  it("does not turn the restore into another mint round trip", async () => {
    await withFakeMse(async () => {
      const h = harness({ seeks: ["reject"] }, { currentTime: 0, ranges: [[0, 20]] });
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      h.video.progress(10);
      h.video.seekTo(5400);
      await settle();
      expect(h.seekHbs.length).toBe(1); // the restore did NOT ask the mint again
      await handle.stop();
    });
  });
});

describe("the seek heartbeat's seq", () => {
  // The mint's heartbeat contract is strictly monotonic per playback, and renew + seek share that counter. The
  // seek used to sign with the grant's ORIGINAL window.to — the exact value the first renew already spends —
  // so every seek after the first window drained (under a minute of viewing) presented a replayed counter that
  // a conforming validator must deny.
  it("clears every seq the renew loop has already reported", async () => {
    await withFakeMse(async () => {
      const h = harness(
        {
          grant: { manifest: ["/s1"], window: { from: 0, to: 2 } },
          renews: [
            { manifest: ["/s2"], window: { from: 3, to: 5 } },
            { manifest: [], window: { from: 0, to: 0 } },
          ],
          seeks: [{ manifest: ["/s9"], window: { from: 100, to: 140 } }],
        },
        { currentTime: 0, ranges: [[0, 20]] },
      );
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      await settle();
      expect(h.renewHbs.map((r) => r.seq)).toEqual([2, 5]); // renew still reports the raw window it is finishing

      h.video.progress(10);
      h.video.seekTo(5400);
      await settle();

      expect(h.seekHbs.length).toBe(1);
      expect(h.seekHbs[0]!.seq).toBeGreaterThan(5); // ...and the seek clears the highest of them
      expect(h.seekHbs[0]!.seq).not.toBe(2); // the frozen grant window — the shipped bug
      await handle.stop();
    });
  });

  // A seek re-bases the window and can legitimately move BACKWARD, so tracking the live window alone would let
  // the counter go down. It has to be a running maximum.
  it("keeps rising across a backward seek that lowers the window", async () => {
    await withFakeMse(async () => {
      const h = harness(
        {
          grant: { manifest: ["/s1"], window: { from: 0, to: 40 } },
          renews: [{ manifest: [], window: { from: 0, to: 0 } }],
          seeks: [
            { manifest: ["/s9"], window: { from: 100, to: 140 } }, // forward
            { manifest: ["/s2"], window: { from: 2, to: 6 } }, // and back to the start
          ],
        },
        { currentTime: 0, ranges: [[0, 20]] },
      );
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
      await settle();
      h.video.progress(10);
      h.video.seekTo(5400);
      await settle();
      h.video.progress(5401);
      h.video.seekTo(60);
      await settle();

      expect(h.seekHbs.length).toBe(2);
      expect(h.seekHbs[1]!.seq).toBeGreaterThan(h.seekHbs[0]!.seq);
      await handle.stop();
    });
  });
});

describe("overlapping seeks", () => {
  // Ordered by REQUEST, not by response arrival: the viewer's LAST scrub wins even when an earlier one's mint
  // response lands later. A superseded response must neither start a feed nor report seek_refused — the failure
  // is silent otherwise, since the stall watchdog needs buffered data ahead and after a seek there is none.
  it("reports only the seek the viewer actually ended on", async () => {
    await withFakeMse(async () => {
      // Both seeks are refused, so the ONLY observable is how many seek_refused errors surface: one, for the
      // request the viewer actually ended on.
      const h = harness({ seeks: ["reject", "reject"] }, { currentTime: 0, ranges: [[0, 20]] });
      const errors: Array<{ code: string }> = [];
      const handle = await h.player.play(h.video as unknown as HTMLVideoElement, {
        assetId: "ast_1",
        entitlement: "ent",
        onError: (e) => errors.push(e),
      });
      h.video.progress(10);
      h.video.seekTo(5400); // scrub 1
      h.video.seekTo(7200); // scrub 2, before scrub 1's response lands
      await settle();

      expect(h.seekHbs.length).toBe(2);
      expect(errors.filter((e) => e.code === "seek_refused").length).toBe(1);
      await handle.stop();
    });
  });
});
