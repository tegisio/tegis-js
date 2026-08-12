// Which MSE sink a browser gets, and what happens when the worker one can't start.
//
// The worker sink was originally selected on `typeof Worker !== "undefined"` alone. That is not the question:
// Firefox has Workers and has never shipped MSE-in-Workers, so the worker body's top-level `new MediaSource()`
// throws ReferenceError and EVERY attach fails — turning a browser whose main-thread attach works today into a
// player that cannot start at all. Selection is now gated on `MediaSource.canConstructInDedicatedWorker`, and
// any worker attach failure falls back to the main thread instead of surfacing attach_failed.
//
// Also pinned here: the worker and its script blob URL are actually released. A dedicated worker is never
// garbage collected — only `terminate()` stops it — and an object URL lives for the document's lifetime unless
// revoked, so a scroll feed that mounts and unmounts players would accumulate both.

import { test, expect, afterEach } from "bun:test";
import { createMseSink, workerMseSupported } from "../src/mse.ts";
import { fakeVideo, FakeMediaSource, harness } from "./play-harness.ts";

// ---- a dedicated Worker stand-in that speaks the sink's RPC protocol -----------------------------------

type Behavior = "ok" | "construct-throws" | "boot-error" | "silent";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static behavior: Behavior = "ok";
  static codecSupported = true;
  terminated = false;
  appends: unknown[] = [];
  eos = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(public url: string) {
    if (FakeWorker.behavior === "construct-throws") {
      throw new Error("Refused to create a worker from 'blob:...' (Content Security Policy)");
    }
    FakeWorker.instances.push(this);
    // A real worker delivers its boot messages asynchronously, once the page's port starts.
    queueMicrotask(() => {
      if (FakeWorker.behavior === "boot-error") {
        // What Firefox would do: `new MediaSource()` inside the worker throws ReferenceError.
        this.onerror?.({ message: "ReferenceError: MediaSource is not defined" });
        return;
      }
      if (FakeWorker.behavior === "silent") return; // starts, never opens → the attach bound has to fire
      this.onmessage?.({ data: { ev: "handle", handle: { __workerHandle: true } } });
      this.onmessage?.({ data: { ev: "open" } });
    });
  }

  postMessage(m: Record<string, any>): void {
    queueMicrotask(() => {
      if (m.cmd === "duration") {
        const adopted = typeof m.sec === "number" && isFinite(m.sec) && m.sec > 0 ? m.sec : 0;
        this.onmessage?.({ data: { ev: "reply", id: m.id, ok: true, adopted } });
      } else if (m.cmd === "addsb") {
        this.onmessage?.({ data: { ev: "reply", id: m.id, ok: true, supported: FakeWorker.codecSupported } });
      } else if (m.cmd === "append") {
        this.appends.push(m.buf);
        this.onmessage?.({ data: { ev: "reply", id: m.id, ok: true } });
      } else if (m.cmd === "eos") {
        this.eos = true;
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

interface Env {
  restore: () => void;
  created: string[];
  revoked: string[];
}

/** Install the fake Worker, the fake MediaSource (with or without the worker-MSE probe), and object-URL spies. */
function env(opts: { workerMse: boolean; behavior?: Behavior; managed?: boolean } = { workerMse: true }): Env {
  const g = globalThis as Record<string, any>;
  const saved = {
    Worker: g.Worker,
    MediaSource: g.MediaSource,
    ManagedMediaSource: g.ManagedMediaSource,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;

  class ProbedMediaSource extends FakeMediaSource {}
  if (opts.workerMse) (ProbedMediaSource as unknown as { canConstructInDedicatedWorker: boolean }).canConstructInDedicatedWorker = true;

  FakeWorker.instances = [];
  FakeWorker.behavior = opts.behavior ?? "ok";
  FakeWorker.codecSupported = true;
  g.Worker = FakeWorker;
  g.MediaSource = ProbedMediaSource;
  g.ManagedMediaSource = opts.managed ? ProbedMediaSource : undefined;
  (URL as any).createObjectURL = () => {
    const u = `blob:fake-${++n}`;
    created.push(u);
    return u;
  };
  (URL as any).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };

  return {
    created,
    revoked,
    restore: () => {
      g.Worker = saved.Worker;
      g.MediaSource = saved.MediaSource;
      g.ManagedMediaSource = saved.ManagedMediaSource;
      (URL as any).createObjectURL = saved.create;
      (URL as any).revokeObjectURL = saved.revoke;
      FakeWorker.behavior = "ok";
      FakeWorker.codecSupported = true;
    },
  };
}

let active: Env | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

const signal = () => new AbortController().signal;

// ---- selection -----------------------------------------------------------------------------------------

test("workerMseSupported follows the standard probe, not the presence of Worker", () => {
  active = env({ workerMse: false });
  expect(workerMseSupported()).toBe(false); // Workers exist here — the probe still says no
  active.restore();
  active = env({ workerMse: true });
  expect(workerMseSupported()).toBe(true);
});

test("a browser without worker MSE keeps the main-thread sink (the Firefox regression)", async () => {
  active = env({ workerMse: false });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000);
  expect(sink.attachMethod).toBe("srcObject"); // main-thread handle attach, exactly as before this PR
  expect(FakeWorker.instances).toHaveLength(0); // and no worker was ever spawned
});

test("Safari's ManagedMediaSource keeps the main-thread sink even when worker MSE is available", async () => {
  active = env({ workerMse: true, managed: true });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000);
  expect(FakeWorker.instances).toHaveLength(0);
});

test("a browser with worker MSE gets the worker sink", async () => {
  active = env({ workerMse: true });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000);
  expect(sink.attachMethod).toBe("worker-handle");
  expect(FakeWorker.instances).toHaveLength(1);
});

// ---- fallback ------------------------------------------------------------------------------------------

test("a worker that fails to boot falls back to the main thread instead of failing playback", async () => {
  active = env({ workerMse: true, behavior: "boot-error" });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000); // resolves — no attach_failed
  expect(sink.attachMethod).toBe("srcObject");
  expect(FakeWorker.instances[0]!.terminated).toBe(true); // the dead worker is not left running
});

