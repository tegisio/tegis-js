// The attach bound and its error taxonomy — the one guarantee change #1 makes: a MediaSource that never opens
// surfaces `attach_failed` instead of hanging play() forever.
//
// Two halves, tested where each lives. The SINK half: the wait rejects a PLAIN Error after the timeout, an
// AbortError on abort, and resolves + cleans up when `sourceopen` arrives in time. The PLAY half: a non-abort
// attach rejection becomes an `attach_failed` PlayError whose message carries the REAL reason, while an abort
// is re-thrown untouched.
//
// The taxonomy is the point, not ceremony. `play()` re-throws aborts as caller teardown, so if the timeout
// rejection ever regressed to an AbortError (the two live side by side in both sinks) playback would die with
// no attach_failed, no play_failed, no beacon and no QoE — a fully silent death that every other test survives.

import { test, expect } from "bun:test";
import { createMseSink } from "../src/mse.ts";
import { fakeVideo, FakeMediaSource, harness, withFakeMse } from "./play-harness.ts";

/** A MediaSource that attaches fine and then never opens — the shape the timeout exists for. */
function neverOpens(): { ms: any; listeners: () => number } {
  const ls = new Map<string, Set<(e?: unknown) => void>>();
  const ms: any = {
    readyState: "closed",
    handle: { __handle: true },
    duration: Number.NaN,
    addEventListener(n: string, f: (e?: unknown) => void) {
      const s = ls.get(n) ?? new Set();
      s.add(f);
      ls.set(n, s);
    },
    removeEventListener(n: string, f: (e?: unknown) => void) {
      ls.get(n)?.delete(f);
    },
    fire(n: string) {
      for (const f of [...(ls.get(n) ?? [])]) f({ type: n });
    },
  };
  return { ms, listeners: () => [...ls.values()].reduce((n, s) => n + s.size, 0) };
}

/** Install `ms` as the one the main-thread sink will construct, and force that sink to be chosen. */
async function withMainThreadSink<T>(ms: unknown, fn: (sink: ReturnType<typeof createMseSink>) => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const origMS = g.MediaSource;
  const origMMS = g.ManagedMediaSource;
  // ManagedMediaSource present ⇒ createMseSink picks the main-thread sink, and createMediaSource constructs it.
  g.ManagedMediaSource = function () {
    return ms;
  };
  g.MediaSource = function () {
    return ms;
  };
  try {
    return await fn(createMseSink());
  } finally {
    g.MediaSource = origMS;
    g.ManagedMediaSource = origMMS;
  }
}

test("attach rejects a PLAIN (non-abort) Error when the MediaSource never opens", async () => {
  const { ms } = neverOpens();
  await withMainThreadSink(ms, async (sink) => {
    const err = await sink.attach(fakeVideo() as unknown as HTMLVideoElement, new AbortController().signal, 20).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    // NOT an AbortError: play() re-throws those as caller teardown, so this is the difference between a
    // surfaced attach_failed and a silent death.
    expect(err!.name).not.toBe("AbortError");
    expect(err!.message).toContain("20ms");
  });
});

test("attach resolves when sourceopen arrives before the deadline, and unwires its listeners", async () => {
  const { ms, listeners } = neverOpens();
  await withMainThreadSink(ms, async (sink) => {
    const p = sink.attach(fakeVideo() as unknown as HTMLVideoElement, new AbortController().signal, 5_000);
    ms.fire("sourceopen");
    await p; // resolves
    // The timer and the listener are both dropped on success — otherwise the deadline would still be armed,
    // and a 5s timer would keep firing at a MediaSource that is long since playing.
    expect(listeners()).toBe(0);
  });
});

test("attach rejects an AbortError — distinguishable from a timeout — when the caller aborts mid-wait", async () => {
  const { ms } = neverOpens();
  await withMainThreadSink(ms, async (sink) => {
    const ac = new AbortController();
    const p = sink.attach(fakeVideo() as unknown as HTMLVideoElement, ac.signal, 5_000);
    ac.abort();
    const err = await p.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.name).toBe("AbortError");
  });
});

test("attach takes the fast path when the MediaSource is already open (no event to wait for)", async () => {
  const { ms } = neverOpens();
  ms.readyState = "open";
  await withMainThreadSink(ms, async (sink) => {
    await sink.attach(fakeVideo() as unknown as HTMLVideoElement, new AbortController().signal, 0); // 0ms budget
    expect(sink.attachMethod).toBe("srcObject");
  });
});

// ---- play()-level mapping ------------------------------------------------------------------------------

/** A video element that rejects the MediaSource handle — a fast stand-in for any attach that cannot succeed. */
function rejectingVideo(errName?: string) {
  const v = fakeVideo();
  Object.defineProperty(v, "srcObject", {
    get: () => null,
    set: () => {
      const e = new Error("the element refused the MediaSource handle");
      if (errName) e.name = errName;
      throw e;
    },
    configurable: true,
  });
  return v;
}

test("play() maps a non-abort attach failure to attach_failed, reporting the REAL reason", async () => {
  await withFakeMse(async () => {
    const h = harness();
    const errors: Array<{ code: string; message: string }> = [];
    const video = rejectingVideo();
    await expect(
      h.player.play(video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent", onError: (e) => errors.push(e) }),
    ).rejects.toThrow();

    const attach = errors.find((e) => e.code === "attach_failed");
    expect(attach).toBeDefined();
    // The underlying cause is in the top-line message, where an operator will actually see it: `cause` is
    // dropped by the beacon and by most host onError handlers.
    expect(attach!.message).toContain("the element refused the MediaSource handle");
    expect(attach!.message).toContain("attach via");
    // ...and NOT a fixed root-cause narrative that is wrong for most attach paths.
    expect(attach!.message).not.toContain("Chrome");
    expect(attach!.message).not.toContain("issue #4");
  });
});

test("play() re-throws an aborted attach untouched — never as attach_failed", async () => {
  await withFakeMse(async () => {
    const h = harness();
    const errors: Array<{ code: string }> = [];
    const video = rejectingVideo("AbortError");
    const err = await h.player
      .play(video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent", onError: (e) => errors.push(e) })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err!.name).toBe("AbortError");
    expect(errors.map((e) => e.code)).not.toContain("attach_failed");
  });
});

test("the attach diagnostic names the attach path that was actually used", async () => {
  // The message interpolates `attachMethod`, so it has to be meaningful on every sink — including before an
  // attach has decided which path it takes.
  await withFakeMse(async () => {
    const sink = createMseSink();
    expect(sink.attachMethod).toBe("unknown");
    await sink.attach(fakeVideo() as unknown as HTMLVideoElement, new AbortController().signal, 1_000);
    expect(sink.attachMethod).toBe("srcObject"); // FakeMediaSource exposes a handle
  });
});

test("FakeMediaSource sanity: the harness really exercises the main-thread sink", () => {
  expect((FakeMediaSource as unknown as { canConstructInDedicatedWorker?: boolean }).canConstructInDedicatedWorker).toBeUndefined();
});
