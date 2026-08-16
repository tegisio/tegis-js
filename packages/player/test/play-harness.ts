// A headless stand-in for the browser half of `play()` — a fake <video>, a fake MediaSource/SourceBuffer, and a
// scripted mint/edge — so the parts of playback that only exist INSIDE `play()`'s closure (seek handling, the
// heartbeat seq counter, the shared append chain) can be driven end-to-end without a browser.
//
// Not a `.test.ts` file on purpose: `bun test` collects only `*.test.ts`, so this is shared setup, not a suite.

import { TegisPlayer, type Grant, type ShakaLike } from "../src/player.ts";
import { b64u } from "../src/crypto.ts";

// ---- fake <video> --------------------------------------------------------------------------------------

export interface FakeVideo {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  readyState: number;
  error: unknown;
  srcObject: unknown;
  src: string;
  buffered: { length: number; start(i: number): number; end(i: number): number };
  addEventListener(name: string, fn: (e?: unknown) => void, o?: { once?: boolean }): void;
  removeEventListener(name: string, fn: (e?: unknown) => void): void;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  load(): void;
  pause(): void;
  play(): Promise<void>;
  // test controls
  ranges: Array<[number, number]>;
  writes: number[];
  emit(name: string): void;
  /** Move the playhead the way a host/browser does: set currentTime, then fire `seeking`. */
  seekTo(t: number): void;
  /** Report playback progress at the current position (what keeps the "last stable position" fresh). */
  progress(t: number): void;
}

export function fakeVideo(init: { currentTime?: number; ranges?: Array<[number, number]> } = {}): FakeVideo {
  const listeners = new Map<string, Array<{ fn: (e?: unknown) => void; once: boolean }>>();
  let t = init.currentTime ?? 0;
  const v: FakeVideo = {
    // Setting currentTime fires `seeking`, exactly as a real element does — that is what makes an accidental
    // restore→seek→restore loop observable instead of theoretical.
    get currentTime() {
      return t;
    },
    set currentTime(next: number) {
      t = next;
      v.writes.push(next);
      v.seeking = true;
      v.emit("seeking");
    },
    paused: false,
    ended: false,
    seeking: false,
    muted: false,
    loop: false,
    playsInline: false,
    readyState: 4,
    error: null,
    srcObject: null,
    src: "",
    ranges: init.ranges ?? [],
    writes: [],
    get buffered() {
      return {
        length: v.ranges.length,
        start: (i: number) => v.ranges[i][0],
        end: (i: number) => v.ranges[i][1],
      };
    },
    addEventListener(name, fn, o) {
      const arr = listeners.get(name) ?? [];
      arr.push({ fn, once: o?.once === true });
      listeners.set(name, arr);
    },
    removeEventListener(name, fn) {
      const arr = listeners.get(name);
      if (!arr) return;
      const i = arr.findIndex((l) => l.fn === fn);
      if (i >= 0) arr.splice(i, 1);
    },
    setAttribute() {},
    removeAttribute() {},
    load() {},
    pause() {
      v.paused = true;
    },
    async play() {
      v.paused = false;
    },
    emit(name) {
      const arr = [...(listeners.get(name) ?? [])];
      for (const l of arr) {
        if (l.once) v.removeEventListener(name, l.fn);
        l.fn({ type: name });
      }
    },
    seekTo(next) {
      v.currentTime = next; // the setter fires `seeking`
    },
    progress(next) {
      v.seeking = false;
      t = next;
      v.emit("timeupdate");
    },
  } as FakeVideo;
  return v;
}

// ---- fake MediaSource / SourceBuffer -------------------------------------------------------------------

/** A SourceBuffer that behaves like the real one where it matters: `appendBuffer` while `updating` throws
 *  InvalidStateError. `release()` completes the pending append (fires `updateend`), so a test decides exactly
 *  when an append is in flight. */
export class FakeSourceBuffer {
  mode = "";
  updating = false;
  /** Every buffer that reached `appendBuffer`, in order. */
  appended: Uint8Array[] = [];
  /** Appends rejected because one was already in flight — must stay empty. */
  collisions: Uint8Array[] = [];
  private listeners = new Map<string, Array<(e?: unknown) => void>>();
  private pending: Array<() => void> = [];
  constructor(private manual = false) {}