test("a Worker constructor the host forbids (CSP) falls back and leaks no object URL", async () => {
  active = env({ workerMse: true, behavior: "construct-throws" });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000);
  expect(sink.attachMethod).toBe("srcObject");
  expect(active.revoked).toEqual(active.created);
});

test("an aborted worker attach is NOT retried on the main thread", async () => {
  active = env({ workerMse: true, behavior: "silent" });
  const sink = createMseSink();
  const ac = new AbortController();
  const p = sink.attach(fakeVideo() as unknown as HTMLVideoElement, ac.signal, 5_000);
  ac.abort();
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err!.name).toBe("AbortError"); // caller teardown, not a browser problem
});

// ---- resource release ----------------------------------------------------------------------------------

test("the worker's script blob URL is revoked once the attach settles", async () => {
  active = env({ workerMse: true });
  const sink = createMseSink();
  await sink.attach(fakeVideo() as unknown as HTMLVideoElement, signal(), 1_000);
  expect(active.created).toHaveLength(1);
  expect(active.revoked).toEqual(active.created); // not left for the document's lifetime
  sink.close();
  expect(active.revoked).toHaveLength(1); // and revoking is idempotent
});

test("a play() that fails AFTER the sink exists still terminates the worker", async () => {
  // The leak this closes: sink.close() lives only in teardown, and teardown used to run for aborts only. Every
  // other failure — codec_unsupported here — re-threw with a live worker still holding an open MediaSource, and
  // the caller had no handle.stop() to clean up with because play() threw instead of returning one.
  active = env({ workerMse: true });
  FakeWorker.codecSupported = false; // the browser can't decode the content codec
  const h = harness();
  const errors: Array<{ code: string }> = [];
  await expect(
    h.player.play(h.video as unknown as HTMLVideoElement, { assetId: "ast_1", entitlement: "ent", onError: (e) => errors.push(e) }),
  ).rejects.toThrow();

  expect(errors.map((e) => e.code)).toContain("codec_unsupported");
  expect(FakeWorker.instances).toHaveLength(1);
  expect(FakeWorker.instances[0]!.terminated).toBe(true);
  expect(active.revoked).toEqual(active.created);
});
