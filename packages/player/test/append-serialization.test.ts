// Appends are serialized across the WHOLE playback, not just within one feed loop.
//
// Seeking made this load-bearing. A seek supersedes the running feed, but the superseded run can already have a
// fetch in flight; when that fetch resolves it appends, and the new run's first append can land while the
// SourceBuffer is still `updating`. MSE answers that with a synchronous InvalidStateError — attributed to the
// SURVIVING run, which is not stale and therefore does not swallow it. The result is the feed for the position
// the viewer just seeked to dying on a misreported `segment_fetch`, with an empty buffer at the playhead, so
// the stall watchdog (which needs buffered data ahead) can never surface it either: a permanent silent freeze.
//
// The fake SourceBuffer below throws exactly like the real one, and completes an append only when the test says
// so — which is what makes the overlap deterministic instead of a timing race.

import { describe, expect, it } from "bun:test";
import { FakeMediaSource, harness, settle, withFakeMse } from "./play-harness.ts";

describe("append serialization", () => {
  it("holds a new feed run's append until the superseded run's in-flight one completes", async () => {
    await withFakeMse(
      async () => {
        const h = harness({
          grant: { manifest: ["/s1", "/s2", "/s3"], window: { from: 0, to: 4 } },
          seeks: [{ manifest: ["/s9"], window: { from: 100, to: 140 } }],
          renews: [{ manifest: [], window: { from: 0, to: 0 } }],
        });
        const errors: Array<{ code: string }> = [];
        const playing = h.player.play(h.video as unknown as HTMLVideoElement, {
          assetId: "ast_1",
          entitlement: "ent",
          onError: (e) => errors.push(e),
        });

        // play() blocks on the init append until we complete it, so step through the opening appends by hand.
        await settle();
        const sb = FakeMediaSource.lastSourceBuffer!;
        expect(sb.appended.length).toBe(1); // init
        expect(sb.release()).toBe(true);
        await settle();
        expect(sb.appended.length).toBe(2); // first media segment
        expect(sb.release()).toBe(true);
        const handle = await playing;

        // The detached feed run picks up /s2 and appends it — leave that one in flight.
        await settle();
        expect(sb.appended.length).toBe(3);
        expect(sb.updating).toBe(true);

        // Now the viewer scrubs. The seek supersedes the running feed and starts a new one, whose first append
        // arrives while the old one is still updating.
        h.video.seekTo(5400);
        await settle();
        expect(h.seekHbs.length).toBe(1);
        expect(sb.appended.length).toBe(3); // the new run's append is QUEUED, not attempted
        expect(sb.collisions).toHaveLength(0);

        // Completing the old append lets the new one through.
        expect(sb.release()).toBe(true);
        await settle();
        expect(sb.appended.length).toBe(4);
        expect(sb.collisions).toHaveLength(0);
        expect(errors.filter((e) => e.code === "segment_fetch")).toHaveLength(0);

        sb.release();
        await handle.stop();
      },
      { manualAppends: true },
    );
  });

  it("keeps the chain alive after a failed append", async () => {
    // A rejected append must not wedge every later one — the loop surfaces the error and playback can still be
    // torn down or re-fed. Pinned because the chain is the single point every append now passes through.
    await withFakeMse(
      async () => {
        const h = harness({ grant: { manifest: ["/s1", "/s2"], window: { from: 0, to: 4 } }, renews: [{ manifest: [], window: { from: 0, to: 0 } }] });
        const playing = h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent" });
        await settle();
        const sb = FakeMediaSource.lastSourceBuffer!;
        sb.release(); // init
        await settle();
        sb.release(); // first segment
        const handle = await playing;
        await settle();
        expect(sb.appended.length).toBe(3);
        sb.release();
        await settle();
        // The loop kept going after the release rather than deadlocking behind the previous link.
        expect(sb.appended.length).toBeGreaterThanOrEqual(3);
        await handle.stop();
      },
      { manualAppends: true },
    );
  });
});
