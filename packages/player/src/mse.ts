// @tegis/player — the MSE "sink": the MediaSource/SourceBuffer half of play(), factored behind an interface so
// the browser-specific attach paths live in ONE place. Two implementations: a MediaSource constructed INSIDE a
// dedicated Worker, whose transferable `MediaSourceHandle` is attached on the page via `video.srcObject`
// (investigated for issue #4), and the main-thread MediaSource/ManagedMediaSource that predates it. The
// main-thread attach is NOT broken — issue #4's Chrome hang turned out to be an automation-browser artifact, a
// real foreground Chrome opens both — so the worker path is an alternative, never a prerequisite: it is gated
// on `MediaSource.canConstructInDedicatedWorker` and falls back to the main thread on any attach failure.
// `createMseSink()` picks; the rest of play() is sink-agnostic. This module owns nothing of the mint/decrypt/
// pacing logic.

// ---- cross-env helpers (mirrored from player.ts so this module imports nothing from the orchestrator it
//      backs — keeps the dependency one-directional: player.ts → mse.ts) ---------------------------------

/** An AbortError, cross-env (DOMException where present, else a tagged Error). */
function abortError(): Error {
  try {
    return new DOMException("aborted", "AbortError");
  } catch {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  }
}

/** Whether a rejection is a caller abort rather than a real failure — the one case a fallback must NOT retry. */
function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// Newer/non-standard MSE surface not always in the TS DOM lib: ManagedMediaSource (iOS Safari; plain
// MediaSource is unsupported there) and the MediaSourceHandle exposed as `MediaSource.prototype.handle`,
// attached via `video.srcObject`. Declared loosely so the player builds against any lib.dom version.
type MediaSourceLike = MediaSource & { handle?: unknown };

/** Create the playback MediaSource, preferring ManagedMediaSource where present (required on iOS Safari,
 *  where plain MediaSource is unavailable) and falling back to the standard MediaSource. Same API surface
 *  either way (addSourceBuffer / endOfStream), so the rest of play() is unchanged. */
