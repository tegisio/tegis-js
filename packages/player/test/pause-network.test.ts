// End-to-end behavioural check of the feed loop's NETWORK behaviour — the reported bug: "stopping the video
// doesn't actually stop loading the segments".
//
// This drives the REAL exported `feedStream` (not a reimplementation) against a simulated element whose buffer
// grows on append and drains as the playhead advances, and counts actual `fetchSegment` calls. The assertions
// are about observable network volume, which is what the viewer's data plan actually feels.
import { describe, expect, it } from "bun:test";
import { feedStream } from "../src/player.ts";

const SEG_S = 2; // delivery segment grid
const PLAYING_TARGET = 24; // HIGH_WATER_S
const PAUSED_TARGET = 8; // PAUSED_HIGH_WATER_S
const HIDDEN_PAUSED_TARGET = 0; // HIDDEN_PAUSED_HIGH_WATER_S

/**
 * A deterministic stand-in for the <video> + MSE pair the player feeds.
 *
 * Buffer grows by one segment per append and drains as the playhead advances; `tick()` is the test's clock,
 * advancing the playhead only while playing (a paused element emits no progress, exactly as in a browser).
 * The loop is bounded by a tick budget so a parked loop terminates instead of spinning the test forever.
 */
function sim(opts: { paused?: boolean; hidden?: boolean; buffered?: number; maxTicks?: number } = {}) {
  const s = {
    paused: opts.paused ?? false,
    hidden: opts.hidden ?? false,
    currentTime: 0,
    bufferedEnd: opts.buffered ?? 0,
    fetches: [] as string[],
    ticks: 0,
    maxTicks: opts.maxTicks ?? 200,
    stopped: false,
  };
  const targetAheadS = () => (!s.paused ? PLAYING_TARGET : s.hidden ? HIDDEN_PAUSED_TARGET : PAUSED_TARGET);
  return {
    s,
    targetAheadS,
    opts: {
      segments: Array.from({ length: 500 }, (_, i) => `/seg/${i + 2}.m4s`),
      windowTo: 500,
      targetAheadS,
      aborted: () => s.stopped,
      isEnded: () => false,
      bufferedAhead: () => Math.max(0, s.bufferedEnd - s.currentTime),
      // The test clock. Advances the playhead only while playing, and gives up after the tick budget so a
      // correctly-parked loop ends the test rather than hanging it.
      waitTick: async () => {
        s.ticks++;
        if (s.ticks >= s.maxTicks) s.stopped = true;
        if (!s.paused) s.currentTime += 0.5;
      },
      fetchSegment: async (url: string) => {
        s.fetches.push(url);
        return new Uint8Array([1]);
      },
      append: async () => {
        s.bufferedEnd += SEG_S;
      },
      renew: async () => ({ manifest: [], window: { from: 0, to: 0 } }),
      pos: () => s.currentTime,
      endStream: () => {},
      classifyError: () => "error" as const,
    },
  };
}

describe("feed loop network behaviour", () => {
  // Baseline: playing fills to the playing target and then paces with the playhead, never running away.
  it("while playing, buffers ahead to the playing target and no further", async () => {
    const h = sim({ maxTicks: 120 });
    await feedStream(h.opts);
    const ahead = h.s.bufferedEnd - h.s.currentTime;
    expect(ahead).toBeGreaterThanOrEqual(PLAYING_TARGET - SEG_S);
    expect(ahead).toBeLessThanOrEqual(PLAYING_TARGET + SEG_S);
  });

  // THE REGRESSION TEST for the reported bug. A viewer pauses with a full buffer: the old loop compared
  // against a fixed 24s target, saw it satisfied, and parked — but only after having filled to 24s. The real
  // failure is the case below (pausing while the buffer is still filling); this one pins that a pause with an
  // already-full buffer issues nothing more.
  it("pausing with a full buffer issues zero further fetches", async () => {
    const h = sim({ paused: true, buffered: PLAYING_TARGET, maxTicks: 50 });
    await feedStream(h.opts);
    expect(h.s.fetches).toHaveLength(0);
  });

  // The case that actually burned bandwidth: pause EARLY, while the buffer is still filling. The old loop kept
  // pulling all the way to the 24s playing target — roughly 10MB at 1080p — for content the viewer had just
  // stopped. It must now stop at the much smaller paused target.
  it("pausing mid-fill stops at the paused target, not the playing target", async () => {
    const h = sim({ paused: true, buffered: 0, maxTicks: 200 });
    await feedStream(h.opts);
    const buffered = h.s.bufferedEnd;
    expect(buffered).toBeGreaterThanOrEqual(PAUSED_TARGET); // enough that resume is instant
    expect(buffered).toBeLessThanOrEqual(PAUSED_TARGET + SEG_S); // and no more
    // Concretely: the old behaviour would have fetched ~12 segments here, the new one ~4.
    expect(h.s.fetches.length).toBeLessThanOrEqual(PAUSED_TARGET / SEG_S + 1);
  });

  // A paused viewer who is also looking at another tab gets nothing at all.
  it("paused AND hidden fetches nothing, even with an empty buffer", async () => {
    const h = sim({ paused: true, hidden: true, buffered: 0, maxTicks: 50 });
    await feedStream(h.opts);
    expect(h.s.fetches).toHaveLength(0);
  });

  // Backgrounded audio is a real use — a hidden tab that is still PLAYING must keep its full target, or the
  // thing the viewer is actually listening to stalls.
  it("hidden but still playing keeps the full playing target", async () => {
    const h = sim({ paused: false, hidden: true, maxTicks: 120 });
    await feedStream(h.opts);
    const ahead = h.s.bufferedEnd - h.s.currentTime;
    expect(ahead).toBeGreaterThanOrEqual(PLAYING_TARGET - SEG_S);
  });

  // Resuming must re-open the tap: the target rises back to the playing one and fetching continues.
  it("resuming after a pause resumes fetching to the playing target", async () => {
    const h = sim({ paused: true, buffered: 0, maxTicks: 400 });
    // Unpause once the paused target has been reached, mimicking a viewer pressing play.
    const origTick = h.opts.waitTick;
    h.opts.waitTick = async () => {
      if (h.s.paused && h.s.bufferedEnd >= PAUSED_TARGET) h.s.paused = false;
      await origTick();
    };
    await feedStream(h.opts);
    expect(h.s.bufferedEnd).toBeGreaterThan(PAUSED_TARGET + SEG_S);
    const ahead = h.s.bufferedEnd - h.s.currentTime;
    expect(ahead).toBeGreaterThanOrEqual(PLAYING_TARGET - SEG_S);
  });
});
