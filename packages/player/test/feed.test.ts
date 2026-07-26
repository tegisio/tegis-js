// The paced, multi-window feed loop (`feedStream`) — the core of progressive playback. These drive the
// MSE-free, exported loop with fakes for its collaborators (scripted mint renew, fetch/append recorders, a
// controllable buffer + tick) so its contract is pinned without a browser, MSE, or real timers: back-pressure
// at the high-water mark, seamless window crossing (strictly-advancing seq, honest floored pos), stopping at
// the first phantom/past-end segment (seal), surfacing a hard error (no seal), graceful renew-reject, and
// abort. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { feedStream, type FeedOpts, type Window } from "../src/player.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// A scripted feed environment. `window1` is the current window's remaining segments; `windows` are returned by
// successive renews (then empty → true end). `phantomAt`/`errorAt` mark a URL that fails (404-end vs hard).
function harness(h: {
  window1: string[];
  windows?: string[][];
  phantomAt?: string;
  errorAt?: string;
}) {
  const fetched: string[] = [];
  const appended: string[] = [];
  const renews: Array<{ pos: number; seq: number }> = [];
  const ends: Array<{ reason: string; detail?: unknown }> = [];
  let seals = 0;
  let wi = 0;
  const o: FeedOpts = {
    segments: h.window1,
    windowTo: 15,
    highWaterS: 24,
    aborted: () => false,
    isEnded: () => false,
    bufferedAhead: () => 0,
    waitTick: async () => {},
    fetchSegment: async (url) => {
      fetched.push(url);
      if (url === h.phantomAt) throw new Error("fetch failed 404: " + url);
      if (url === h.errorAt) throw new Error("fetch failed 500: " + url);
      return enc(url);
    },
    append: async (buf) => {
      appended.push(dec(buf));
    },
    renew: async (pos, seq): Promise<Window> => {
      renews.push({ pos, seq });
      const w = h.windows?.[wi++];
      if (!w) return { manifest: [], window: { from: seq + 1, to: seq + 15 } };
      return { manifest: w, window: { from: seq + 1, to: seq + w.length } };
    },
    pos: () => 42.9, // sub-second real playhead — must be reported floored
    endStream: () => {
      seals++;
    },
    classifyError: (e) => (/\b404\b/.test((e as Error).message) ? "end" : "error"),
    onEnd: (reason, detail) => ends.push({ reason, detail }),
  };
  return {
    o,
    fetched,
    appended,
    renews,
    ends,
    get seals() {
      return seals;
    },
  };
}

test("crosses window boundaries: renews for the next window, floored pos + strictly-advancing seq, then seals", async () => {
  const h = harness({ window1: ["s2", "s3"], windows: [["s16", "s17"]] });
  await feedStream(h.o);
  expect(h.appended).toEqual(["s2", "s3", "s16", "s17"]);
  expect(h.renews.map((r) => r.seq)).toEqual([15, 17]); // window1.to, then window2.to — strictly advancing
  expect(h.renews[0]!.pos).toBe(42); // floored real playhead (never ahead of playback)
  expect(h.seals).toBe(1);
  expect(h.ends).toEqual([{ reason: "complete", detail: undefined }]);
});

test("stops at the first phantom/past-end segment (404) and seals — never appends it", async () => {
  const h = harness({ window1: ["s2", "s3", "s4"], phantomAt: "s4" });
  await feedStream(h.o);
  expect(h.fetched).toEqual(["s2", "s3", "s4"]);
  expect(h.appended).toEqual(["s2", "s3"]);
  expect(h.seals).toBe(1);
  expect(h.ends).toEqual([{ reason: "complete", detail: undefined }]);
});

test("a hard fetch error surfaces via onEnd('error') and does NOT seal", async () => {
  const h = harness({ window1: ["s2", "s3", "s4"], errorAt: "s4" });
  await feedStream(h.o);
  expect(h.appended).toEqual(["s2", "s3"]);
  expect(h.seals).toBe(0);
  expect(h.ends.length).toBe(1);
  expect(h.ends[0]!.reason).toBe("error");
});

test("an empty renewed window is the true end (nothing appended, seals)", async () => {
  const h = harness({ window1: [] }); // consumed → renew → no scripted window → empty → end
  await feedStream(h.o);
  expect(h.renews.length).toBe(1);
  expect(h.appended).toEqual([]);
  expect(h.seals).toBe(1);
  expect(h.ends).toEqual([{ reason: "complete", detail: undefined }]);
});

test("a renew rejection ends gracefully at the buffered content (seals, no throw)", async () => {
  const h = harness({ window1: ["s2"] });
  h.o.renew = async () => {
    throw new Error("renew failed: 403"); // expired grant / paced-out / network
  };
  await expect(feedStream(h.o)).resolves.toBeUndefined();
  expect(h.appended).toEqual(["s2"]);
  expect(h.seals).toBe(1);
});

test("back-pressure: waits while buffered >= highWater, resumes + appends once it drains", async () => {
  let ahead = 30; // above highWater (24)
  let ticks = 0;
  const appended: string[] = [];
  await feedStream({
    segments: ["s2"],
    windowTo: 15,
    highWaterS: 24,
    aborted: () => false,
    isEnded: () => false,
    bufferedAhead: () => ahead,
    waitTick: async () => {
      ticks++;
      if (ticks >= 2) ahead = 5; // playhead drains the buffer below high-water
    },
    fetchSegment: async (u) => enc(u),
    append: async (b) => {
      appended.push(dec(b));
    },
    renew: async () => ({ manifest: [], window: { from: 16, to: 30 } }),
    pos: () => 0,
    endStream: () => {},
    classifyError: () => "end",
  });
  expect(ticks).toBeGreaterThanOrEqual(2); // held while the buffer was full
  expect(appended).toEqual(["s2"]); // then fetched + appended once drained
});

test("abort stops immediately, reports onEnd('aborted'), and never seals", async () => {
  let n = 0;
  const appended: string[] = [];
  const ends: string[] = [];
  await feedStream({
    segments: ["s2", "s3", "s4"],
    windowTo: 15,
    highWaterS: 24,
    aborted: () => n >= 1, // abort after the first append
    isEnded: () => false,
    bufferedAhead: () => 0,
    waitTick: async () => {},
    fetchSegment: async (u) => enc(u),
    append: async (b) => {
      appended.push(dec(b));
      n++;
    },
    renew: async () => ({ manifest: [], window: { from: 16, to: 30 } }),
    pos: () => 0,
    endStream: () => {
      throw new Error("must not seal on abort");
    },
    classifyError: () => "end",
    onEnd: (r) => ends.push(r),
  });
  expect(appended).toEqual(["s2"]);
  expect(ends).toEqual(["aborted"]);
});