  addEventListener(name: string, fn: (e?: unknown) => void): void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }
  removeEventListener(name: string, fn: (e?: unknown) => void): void {
    const arr = this.listeners.get(name);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  private emit(name: string): void {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn({ type: name });
  }
  appendBuffer(buf: Uint8Array): void {
    if (this.updating) {
      this.collisions.push(buf);
      const e = new Error("Failed to execute 'appendBuffer': still updating");
      e.name = "InvalidStateError";
      throw e;
    }
    this.updating = true;
    this.appended.push(buf);
    const done = () => {
      this.updating = false;
      this.emit("updateend");
    };
    if (this.manual) this.pending.push(done);
    else queueMicrotask(done);
  }
  /** Complete the oldest in-flight append. Returns false when none is pending. */
  release(): boolean {
    const next = this.pending.shift();
    if (!next) return false;
    next();
    return true;
  }
}

export class FakeMediaSource {
  static isTypeSupported(): boolean {
    return true;
  }
  static lastSourceBuffer?: FakeSourceBuffer;
  /** When true, every SourceBuffer this MediaSource hands out completes appends only on `release()`. */
  static manualAppends = false;
  readyState = "open";
  duration = Number.NaN;
  handle = { __fakeHandle: true };
  endedCount = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  addSourceBuffer(): FakeSourceBuffer {
    const sb = new FakeSourceBuffer(FakeMediaSource.manualAppends);
    FakeMediaSource.lastSourceBuffer = sb;
    return sb;
  }
  endOfStream(): void {
    this.endedCount++;
  }
}

/** Install the fake MediaSource as the global one for the duration of `fn`. */
export async function withFakeMse<T>(fn: () => Promise<T>, opts: { manualAppends?: boolean } = {}): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const origMS = g.MediaSource;
  const origMMS = g.ManagedMediaSource;
  g.MediaSource = FakeMediaSource;
  g.ManagedMediaSource = undefined;
  FakeMediaSource.manualAppends = opts.manualAppends === true;
  FakeMediaSource.lastSourceBuffer = undefined;
  try {
    return await fn();
  } finally {
    g.MediaSource = origMS;
    g.ManagedMediaSource = origMMS;
    FakeMediaSource.manualAppends = false;
  }
}

// ---- scripted mint + edge ------------------------------------------------------------------------------

export const CONTENT_KEY = new Uint8Array(16).fill(7);
export const HB_KEY_B64U = b64u(new Uint8Array(32).fill(9));

/** IV(16) ‖ AES-128-CTR(key, [marker]) — the exact segment shape `decryptSegment` expects, so a test can tell
 *  which segment was appended by reading byte 0 of the plaintext. */
export async function encryptedSegment(marker: number): Promise<Uint8Array> {
  const iv = new Uint8Array(16);
  const key = await crypto.subtle.importKey("raw", CONTENT_KEY as BufferSource, { name: "AES-CTR" }, false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv as BufferSource, length: 128 }, key, new Uint8Array([marker]) as BufferSource),
  );
  const out = new Uint8Array(16 + ct.length);
  out.set(iv, 0);
  out.set(ct, 16);
  return out;
}

export interface MintScript {
  grant?: Partial<Grant>;
  /** Consumed in order; the last entry repeats. Each returns the renew window, or throws for a non-200. */
  renews?: Array<{ manifest: string[]; window: { from: number; to: number } } | "reject">;
  /** Consumed in order; the last entry repeats. */
  seeks?: Array<{ manifest: string[]; window: { from: number; to: number } } | "reject">;
}

export interface Harness {
  player: TegisPlayer;
  video: FakeVideo;
  /** Heartbeats POSTed to /mint/v1/renew and /mint/v1/seek, in order. */
  renewHbs: Array<{ pos: number; seq: number }>;
  seekHbs: Array<{ pos: number; seq: number; targetPos: number }>;
  errors: Array<{ code: string; message: string }>;
  segmentFetches: string[];
  /** Client-event bodies POSTed to /evt/v1 (only populated when the harness is built with telemetry on). */
  beacons: Array<Record<string, unknown>>;
  /** The `step` of every beacon, in order — the usual assertion target. */
  steps: () => string[];
}