export function createMediaSource(): MediaSource {
  const MMS = (globalThis as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const Ctor = MMS ?? MediaSource;
  return new Ctor();
}

/** Attach a MediaSource to a video element, preferring the modern MediaSourceHandle + `srcObject` — the path
 *  that survives Chrome's removal of `URL.createObjectURL(MediaSource)` and is REQUIRED for ManagedMediaSource
 *  (iOS) — and falling back to the object URL only where a handle isn't available. Returns the method used.
 *  NOTE: a MAIN-THREAD MediaSource has no `.handle`, so outside Safari this takes the objectURL branch. */
export function attachMediaSource(video: HTMLVideoElement, ms: MediaSource): "srcObject" | "objectURL" {
  const handle = (ms as MediaSourceLike).handle;
  if (handle != null && "srcObject" in video) {
    // srcObject/disableRemotePlayback typed loosely (via unknown) so the assignment builds against any
    // lib.dom version. ManagedMediaSource requires remote playback disabled; a no-op for a plain handle.
    const v = video as unknown as { srcObject: unknown; disableRemotePlayback?: boolean };
    v.disableRemotePlayback = true;
    v.srcObject = handle;
    return "srcObject";
  }
  video.src = URL.createObjectURL(ms);
  return "objectURL";
}

/**
 * Declare the asset's length on the MediaSource and return the value adopted (0 when none was).
 *
 * This is what turns an unusable transport into something a player UI can render: MSE defaults `duration` to
 * NaN and then tracks the highest buffered timestamp, so an undeclared stream reports a total that grows as it
 * plays. Declaring it up front gives a stable scrubber range, a meaningful buffered bar, and a correct
 * denominator for progress.
 *
 * Fully guarded. An absent/garbage duration is skipped rather than guessed — a wrong total is worse than
 * none — and a throwing assignment (MSE rejects it unless `readyState === "open"` with no updating
 * SourceBuffer) is swallowed, because a cosmetic timeline must never break playback.
 */
export function setMediaSourceDuration(ms: MediaSource, durationSec: number | undefined): number {
  if (typeof durationSec !== "number" || !isFinite(durationSec) || durationSec <= 0) return 0;
  try {
    ms.duration = durationSec;
    return durationSec;
  } catch {
    return 0; // wrong readyState / updating SourceBuffer — playback is unaffected, only the timeline is
  }
}

/** `MediaSource.isTypeSupported` via the CONSTRUCTOR actually in use (ManagedMediaSource on iOS has its own).
 *  Returns true when the platform exposes no `isTypeSupported` — never block playback on a missing probe. */
function msTypeSupported(ms: MediaSource, mime: string): boolean {
  const ctor = (ms as unknown as { constructor?: { isTypeSupported?: (t: string) => boolean } }).constructor;
  const fn = ctor?.isTypeSupported;
  return typeof fn === "function" ? fn.call(ctor, mime) : true;
}

/** Await a MediaSource reaching `open` (`sourceopen`), rejecting with a plain Error after `timeoutMs` and an
 *  AbortError on `signal`. This is the bound that turns a MediaSource that never opens — for whatever reason —
 *  into a surfaced `attach_failed` instead of a play() that hangs forever. The rejection is deliberately a
 *  PLAIN Error, never an AbortError: play() rethrows aborts untouched as caller teardown, so a timeout that
 *  arrived tagged as an abort would kill playback with no error surfaced at all. The Worker path bounds its own
 *  open inside {@link WorkerMseSink.attach}; this backs the main-thread sink. */
function waitForOpen(ms: MediaSource, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(abortError());
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      ms.removeEventListener("sourceopen", onOpen);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      res();
    };
    const onAbort = () => {
      cleanup();
      rej(abortError());
    };
    ms.addEventListener("sourceopen", onOpen, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      rej(new Error(`MediaSource "sourceopen" did not fire within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ---- the sink abstraction ------------------------------------------------------------------------------

/**
 * The MediaSource/SourceBuffer half of playback, behind a browser-agnostic seam. play() creates one via
 * {@link createMseSink} and drives it: `attach` → `setDuration` → `addSourceBuffer` → serialized `append`s →
 * `endOfStream` → `close`. Two implementations back it: {@link WorkerMseSink} (Chrome/Edge/Firefox, the only
 * attach that opens there) and {@link MainThreadMseSink} (Safari + any Worker-less environment).
 */
export interface MseSink {
  /** The attach path actually used ("srcObject" | "objectURL" | "worker-handle") — for the attach_failed diagnostic. */
  attachMethod: string;
  /** Create the MediaSource, attach it to `video`, and resolve when it reaches "open". Rejects a plain (non-abort)
   *  Error if not open within `timeoutMs`; rejects an AbortError on `signal`. */
  attach(video: HTMLVideoElement, signal: AbortSignal, timeoutMs: number): Promise<void>;
  /** Apply the {@link setMediaSourceDuration} guard (skip NaN/absent/≤0; only set when open) and return the
   *  adopted seconds (0 if none). */
  setDuration(sec: number | undefined): Promise<number>;
  /** false when `!MediaSource.isTypeSupported(mime)` (checked wherever the MediaSource lives); else add the
   *  SourceBuffer, set `mode="segments"` (swallowing the mode throw), and return true. */
  addSourceBuffer(mime: string): Promise<boolean>;
  /** Append one segment: resolves on `updateend`, rejects on the SourceBuffer `error` event or a synchronous
   *  throw, rejects an AbortError on abort. Serialized by the caller awaiting each append. */
  append(buf: Uint8Array): Promise<void>;
  /** Best-effort `ms.endOfStream()`, guarded by `readyState === "open"`; never throws. */
  endOfStream(): void;
  /** Terminate the worker / drop refs. Idempotent. */
  close(): void;
}

/**
 * Main-thread sink: `new (ManagedMediaSource ?? MediaSource)()`, attached via the handle+srcObject path where a
 * handle exists (ManagedMediaSource/Safari) else the object URL. This is the Safari/fallback path — it is the
 * behavior play() had before the Worker sink, unchanged, backed by the helpers above.
 */
class MainThreadMseSink implements MseSink {
  // Named before the attach runs, so the attach_failed diagnostic reports something even when the failure is
  // the attach itself (an element that rejects the handle, a createObjectURL that throws).
  attachMethod = "unknown";
  private ms?: MediaSource;
  private sb?: SourceBuffer;
  private mime = "";
  private signal?: AbortSignal;

  async attach(video: HTMLVideoElement, signal: AbortSignal, timeoutMs: number): Promise<void> {
    this.signal = signal;
    const ms = createMediaSource();
    this.ms = ms;
    this.attachMethod = attachMediaSource(video, ms);
    if (ms.readyState === "open") return; // already open (rare) — no event to wait for
    await waitForOpen(ms, signal, timeoutMs);
  }

  async setDuration(sec: number | undefined): Promise<number> {
    return this.ms ? setMediaSourceDuration(this.ms, sec) : 0;
  }

  async addSourceBuffer(mime: string): Promise<boolean> {
    const ms = this.ms;
    if (!ms || !msTypeSupported(ms, mime)) return false;
    const sb = ms.addSourceBuffer(mime);
    this.sb = sb;
    this.mime = mime;
    try {
      sb.mode = "segments"; // CMAF bare fragments: chained baseMediaDecodeTime timing; overlap = last-write-wins
    } catch {
      /* segments is the default anyway */
    }
    return true;
  }

  // Serialized, abortable append — resolves on updateend; rejects on the SourceBuffer error event, a
  // synchronous appendBuffer throw, or abort. Identical semantics to play()'s original `append` closure.
  append(buf: Uint8Array): Promise<void> {
    const sb = this.sb!;
    const mime = this.mime;
    const signal = this.signal!;
    return new Promise<void>((res, rej) => {
      if (signal.aborted) return rej(abortError());
      const off = () => {
        sb.removeEventListener("updateend", onEnd);
        sb.removeEventListener("error", onErr);
        signal.removeEventListener("abort", onAbort);
      };
      const onEnd = () => {
        off();
        res();
      };
      const onErr = () => {
        off();
        rej(new Error(`SourceBuffer append failed (codec "${mime}")`));
      };
      const onAbort = () => {
        off();
        rej(abortError());
      };
      sb.addEventListener("updateend", onEnd, { once: true });
      sb.addEventListener("error", onErr, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        sb.appendBuffer(buf as BufferSource);
      } catch (e) {
        off();
        rej(e); // synchronous QuotaExceeded / InvalidState → reject, never an unhandled throw
      }
    });
  }

  endOfStream(): void {
    try {
      if (this.ms && this.ms.readyState === "open") this.ms.endOfStream();
    } catch {
      /* already ended/closed */
    }
  }

  close(): void {
    this.ms = undefined;
    this.sb = undefined;
  }
}

// ---- Worker sink (Chrome/Edge/Firefox) -----------------------------------------------------------------

/** Shape of the messages the worker posts back. `ev:"handle"` carries the transferred MediaSourceHandle,
 *  `ev:"open"` signals the in-worker MediaSource reached "open", `ev:"reply"` correlates an RPC by `id`. */
interface WorkerMsg {
  ev?: "handle" | "open" | "reply";
  id?: number;
  ok?: boolean;
  handle?: unknown;
  error?: string;
  adopted?: unknown;
  supported?: unknown;
}

// The worker body, as a self-contained source string (NO imports — it runs in a bare dedicated worker). A
// string constant is bundled inline and survives downstream bundlers (priv.fan is Vite) with no extra build
// entry or codegen step. It owns `ms`/`sb`, transfers `ms.handle` to the page, mirrors `sourceopen` → "open",
// and answers duration/addsb/append/eos. priv.fan's CSP already allows `worker-src 'self' blob:`.
const MSE_WORKER_SRC = `
"use strict";
// The MediaSource is constructed HERE (off the main thread); the page attaches the transferable handle via
// video.srcObject. Only reached when MediaSource.canConstructInDedicatedWorker is true. Protocol mirrors mse.ts:
//   main -> worker: { cmd:"duration"|"addsb"|"append"|"eos", id, ... }
//   worker -> main: { ev:"handle", handle } (transferred), { ev:"open" }, { ev:"reply", id, ok, ... }
var ms = new MediaSource();
var sb = null;
var mime = "";
ms.addEventListener("sourceopen", function () { postMessage({ ev: "open" }); });
// The handle is transfer-only (structured clone would throw) and can be transferred exactly once.
var handle = ms.handle;
postMessage({ ev: "handle", handle: handle }, [handle]);
function reply(id, ok, extra) {
  var m = { ev: "reply", id: id, ok: ok };
  if (extra) { for (var k in extra) m[k] = extra[k]; }
  postMessage(m);
}
function adoptDuration(sec) {
  // Same guard as setMediaSourceDuration: skip NaN/absent/<=0; only set when open (the throw is swallowed).
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return 0;
  try { ms.duration = sec; return sec; } catch (e) { return 0; }
}
onmessage = function (e) {
  var d = e.data || {};
  switch (d.cmd) {
    case "duration":
      reply(d.id, true, { adopted: adoptDuration(d.sec) });
      break;
    case "addsb":
      try {
        if (!MediaSource.isTypeSupported(d.mime)) { reply(d.id, true, { supported: false }); break; }
        mime = d.mime;
        sb = ms.addSourceBuffer(d.mime);
        try { sb.mode = "segments"; } catch (_) {}
        reply(d.id, true, { supported: true });
      } catch (err) {
        reply(d.id, false, { error: String((err && err.message) || err) });
      }
      break;
    case "append": {
      var cleanup = function () { sb.removeEventListener("updateend", onEnd); sb.removeEventListener("error", onErr); };
      var onEnd = function () { cleanup(); reply(d.id, true); };
      var onErr = function () { cleanup(); reply(d.id, false, { error: 'SourceBuffer append failed (codec "' + mime + '")' }); };
      sb.addEventListener("updateend", onEnd, { once: true });
      sb.addEventListener("error", onErr, { once: true });
      try { sb.appendBuffer(d.buf); } catch (err) { cleanup(); reply(d.id, false, { error: String((err && err.message) || err) }); }
      break;
    }
    case "eos":
      try { if (ms.readyState === "open") ms.endOfStream(); } catch (_) {}
      break;
  }
};
`;

/**
 * Worker sink: spins up a dedicated Worker, constructs the MediaSource inside it, transfers the
 * MediaSourceHandle to the page for `video.srcObject`, and proxies every SourceBuffer touch over a tiny
 * id-correlated RPC. Selected only where {@link workerMseSupported} holds, and wrapped by
 * {@link WorkerFirstMseSink} so an attach failure degrades to the main thread. Segment bytes are
 * structured-cloned (not transferred) — correctness over a negligible per-segment copy.
 */
class WorkerMseSink implements MseSink {
  attachMethod = "worker-handle";
  private worker?: Worker;
  private signal?: AbortSignal;
  private nextId = 1;
  private pending = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: unknown) => void }>();
  private onOpen?: () => void;
  /** The worker script's object URL, held only until it can be revoked. An object URL lives for the document's
   *  lifetime unless revoked, so a player that mounts and unmounts through a scroll feed would otherwise strand
   *  one blob per playback. Revoked as soon as attach settles (the worker has its source by then) and again in
   *  close(), so no path — success, failure, or abort — leaves one behind. */
  private blobUrl?: string;

  private revokeBlob(): void {
    const u = this.blobUrl;
    this.blobUrl = undefined;
    if (u === undefined) return;
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* best-effort */
    }
  }

  async attach(video: HTMLVideoElement, signal: AbortSignal, timeoutMs: number): Promise<void> {
    this.signal = signal;
    if (signal.aborted) throw abortError();
    const src = URL.createObjectURL(new Blob([MSE_WORKER_SRC], { type: "text/javascript" }));
    this.blobUrl = src;
    let worker: Worker;
    try {
      worker = new Worker(src);
    } catch (e) {
      this.revokeBlob(); // e.g. a host CSP that forbids blob: workers — don't leak the URL on the way out
      throw e;
    }
    this.worker = worker;

    // One handler for the worker's lifetime: attach the handle, resolve attach on "open", route RPC replies.
    // Messages the worker posts before this assignment are queued and delivered once the port starts, so the
    // "handle"/"open" posted on worker load are never lost.
    worker.onmessage = (e: MessageEvent) => {
      const d = (e.data ?? {}) as WorkerMsg;
      if (d.ev === "handle") {
        // Attach the transferred MediaSourceHandle on the main thread — the ONE attach that opens on
        // Chrome/Edge/Firefox. `disableRemotePlayback` mirrors the main-thread handle path.
        const v = video as unknown as { srcObject: unknown; disableRemotePlayback?: boolean };
        try {
          v.disableRemotePlayback = true;
        } catch {
          /* not present on this element */
        }
        v.srcObject = d.handle;
      } else if (d.ev === "open") {
        this.onOpen?.();
      } else if (d.ev === "reply" && typeof d.id === "number") {
        const p = this.pending.get(d.id);
        if (p) {
          this.pending.delete(d.id);
          if (d.ok) p.res(d as Record<string, unknown>);
          else p.rej(new Error(typeof d.error === "string" ? d.error : "worker MSE RPC failed"));
        }
      }
    };

    // Resolve on "open"; reject a plain Error on timeout (→ attach_failed) or an AbortError on abort. The
    // timeout also covers a worker that never posts "open" (e.g. handle attach silently failed).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.onOpen = undefined;
        worker.onerror = null;
        this.revokeBlob(); // the worker has its source; the URL is dead weight from here on
        fn();
      };
      const onAbort = () => finish(() => reject(abortError()));
      const timer = setTimeout(
        () => finish(() => reject(new Error(`worker MediaSource never opened within ${timeoutMs}ms`))),
        timeoutMs,
      );
      this.onOpen = () => finish(resolve);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.onerror = (ev) => finish(() => reject(new Error(`MSE worker error: ${(ev as ErrorEvent)?.message ?? "unknown"}`)));
    });
  }

  // A single RPC round trip, correlated by a monotonic id. Rejects an AbortError if `signal` aborts before
  // the reply lands (the entry is dropped so a late reply is ignored).
  private rpc(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const worker = this.worker;
    const signal = this.signal;
    if (!worker) return Promise.reject(new Error("MSE worker not attached"));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const id = this.nextId++;
      const onAbort = () => {
        if (this.pending.delete(id)) reject(abortError());
      };
      const settle = (fn: () => void) => {
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      this.pending.set(id, {
        res: (v) => settle(() => resolve(v)),
        rej: (e) => settle(() => reject(e)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ ...msg, id });
    });
  }

  async setDuration(sec: number | undefined): Promise<number> {
    const r = await this.rpc({ cmd: "duration", sec });
    return typeof r.adopted === "number" ? r.adopted : 0;
  }

  async addSourceBuffer(mime: string): Promise<boolean> {
    const r = await this.rpc({ cmd: "addsb", mime });
    return r.supported === true;
  }

  async append(buf: Uint8Array): Promise<void> {
    // Structured-clone the bytes (no transfer): correctness over a per-segment copy of a few hundred KB, and
    // the caller's buffer stays valid. Serialized because the caller awaits each append.
    await this.rpc({ cmd: "append", buf });
  }

  endOfStream(): void {
    // Best-effort, fire-and-forget (the worker guards readyState === "open"); never throws.
    try {
      this.worker?.postMessage({ cmd: "eos" });
    } catch {
      /* worker gone */
    }
  }

  close(): void {
    this.revokeBlob(); // backstop: a close() before attach settled still frees the URL
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = undefined;
    for (const p of this.pending.values()) {
      try {
        p.rej(abortError());
      } catch {
        /* best-effort */
      }
    }
    this.pending.clear();
  }
}

/**
 * Whether this browser can construct a MediaSource inside a dedicated Worker.
 *
 * `MediaSource.canConstructInDedicatedWorker` is the standard probe (Chrome 108+, Safari 17.1+). It matters
 * because "has Worker" is NOT the same question: Firefox has Workers but has never shipped MSE-in-Workers, so
 * the worker body's top-level `new MediaSource()` throws ReferenceError and every attach fails. Routing on the
 * presence of `Worker` alone would take a browser whose main-thread attach works today and give it a player
 * that cannot start at all — so the probe gates the worker path, and anything that fails it keeps the
 * main-thread sink.
 */
export function workerMseSupported(): boolean {
  if (typeof Worker === "undefined") return false;
  const MS = (globalThis as unknown as { MediaSource?: { canConstructInDedicatedWorker?: boolean } }).MediaSource;
  return MS?.canConstructInDedicatedWorker === true;
}

/**
 * The worker sink with a main-thread fallback. Feature detection covers the browsers we know can't host a
 * MediaSource in a worker; this covers the ones that claim they can and then don't — a host CSP that forbids
 * `blob:` workers, a worker that starts but never posts `open`, an element that rejects the handle. The
 * main-thread path is what shipped before the worker sink and still works everywhere except the attach quirk
 * the worker sink exists for, so a failed worker attach must degrade to it rather than end playback.
 *
 * Delegates everything else — the fallback is only a decision about which sink ends up behind the seam.
 */
class WorkerFirstMseSink implements MseSink {
  attachMethod = "worker-handle";
  private inner: MseSink = new WorkerMseSink();

  async attach(video: HTMLVideoElement, signal: AbortSignal, timeoutMs: number): Promise<void> {
    try {
      await this.inner.attach(video, signal, timeoutMs);
    } catch (e) {
      if (isAbort(e)) throw e; // a caller teardown is not a browser problem — never retry it
      try {
        this.inner.close(); // terminate the half-started worker before replacing it
      } catch {
        /* best-effort */
      }
      try {
        (video as unknown as { srcObject: unknown }).srcObject = null; // drop a half-attached handle
      } catch {
        /* not srcObject */
      }
      this.inner = new MainThreadMseSink();
      await this.inner.attach(video, signal, timeoutMs);
    }
    this.attachMethod = this.inner.attachMethod;
  }

  setDuration(sec: number | undefined): Promise<number> {
    return this.inner.setDuration(sec);
  }
  addSourceBuffer(mime: string): Promise<boolean> {
    return this.inner.addSourceBuffer(mime);
  }
  append(buf: Uint8Array): Promise<void> {
    return this.inner.append(buf);
  }
  endOfStream(): void {
    this.inner.endOfStream();
  }
  close(): void {
    this.inner.close();
  }
}

/**
 * Pick the sink for the current browser. The worker sink (with its main-thread fallback) for browsers that can
 * construct a MediaSource in a Worker and have no `ManagedMediaSource`; MainThreadMseSink where
 * `ManagedMediaSource` exists (Safari — the main-thread path works AND gives battery-managed buffering), where
 * `Worker` is unavailable, or where MSE-in-Workers isn't supported (Firefox today).
 */
export function createMseSink(): MseSink {
  const hasManagedMediaSource =
    typeof (globalThis as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource !== "undefined";
  if (!hasManagedMediaSource && workerMseSupported()) return new WorkerFirstMseSink();
  return new MainThreadMseSink();
}