/** A TegisPlayer wired to a scripted mint/edge and a fake element — everything `play()` touches except the
 *  fake MediaSource, which is installed globally by {@link withFakeMse}. */
export function harness(
  script: MintScript = {},
  videoInit: { currentTime?: number; ranges?: Array<[number, number]>; telemetry?: boolean } = {},
  extra: { shaka?: ShakaLike; failVodKey?: boolean } = {},
): Harness {
  const renewHbs: Harness["renewHbs"] = [];
  const seekHbs: Harness["seekHbs"] = [];
  const errors: Harness["errors"] = [];
  const segmentFetches: string[] = [];
  const beacons: Harness["beacons"] = [];
  const grant: Grant = {
    grant: "grant_1",
    playbackId: "pbk_1",
    hbKeyB64u: HB_KEY_B64U,
    init: "/init.mp4",
    manifest: ["/s1"],
    window: { from: 0, to: 2 },
    res: "720p",
    duration: 600,
    ...script.grant,
  };
  const pick = <T>(list: T[] | undefined, i: number): T | undefined => (list && list.length ? list[Math.min(i, list.length - 1)] : undefined);
  let renewN = 0;
  let seekN = 0;

  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    if (url.endsWith("/evt/v1")) {
      beacons.push(body as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/attest/v1/verify")) return Response.json({ att: "att_1" });
    if (url.endsWith("/mint/v1/nonce")) return Response.json({ nonce: "nonce_1" });
    if (url.endsWith("/mint/v1/renew")) {
      renewHbs.push({ pos: body.heartbeat?.pos, seq: body.heartbeat?.seq });
      const r = pick(script.renews, renewN++) ?? { manifest: [], window: { from: 0, to: 0 } };
      if (r === "reject") return new Response(null, { status: 403 });
      return Response.json(r);
    }
    if (url.endsWith("/mint/v1/seek")) {
      seekHbs.push({ pos: body.heartbeat?.pos, seq: body.heartbeat?.seq, targetPos: body.targetPos });
      const r = pick(script.seeks, seekN++) ?? "reject";
      if (r === "reject") return new Response(null, { status: 403 });
      return Response.json(r);
    }
    if (url.endsWith("/mint/v1")) return Response.json(grant);
    // The VOD gated key endpoint (grant.vod.keyUrl). Distinct path from the JIT `/key/v1/` so a test can fail
    // JUST the vod key (driving play()'s fallback) while the JIT content key still resolves.
    if (url.includes("/vodkey/")) {
      if (extra.failVodKey) return new Response(null, { status: 404 });
      return Response.json({ alg: "AES-128", key: b64u(CONTENT_KEY) });
    }
    if (url.includes("/key/v1/")) return Response.json({ key: b64u(CONTENT_KEY) });
    if (url.endsWith("/init.mp4")) return new Response(new Uint8Array(32), { status: 200 }); // unparseable → DEFAULT_MIME
    segmentFetches.push(url);
    return new Response(await encryptedSegment(1), { status: 200 });
  }) as unknown as typeof fetch;

  const player = new TegisPlayer({
    mint: "https://mint.test",
    edge: "https://edge.test",
    tid: "ten_TEST",
    handshakeSecret: new Uint8Array(32),
    handshakeFn: async () => "hs",
    fetchImpl,
    telemetry: videoInit.telemetry === true, // off by default: most tests don't want the beacon traffic
    shaka: extra.shaka, // injected shaka stub for the VOD auto-dispatch path (undefined ⇒ JIT-only tests)
  });
  return {
    player,
    video: fakeVideo(videoInit),
    renewHbs,
    seekHbs,
    errors,
    segmentFetches,
    beacons,
    steps: () => beacons.map((b) => String(b.step)),
  };
}

/** Let queued microtasks and one macrotask turn — enough for the detached feed loop to make progress. */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}
