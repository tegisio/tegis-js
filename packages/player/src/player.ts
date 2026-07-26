// @tegis/player (browser) — the real Gate-F F1 player. WebCrypto + (optional) WASM handshake + MSE.
// The crypto/fetch/decrypt core runs identically in the browser and in Bun (the headless e2e); the MSE
// glue is browser-only (guarded). The player NEVER holds a tenant private key — only a short-lived att +
// grant. Demo headers (x-aegis-tenant/x-aegis-client-ip) are dev-only and gated behind demoHeaders; a
// real deployment routes by Host (F3) and never sets them.

import { handshake as wcHandshake, hbSign, decryptSegment, unb64u } from "./crypto.ts";
import { QoeCollector } from "./qoe.ts";

export interface BrowserPlayerConfig {
  mint: string;
  edge: string; // edge or CDN base URL
  tid: string;
  handshakeSecret: Uint8Array; // delivered by Aegis; WASM-whitened in production
  handshakeFn?: (att: string, ent: string, nonce: string, t: number) => Promise<string>; // WASM module override
  demoHeaders?: boolean; // dev only — send x-aegis-tenant/x-aegis-client-ip
  clientIp?: string;
  fetchImpl?: typeof fetch;
  /** Client funnel telemetry (play→first-frame→watch-through→complete/error), beaconed to the edge for
   *  the operator's e2e support view. Privacy-safe: only opaque ses/pbk/ast, never viewer PII. On by
   *  default; set `false` to disable. */
  telemetry?: boolean;
  /** JIT tolerance (spec 12 §4.6): with a JIT origin (spec 14 §6.5 / task D1) a cold-segment request can
   *  come back `preparing` (503 + `Retry-After`) instead of the bytes. The player treats that as a graceful
   *  back-off + retry — NEVER a playback error. Tune the retry budget here; sane defaults apply when omitted. */
  jit?: JitConfig;
  /** State hook the tenant app can render. Fires `preparing` while a cold segment is being JIT-prepared (so
   *  the app can show a "still preparing…" spinner) and `ready` once the bytes arrive. Best-effort: a throwing
   *  hook is swallowed so it can never break playback. */
  onState?: (state: PlayerState) => void;
  /** Injectable backoff sleep (defaults to `setTimeout`). Lets tests drive the retry loop with fake timers. */
  delayFn?: (ms: number) => Promise<void>;
  /** Injectable monotonic clock (ms) for QoE timing — TTFF (play-requested → first frame). Defaults to
   *  `performance.now()`. Lets tests measure durations deterministically. */
  now?: () => number;
}

/** Retry budget for JIT `preparing` tolerance (spec 12 §4.6). Defaults: maxAttempts 6, baseDelayMs 500,
 *  maxDelayMs 8000 (also the ceiling that clamps a large upstream `Retry-After`). */
export interface JitConfig {
  /** Max `preparing` retries before giving up with a graceful terminal error. Default 6. */
  maxAttempts?: number;
  /** Base backoff used when the origin sends no `Retry-After`; grows exponentially. Default 500ms. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff (also caps a large `Retry-After`). Default 8000ms. */
  maxDelayMs?: number;
}

/** The segment is being JIT-prepared upstream — the host can render a "still preparing…" affordance. */
export interface PreparingState {
  state: "preparing";
  /** Segment URL being prepared. */
  url: string;
  /** 1-based retry about to be waited out. */
  attempt: number;
  /** Retry-budget ceiling (from `jit.maxAttempts`). */
  maxAttempts: number;
  /** Backoff (ms) before the next attempt — honors `Retry-After` when present, else exponential; always
   *  clamped to `jit.maxDelayMs`, so this is the real wait the player will observe. */
  retryAfterMs: number;
}

/** A previously-`preparing` segment is now available (2xx) — the player transitions back to normal playback. */
export interface ReadyState {
  state: "ready";
  url: string;
  /** How many `preparing` retries it took to become ready. */
  attempts: number;
}

/** JIT-aware segment-fetch state surfaced to the host via {@link BrowserPlayerConfig.onState}. */
export type PlayerState = PreparingState | ReadyState;

export interface Grant {
  grant: string;
  playbackId: string;
  hbKeyB64u: string;
  init: string; // signed init-segment URL (F1: needed for MSE)
  manifest: string[]; // signed media-segment URLs
  window: { from: number; to: number };
  res: string;
  /** Browser-only: outcome of the SDK's best-effort autoplay — `playing` (started as-is), `muted` (fell
   *  back to muted because autoplay-with-audio was blocked), or `blocked` (needs a user gesture). Lets a
   *  caller surface an unmute hint / play button instead of being left on a frozen frame. */
  autoplay?: "playing" | "muted" | "blocked";
}

function randHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A legible playback failure surfaced via {@link PlayOpts.onError} (and console). `code` is a stable slug,
 *  `message` is human-readable, `cause` is the underlying error/MediaError when there is one. */
export interface PlayError {
  code:
    | "codec_unsupported"
    | "decode"
    | "segment_fetch"
    | "append"
    | "no_first_frame"
    | "stalled"
    | "play_failed";
  message: string;
  cause?: unknown;
}

/** Options for {@link TegisPlayer.play}. Only `assetId` + `entitlement` are required; the rest tune element
 *  setup, autoplay, teardown, and callbacks. Progressive streaming, multi-window continuity, and buffer
 *  pacing are all handled internally — the caller just supplies a `<video>` and these. */
export interface PlayOpts {
  assetId: string;
  entitlement: string;
  ses?: string;
  fph?: string;
  token?: string;
  /** Override the SourceBuffer codec. Default: derived from the init segment (video-only H.264 supported). */
  mime?: string;
  loop?: boolean;
  muted?: boolean;
  /** Set `playsinline` (default true — required for inline autoplay on iOS). Pass `false` to opt out. */
  playsInline?: boolean;
  /** Abort playback + tear everything down: in-flight fetch/decrypt/append cancelled, element detached.
   *  Equivalent to calling `handle.stop()`. Ideal for a scroll feed that mounts/unmounts constantly. */
  signal?: AbortSignal;
  /** Legible failure callback (also logged to console). Never throws into playback. */
  onError?: (e: PlayError) => void;
  /** Fires once, when the first frame is actually presented (the `playing` event). */
  onFirstFrame?: () => void;
}

/** Returned by {@link TegisPlayer.play}: a superset of {@link Grant} plus `stop()` for full teardown. */
export interface PlaybackHandle extends Grant {
  /** Idempotent, abortable teardown: pause, detach the MediaSource, cancel all in-flight work. */
  stop(): Promise<void>;
}

// Buffer pacing + watchdog tuning (browser hot path). HIGH_WATER caps how far ahead the feed loop fetches
// (back-pressure); the watchdogs surface a legible error instead of a silent hang.
const HIGH_WATER_S = 24; // stop fetching once this many seconds are buffered ahead of the playhead
const FIRST_FRAME_TIMEOUT_MS = 12_000; // after the first segment is appended + play(), expect a frame within this
const STALL_MS = 8_000; // currentTime stuck this long WITH buffered data ahead = a real (surfaced) stall

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
function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/** Await a one-shot event, rejecting if the signal aborts first. */
function onceEvent(target: EventTarget, name: string, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(abortError());
    const on = () => {
      cleanup();
      res();
    };
    const onAbort = () => {
      cleanup();
      rej(abortError());
    };
    const cleanup = () => {
      target.removeEventListener(name, on);
      signal.removeEventListener("abort", onAbort);
    };
    target.addEventListener(name, on, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A failed segment fetch is the stream's TRUE end (`"end"`) when it is a 404 past the sealed content or a
 *  phantom trailing segment (JIT `preparing` budget exhausted); any other failure is a real `"error"`. */
function classifyFetchError(e: unknown): "end" | "error" {
  if (e instanceof Error) {
    if ((e as Error & { preparing?: boolean }).preparing === true) return "end"; // phantom: never produced
    if (/\bfetch failed 404\b/.test(e.message)) return "end"; // past the sealed content
  }
  return "error";
}

export class TegisPlayer {
  private att?: string;
  private attSes?: string;
  private evtSes?: string;
  private evtPbk?: string;
  private evtAst?: string;
  private watched = new Set<number>();
  /** Per-playback QoE accumulator (TTFF / preparing / rebuffer). Reset at the start of every `play()`. */
  private qoe: QoeCollector;
  /** Guards the single terminal `client.qoe` beacon per playback (the completed/error vs. page-unload race). */
  private qoeSent = false;
  /** Ensures the page-unload QoE flush hooks are registered at most once per player. */
  private qoeUnloadWired = false;
  constructor(private cfg: BrowserPlayerConfig) {
    this.qoe = new QoeCollector(cfg.now);
  }

  /** Beacon one client-funnel step to the edge (Spec 09 §2.3). Best-effort + fully guarded — telemetry
   *  NEVER throws and never affects playback. sendBeacon avoids a CORS preflight + survives page unload. */
  private beacon(step: string, reason?: string): void {
    if (this.cfg.telemetry === false) return;
    try {
      const url = this.cfg.edge.replace(/\/+$/, "") + "/evt/v1";
      const body = JSON.stringify({ ses: this.evtSes, pbk: this.evtPbk, ast: this.evtAst, step, reason });
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url, body);
      } else {
        void this.f(url, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* telemetry is best-effort */
    }
  }

  /** Emit the ONE `client.qoe` beacon for this playback (BACKLOG-3 wire contract). Rides the exact same
   *  client-event path + envelope as the funnel beacons — POST `/evt/v1` with `{ses,pbk,ast,step}` — so the
   *  edge maps `step:"qoe"` → `client.qoe` and the ClickHouse ingest treats it uniformly. Best-effort +
   *  idempotent: a `sent` flag guards the completed/error-vs-unload race so it fires at most once per
   *  playback. Privacy-safe — only the opaque ses/pbk/ast + the QoE numbers; NEVER geo/IP/UA (the gateway
   *  stamps viewer country server-side, D3). */
  private emitQoe(): void {
    if (this.cfg.telemetry === false) return;
    if (this.qoeSent) return;
    this.qoeSent = true;
    try {
      const url = this.cfg.edge.replace(/\/+$/, "") + "/evt/v1";
      const q = this.qoe.snapshot();
      const body = JSON.stringify({
        ses: this.evtSes,
        pbk: this.evtPbk,
        ast: this.evtAst,
        step: "qoe", // edge maps `client.` + step → `client.qoe`, same routing as every funnel step
        ttff_ms: q.ttff_ms,
        preparing_count: q.preparing_count,
        preparing_ms: q.preparing_ms,
        rebuffer_count: q.rebuffer_count,
      });
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url, body);
      } else {
        void this.f(url, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* QoE telemetry is best-effort — it must never affect playback */
    }
  }

  /** Register the page-unload QoE flush once per player: a `pagehide` and a `visibilitychange`→hidden both
   *  try to emit the terminal `client.qoe` beacon (idempotent via the `sent` flag) so a viewer who closes the
   *  tab mid-playback is still counted. Browser-only + fully guarded; a no-op where there is no `document`. */
  private wireUnloadQoe(): void {
    if (this.cfg.telemetry === false || this.qoeUnloadWired) return;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    this.qoeUnloadWired = true;
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.emitQoe();
      });
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("pagehide", () => this.emitQoe());
      }
    } catch {
      /* unload wiring is best-effort */
    }
  }

  /** Attach the watch-through / first-frame / completion / error listeners once MSE is playing. */
  private wireFunnel(video: HTMLVideoElement): void {
    if (this.cfg.telemetry === false) return;
    // First frame: stamp TTFF + fire the funnel step. The mark is idempotent — only the first `playing` wins.
    video.addEventListener(
      "playing",
      () => {
        this.qoe.markFirstFrame();
        this.beacon("first_frame");
      },
      { once: true },
    );
    // Rebuffer: a `waiting` AFTER the first frame is a post-start stall; before it, it's just initial buffering.
    video.addEventListener("waiting", () => {
      if (this.qoe.hasStarted()) this.qoe.addRebuffer();
    });
    // Terminal moments: emit the one-per-playback QoE beacon alongside the funnel completed/error step.
    video.addEventListener(
      "ended",
      () => {
        this.beacon("completed");
        this.emitQoe();
      },
      { once: true },
    );
    video.addEventListener(
      "error",
      () => {
        this.beacon("error", "media_error");
        this.emitQoe();
      },
      { once: true },
    );
    video.addEventListener("timeupdate", () => {
      const d = video.duration;
      if (!d || !isFinite(d)) return;
      const pctBucket = Math.floor((video.currentTime / d) * 100);
      for (const q of [25, 50, 75, 100]) {
        if (pctBucket >= q && !this.watched.has(q)) {
          this.watched.add(q);
          this.beacon("watched_" + q);
        }
      }
    });
  }

  private get f(): typeof fetch {
    // bind to globalThis — browser fetch throws "Illegal invocation" if called with this !== window.
    return this.cfg.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
  }
  private hdr(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...extra };
    if (this.cfg.demoHeaders) {
      h["x-aegis-tenant"] = this.cfg.tid;
      if (this.cfg.clientIp) h["x-aegis-client-ip"] = this.cfg.clientIp;
    }
    return h;
  }
  private async post(path: string, body: unknown, signal?: AbortSignal) {
    const r = await this.f(this.cfg.mint + path, { method: "POST", headers: this.hdr(), body: JSON.stringify(body), signal });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  }
  private handshake(att: string, ent: string, nonce: string, t: number): Promise<string> {
    return (this.cfg.handshakeFn ?? ((a, e, n, tt) => wcHandshake(this.cfg.handshakeSecret, a, e, n, tt)))(att, ent, nonce, t);
  }

  /** Pre-warm attestation OFF the click→play path (F1 §3): solve the bot-wall at page load, hold the att. */
  async prewarm(
    opts: { ses?: string; fph?: string; nonce?: string; solution?: string; token?: string } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const ses = opts.ses ?? "ses_" + randHex(4);
    const body: any = { ses, fph: opts.fph ?? "fp_" + ses };
    if (opts.solution) {
      body.nonce = opts.nonce;
      body.solution = opts.solution;
    }
    if (opts.token) body.token = opts.token; // F2: Cloudflare Turnstile token (the mint verifies it via siteverify)
    const r = await this.post("/attest/v1/verify", body, signal);
    if (!r.json.att) throw new Error("attestation failed: " + JSON.stringify(r.json));
    this.att = r.json.att;
    this.attSes = ses;
    return this.att!; // guaranteed set above (throws if attestation missing)
  }

  /** Mint a playback grant for an asset (pre-warms inline if not already warm). */
  async mint(
    opts: { assetId: string; entitlement: string; ses?: string; fph?: string; token?: string },
    signal?: AbortSignal,
  ): Promise<Grant> {
    const ses = this.attSes ?? opts.ses ?? "ses_" + randHex(4);
    if (!this.att) await this.prewarm({ ses, fph: opts.fph, token: opts.token }, signal);
    const nonce = (await this.post("/mint/v1/nonce", { ses }, signal)).json.nonce;
    const t = Math.floor(Date.now() / 1000);
    const hs = await this.handshake(this.att!, opts.entitlement, nonce, t);
    const r = await this.post("/mint/v1", { assetId: opts.assetId, att: this.att, entitlement: opts.entitlement, nonce, handshake: hs, t }, signal);
    if (r.status !== 200) throw new Error("mint failed: " + r.status + " " + JSON.stringify(r.json));
    return r.json as Grant;
  }

  /** Fetch the att-gated content key (AES-128, 16 bytes). */
  async contentKey(assetId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const r = await this.f(`${this.cfg.mint}/key/v1/${assetId}?att=${this.att}`, { headers: this.hdr(), signal });
    if (r.status !== 200) throw new Error("key fetch failed: " + r.status);
    return unb64u((await r.json()).key);
  }
  private jitOpts(): Required<JitConfig> {
    return { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 8000, ...(this.cfg.jit ?? {}) };
  }
  /** A `preparing` origin response (spec 12 §4.6): the JIT edge (task D1) answers a cold-segment miss with
   *  `503` (usually + `Retry-After`) or an explicit `preparing` marker — NEVER a 404. Tolerant by design. */
  private isPreparing(r: Response): boolean {
    if (r.status === 503) return true;
    const marker = (r.headers.get("x-tegis-status") ?? r.headers.get("x-aegis-status") ?? "").toLowerCase();
    return marker === "preparing";
  }
  /** Backoff before the next attempt: honor `Retry-After` (delta-seconds or HTTP-date) when present, else a
   *  bounded exponential backoff. Always clamped to [0, maxDelayMs]. */
  private retryDelayMs(r: Response, attempt: number, jit: Required<JitConfig>): number {
    const ra = r.headers.get("retry-after");
    if (ra != null && ra !== "") {
      const secs = Number(ra);
      const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
      if (Number.isFinite(ms)) return Math.max(0, Math.min(ms, jit.maxDelayMs));
    }
    return Math.min(jit.baseDelayMs * 2 ** (attempt - 1), jit.maxDelayMs);
  }
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.cfg.delayFn) return this.cfg.delayFn(ms);
    return new Promise((res, rej) => {
      if (signal?.aborted) return rej(abortError());
      const t = setTimeout(res, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(abortError());
      }, { once: true });
    });
  }
  private emitState(s: PlayerState): void {
    try {
      this.cfg.onState?.(s);
    } catch {
      /* a host state hook must never break playback */
    }
  }
  /**
   * Fetch raw segment/origin bytes — JIT-aware (spec 12 §4.6). A `preparing` response (503 + `Retry-After`,
   * or a `preparing` marker) is NOT an error: the player backs off and retries (honoring `Retry-After`, else
   * a capped exponential backoff) up to `jit.maxAttempts`, firing the `preparing` state hook while it waits
   * and a `ready` state once the bytes arrive. Exhausted retries throw a graceful terminal error (flagged
   * `preparing`); a genuine non-2xx throws immediately.
   */
  async fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const full = url.startsWith("http") ? url : this.cfg.edge + url;
    const jit = this.jitOpts();
    let attempt = 0;
    for (;;) {
      const r = await this.f(full, { headers: this.hdr(), signal });
      if (r.status === 200) {
        if (attempt > 0) this.emitState({ state: "ready", url: full, attempts: attempt });
        return new Uint8Array(await r.arrayBuffer());
      }
      const preparing = this.isPreparing(r);
      if (preparing && attempt < jit.maxAttempts) {
        attempt++;
        const retryAfterMs = this.retryDelayMs(r, attempt, jit);
        this.qoe.addPreparing(retryAfterMs); // QoE: count this preparing occurrence + the ms it will wait
        this.emitState({ state: "preparing", url: full, attempt, maxAttempts: jit.maxAttempts, retryAfterMs });
        this.beacon("preparing", "jit"); // e2e funnel: cold segment still preparing (best-effort)
        await this.sleep(retryAfterMs, signal);
        continue;
      }
      if (preparing) {
        const err = new Error(`segment still preparing after ${jit.maxAttempts} attempts: ${full}`) as Error & {
          preparing?: boolean;
        };
        err.preparing = true;
        throw err;
      }
      throw new Error("fetch failed " + r.status + ": " + full);
    }
  }
  /** The headless-verifiable core: fetch a media segment from the edge/CDN + decrypt it with WebCrypto. */
  async decryptedSegment(assetId: string, url: string, key?: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const k = key ?? (await this.contentKey(assetId, signal));
    return decryptSegment(k, await this.fetchBytes(url, signal));
  }

  /** Steady-state renewal: report realtime progress to receive the next signed window. */
  async renew(
    playbackId: string,
    hbKeyB64u: string,
    progress: { pos: number; seq: number },
    signal?: AbortSignal,
  ): Promise<{ manifest: string[]; window: { from: number; to: number } }> {
    const hb = { pbk: playbackId, pos: progress.pos, seq: progress.seq, state: "playing", iat: Math.floor(Date.now() / 1000) };
    const sig = await hbSign(hbKeyB64u, JSON.stringify(hb));
    const r = await this.post("/mint/v1/renew", { playbackId, heartbeat: hb, sig }, signal);
    if (r.status !== 200) throw new Error("renew failed: " + r.status);
    return r.json;
  }

  /** Seconds of contiguous buffered media ahead of the playhead (0 if the playhead isn't inside a range).
   *  The back-pressure signal for the feed loop and the "buffer present but stuck" input to the stall watchdog. */
  private bufferedAhead(video: HTMLVideoElement): number {
    const b = video.buffered;
    const t = video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.25 && t <= b.end(i) + 0.25) return b.end(i) - t;
    }
    return 0;
  }

  /** Resolve on the next real playback progress (`timeupdate`), end, error, abort, or a 500ms fallback tick —
   *  so the feed loop's back-pressure wait reacts to the playhead draining the buffer, costs nothing while
   *  idle, and never wedges (the fallback covers a paused/stalled element). Browser-only. */
  private waitTick(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
    return new Promise((res) => {
      if (signal.aborted || typeof video.addEventListener !== "function") return res();
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        video.removeEventListener("timeupdate", fin);
        video.removeEventListener("ended", fin);
        video.removeEventListener("error", fin);
        signal.removeEventListener("abort", fin);
        res();
      };
      const t = setTimeout(fin, 500);
      video.addEventListener("timeupdate", fin);
      video.addEventListener("ended", fin);
      video.addEventListener("error", fin);
      signal.addEventListener("abort", fin, { once: true });
    });
  }

  /** Never-hang watchdogs (browser-only), armed after the first segment is appended + play() is called:
   *  (1) first-frame — no `playing` within FIRST_FRAME_TIMEOUT_MS ⇒ `no_first_frame`; (2) stall — `currentTime`
   *  frozen for STALL_MS while playing WITH buffered data ahead (a genuine stuck, not a normal underrun the
   *  feed loop will refill) ⇒ `stalled`. Both surface via `onError` (legible), never tear down. Registers its
   *  cleanup into `cleanups`. */
  private armWatchdogs(video: HTMLVideoElement, signal: AbortSignal, onError: (e: PlayError) => void, cleanups: Array<() => void>): void {
    if (typeof video.addEventListener !== "function") return;
    let gotFrame = false;
    const onPlaying = () => {
      gotFrame = true;
    };
    video.addEventListener("playing", onPlaying, { once: true });
    const ffTimer = setTimeout(() => {
      if (!gotFrame && !signal.aborted && !video.paused) {
        onError({
          code: "no_first_frame",
          message: `no first frame after ${FIRST_FRAME_TIMEOUT_MS}ms — buffered ${this.bufferedAhead(video).toFixed(1)}s ahead, readyState ${video.readyState}`,
        });
      }
    }, FIRST_FRAME_TIMEOUT_MS);
    let last = -1;
    let lastAt = Date.now();
    const stallIv = setInterval(() => {
      if (signal.aborted) return;
      const t = video.currentTime;
      if (video.paused || video.ended || t !== last) {
        last = t;
        lastAt = Date.now();
        return;
      }
      if (Date.now() - lastAt >= STALL_MS && this.bufferedAhead(video) > 0.5) {
        onError({
          code: "stalled",
          message: `currentTime stuck at ${t.toFixed(2)}s for ${STALL_MS}ms with ${this.bufferedAhead(video).toFixed(1)}s buffered ahead`,
        });
        lastAt = Date.now(); // rearm — don't spam
      }
    }, 1000);
    cleanups.push(() => {
      clearTimeout(ffTimer);
      clearInterval(stallIv);
      video.removeEventListener("playing", onPlaying);
    });
  }

  /**
   * Own progressive streaming end-to-end (browser-only). mint → derive the codec from the init → append init +
   * first segment (fast first frame) → play → then a PACED feed loop streams the rest: it prefetches to keep
   * ~HIGH_WATER_S buffered ahead of the playhead (back-pressure), crosses mint-window boundaries seamlessly
   * (renews before the current window drains), and stops at the first phantom/past-end segment — calling
   * `endOfStream()` only after the final segment of the final window. Returns a {@link PlaybackHandle} (a
   * superset of the grant) as soon as the first frame is ready; the feed loop runs detached. `handle.stop()`
   * (or an aborted `opts.signal`) tears everything down: pause, detach the MediaSource, cancel all in-flight
   * fetch/decrypt/append. Every failure path surfaces a legible {@link PlayError} via `onError` + console
   * instead of a silent hang.
   */
  async play(video: HTMLVideoElement, opts: PlayOpts): Promise<PlaybackHandle> {
    if (!video) throw new Error("play: a video element is required");
    if (typeof MediaSource === "undefined" && typeof (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource === "undefined") {
      throw new Error("play: MSE unavailable in this environment");
    }

    // Teardown scaffolding: one AbortController drives cancellation of all in-flight work; `cleanups` unwinds
    // listeners/timers; `teardown` is idempotent and detaches the element.
    const ac = new AbortController();
    const signal = ac.signal;
    const cleanups: Array<() => void> = [];
    let stopped = false;
    let ms: MediaSource | undefined;
    const onError = (e: PlayError): void => {
      try {
        console.error(`[tegis/player] ${e.code}: ${e.message}`, e.cause ?? "");
      } catch {
        /* console may be absent */
      }
      try {
        opts.onError?.(e);
      } catch {
        /* a host callback must never break playback */
      }
    };
    const teardown = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      ac.abort();
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* best-effort */
        }
      }
      try {
        video.pause();
      } catch {
        /* detached/gone */
      }
      try {
        (video as unknown as { srcObject: unknown }).srcObject = null; // detach an srcObject handle
      } catch {
        /* not srcObject */
      }
      try {
        const u = video.src;
        if (u) {
          video.removeAttribute("src");
          if (u.startsWith("blob:")) URL.revokeObjectURL(u); // detach + free an object URL
        }
      } catch {
        /* best-effort */
      }
      try {
        video.load();
      } catch {
        /* best-effort */
      }
      this.emitQoe();
    };
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => void teardown(), { once: true });
    }

    // Client funnel + element setup.
    const ses = this.attSes ?? opts.ses ?? "ses_" + randHex(4);
    this.evtSes = ses;
    this.evtAst = opts.assetId;
    this.evtPbk = undefined;
    this.watched.clear();
    this.qoe.reset();
    this.qoeSent = false;
    if (opts.loop) video.loop = true;
    if (opts.muted) video.muted = true;
    if (opts.playsInline !== false) {
      video.playsInline = true;
      try {
        video.setAttribute("playsinline", ""); // iOS honors the attribute
      } catch {
        /* non-DOM stub */
      }
    }
    this.wireFunnel(video);
    this.wireUnloadQoe();
    this.qoe.markPlayRequested();
    this.beacon("play_requested");

    try {
      throwIfAborted(signal);
      const g = await this.mint({ ...opts, ses }, signal);
      this.evtSes = this.attSes ?? ses;
      this.evtPbk = g.playbackId;
      this.beacon("granted");
      const key = await this.contentKey(opts.assetId, signal);
      throwIfAborted(signal);

      ms = createMediaSource();
      attachMediaSource(video, ms);
      await onceEvent(ms, "sourceopen", signal);

      // Derive the codec from the init `moov` (video-only H.264 High); gate on isTypeSupported.
      const initBytes = await this.fetchBytes(g.init, signal);
      const mime = opts.mime ?? codecsFromInit(initBytes) ?? DEFAULT_MIME;
      if (!msTypeSupported(ms, mime)) {
        const e: PlayError = { code: "codec_unsupported", message: `this browser can't decode the content codec (${mime})` };
        onError(e);
        throw new Error(e.message);
      }
      const sb = ms.addSourceBuffer(mime);
      try {
        sb.mode = "segments"; // CMAF bare fragments: chained baseMediaDecodeTime timing; overlap = last-write-wins
      } catch {
        /* segments is the default anyway */
      }

      // Serialized, abortable append — resolves on updateend; rejects on the SourceBuffer error event, a
      // synchronous appendBuffer throw, or abort.
      const append = (buf: Uint8Array): Promise<void> =>
        new Promise((res, rej) => {
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

      // A decode/format failure surfaces as a MediaError on the <video>, NOT the SourceBuffer error event —
      // wire it for the whole playback so a mismatch is legible instead of a silent frozen frame.
      const onMediaError = () => {
        const err = video.error;
        onError({
          code: "decode",
          message: `MediaError ${err?.code ?? "?"}${err?.message ? ": " + err.message : ""} — codec "${mime}" may not match the content`,
          cause: err,
        });
      };
      video.addEventListener("error", onMediaError);
      cleanups.push(() => video.removeEventListener("error", onMediaError));

      // Init + first segment → play immediately (fast first frame).
      await append(initBytes);
      const manifest = g.manifest ?? [];
      let firstReachedEnd = manifest.length === 0;
      if (manifest.length > 0) {
        try {
          const first = await this.decryptedSegment(opts.assetId, manifest[0], key, signal);
          this.beacon("first_segment_decrypted");
          await append(first);
        } catch (e) {
          if (isAbort(e)) throw e;
          firstReachedEnd = classifyFetchError(e) === "end"; // an all-phantom grant → nothing to play
          if (!firstReachedEnd) onError({ code: "segment_fetch", message: `first segment failed: ${(e as Error).message}`, cause: e });
        }
      }
      throwIfAborted(signal);

      if (opts.onFirstFrame) {
        const ff = () => {
          try {
            opts.onFirstFrame!();
          } catch {
            /* host callback */
          }
        };
        video.addEventListener("playing", ff, { once: true });
        cleanups.push(() => video.removeEventListener("playing", ff));
      }
      this.armWatchdogs(video, signal, onError, cleanups);

      // Best-effort autoplay; fall back to muted where autoplay-with-audio is blocked.
      let autoplay: NonNullable<Grant["autoplay"]> = "playing";
      try {
        await video.play();
      } catch {
        video.muted = true;
        try {
          await video.play();
          autoplay = "muted";
        } catch {
          autoplay = "blocked";
        }
      }
      g.autoplay = autoplay;

      const endStream = () => {
        try {
          if (ms && ms.readyState === "open") ms.endOfStream();
        } catch {
          /* already ended/closed */
        }
      };

      const handle: PlaybackHandle = Object.assign({}, g, { stop: teardown });

      if (firstReachedEnd) {
        endStream(); // the first segment was the whole clip (or an empty grant)
      } else {
        // The paced feed loop streams the rest across window boundaries, detached — play() returns at first frame.
        void feedStream({
          segments: manifest.slice(1),
          windowTo: g.window.to,
          highWaterS: HIGH_WATER_S,
          aborted: () => signal.aborted,
          isEnded: () => video.ended,
          bufferedAhead: () => this.bufferedAhead(video),
          waitTick: () => this.waitTick(video, signal),
          fetchSegment: (url) => this.decryptedSegment(opts.assetId, url, key, signal),
          append,
          renew: (pos, seq) => this.renew(g.playbackId, g.hbKeyB64u, { pos, seq }, signal),
          pos: () => video.currentTime,
          endStream,
          classifyError: classifyFetchError,
          onEnd: (reason, detail) => {
            if (reason === "error") onError({ code: "segment_fetch", message: "playback stream ended on error", cause: detail });
          },
        });
      }

      return handle;
    } catch (e) {
      if (isAbort(e)) {
        await teardown();
        throw abortError();
      }
      this.beacon("error", e instanceof Error ? e.message.slice(0, 80) : "play_failed");
      onError({ code: "play_failed", message: e instanceof Error ? e.message : "play failed", cause: e });
      this.emitQoe();
      throw e;
    }
  }
}

// ---- MSE attachment (browser) ---------------------------------------------------------------------------
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
 *  (iOS) — and falling back to the object URL only where a handle isn't available. Returns the method used. */
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

// ---- SourceBuffer codec derivation (browser + headless-testable) ----------------------------------------

/** Last-resort SourceBuffer codec, used only when the caller passes no `mime` AND the init segment can't be
 *  parsed. H.264 High@L4.0 + AAC-LC fits typical 1080p output far better than the old Main@L3.0 guess. */
const DEFAULT_MIME = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

/** `MediaSource.isTypeSupported` via the CONSTRUCTOR actually in use (ManagedMediaSource on iOS has its own).
 *  Returns true when the platform exposes no `isTypeSupported` — never block playback on a missing probe. */
function msTypeSupported(ms: MediaSource, mime: string): boolean {
  const ctor = (ms as unknown as { constructor?: { isTypeSupported?: (t: string) => boolean } }).constructor;
  const fn = ctor?.isTypeSupported;
  return typeof fn === "function" ? fn.call(ctor, mime) : true;
}

// ---- minimal ISO-BMFF (fMP4) box reader — just enough of `moov` to read the codec strings ----------------

const u32 = (b: Uint8Array, o: number): number => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const boxType = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex2 = (n: number): string => (n & 0xff).toString(16).padStart(2, "0");

/** Iterate the boxes in [start, end): `fn(type, payloadStart, payloadEnd)`. Handles 32-bit, 64-bit
 *  (`size===1`) and to-end (`size===0`) box sizes; stops on any malformed length. */
function eachBox(b: Uint8Array, start: number, end: number, fn: (type: string, ps: number, pe: number) => void): void {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = boxType(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12); // 64-bit; init segments never approach 2^53
      hdr = 16;
    } else if (size === 0) {
      size = end - o; // extends to the end of the container
    }
    if (size < hdr || o + size > end) break;
    fn(type, o + hdr, o + size);
    o += size;
  }
}

/** Descend a fixed chain of container boxes (e.g. mdia→minf→stbl→stsd), calling `fn(payloadStart, end)` for
 *  each leaf that matches the whole path. */
function findPath(b: Uint8Array, start: number, end: number, path: string[], fn: (ps: number, pe: number) => void): void {
  if (path.length === 0) {
    fn(start, end);
    return;
  }
  eachBox(b, start, end, (t, ps, pe) => {
    if (t === path[0]) findPath(b, ps, pe, path.slice(1), fn);
  });
}

/** Read the AAC audioObjectType out of an `esds` payload (after its 4-byte version/flags), walking the
 *  ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo chain. Returns the AOT, or null (caller
 *  defaults to AAC-LC). */
function aacObjectType(b: Uint8Array, o: number, end: number): number | null {
  const readLen = (p: number): [number, number] => {
    let len = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const c = b[p++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return [len, p];
  };
  let p = o;
  if (b[p] === 0x03) {
    // ES_Descriptor: length, ES_ID(2), flags(1), then optional dependency/URL/OCR fields.
    p++;
    p = readLen(p)[1];
    p += 2;
    const flags = b[p++];
    if (flags & 0x80) p += 2; // dependsOn_ES_ID
    if (flags & 0x40) p += 1 + (b[p] ?? 0); // URL (length-prefixed)
    if (flags & 0x20) p += 2; // OCR_ES_ID
  }
  if (b[p] === 0x04) {
    // DecoderConfigDescriptor: length, objectTypeIndication(1), streamType/bufferSize(4), max/avgBitrate(8).
    p++;
    p = readLen(p)[1];
    p += 1 + 4 + 4 + 4;
  }
  if (b[p] === 0x05) {
    // DecoderSpecificInfo = AudioSpecificConfig; the first 5 bits are the audioObjectType.
    p++;
    p = readLen(p)[1];
    const aot = (b[p] >> 3) & 0x1f;
    return aot || null;
  }
  return null;
}

const VIDEO_4CC = new Set(["avc1", "avc3", "hvc1", "hev1", "av01", "vp08", "vp09"]);

/** Classify one sample entry and return its codec string. Fully parses H.264 (`avc1`/`avc3` via `avcC`) and
 *  AAC (`mp4a` via `esds`); a video entry we can't decode into a codec returns `{kind:"video", codec:null}`
 *  so the caller declines to derive rather than emit a wrong/partial mime. */
function codecFromSampleEntry(b: Uint8Array, type: string, ps: number, pe: number): { kind: "video" | "audio"; codec: string | null } | null {
  if (type === "avc1" || type === "avc3") {
    let codec: string | null = null;
    eachBox(b, ps + 78, pe, (t, cps) => {
      // VisualSampleEntry has a 78-byte fixed header before its child boxes; avcC carries profile/level.
      if (t === "avcC") codec = `${type}.${hex2(b[cps + 1])}${hex2(b[cps + 2])}${hex2(b[cps + 3])}`;
    });
    return { kind: "video", codec };
  }
  if (VIDEO_4CC.has(type)) return { kind: "video", codec: null }; // HEVC/AV1/VP9 seen but not derived → decline
  if (type === "mp4a") {
    let aot = 2; // AAC-LC default
    eachBox(b, ps + 28, pe, (t, cps, cpe) => {
      // AudioSampleEntry (v0) has a 28-byte fixed header before its child boxes; esds carries the AOT.
      if (t === "esds") aot = aacObjectType(b, cps + 4, cpe) ?? aot;
    });
    return { kind: "audio", codec: `mp4a.40.${aot}` };
  }
  return null;
}

/**
 * Parse an fMP4 (ISO-BMFF) init segment's `moov` and return an MSE mime reflecting the ACTUAL codecs present —
 * e.g. `video/mp4; codecs="avc1.640028,mp4a.40.2"` — or null when it can't be determined (caller falls back
 * to opts.mime / DEFAULT_MIME). Crucially it OMITS audio when the init has no audio track (declaring phantom
 * audio stalls the SourceBuffer), and declines (returns null) when a video track is present but its codec
 * can't be read, rather than emitting a wrong string. Pure + headless-testable.
 */
export function codecsFromInit(init: Uint8Array): string | null {
  if (!init || init.length < 8) return null;
  let video: string | undefined;
  let audio: string | undefined;
  let sawVideo = false;
  try {
    eachBox(init, 0, init.length, (type, ps, pe) => {
      if (type !== "moov") return;
      eachBox(init, ps, pe, (t2, ps2, pe2) => {
        if (t2 !== "trak") return;
        findPath(init, ps2, pe2, ["mdia", "minf", "stbl", "stsd"], (sps, spe) => {
          // stsd is a FullBox: version(1)+flags(3)+entry_count(4) precede the sample entries.
          eachBox(init, sps + 8, spe, (setype, seps, sepe) => {
            const c = codecFromSampleEntry(init, setype, seps, sepe);
            if (!c) return;
            if (c.kind === "video") {
              sawVideo = true;
              if (c.codec && !video) video = c.codec;
            } else if (c.codec && !audio) {
              audio = c.codec;
            }
          });
        });
      });
    });
  } catch {
    return null;
  }
  if (sawVideo && !video) return null; // a video track we couldn't parse → don't guess
  const list = [video, audio].filter(Boolean) as string[];
  return list.length ? `video/mp4; codecs="${list.join(",")}"` : null;
}

/** A signed playback window returned by mint `/mint/v1` (grant) or `/mint/v1/renew`: the media-segment URLs
 *  plus the inclusive segment range they cover. */
export interface Window {
  manifest: string[];
  window: { from: number; to: number };
}

/** Collaborators for {@link feedStream} — injected so the paced feed loop is unit-testable with fakes (no MSE,
 *  no real timers). The class wires the real implementations in `play()`. */
export interface FeedOpts {
  /** Remaining segment URLs of the CURRENT (first) window — the first segment is appended by play() already. */
  segments: string[];
  /** Last segment index of the current window (its `window.to`) — reported as `seq` to the mint on renew. */
  windowTo: number;
  /** Stop fetching once this many seconds are buffered ahead of the playhead (back-pressure). */
  highWaterS: number;
  aborted: () => boolean;
  isEnded: () => boolean;
  /** Seconds buffered ahead of the playhead — the back-pressure signal. */
  bufferedAhead: () => number;
  /** Resolve on the next playback tick (drain), end, error, abort, or a fallback timeout. */
  waitTick: () => Promise<void>;
  /** Fetch + decrypt one media segment; throws 404-past-end / phantom `preparing` at the true end. */
  fetchSegment: (url: string) => Promise<Uint8Array>;
  append: (buf: Uint8Array) => Promise<void>;
  renew: (pos: number, windowTo: number) => Promise<Window>;
  /** Current playback position (seconds) reported to the pace guard — the REAL playhead, never ahead. */
  pos: () => number;
  /** Seal the MediaSource (called only after the final segment of the final window). */
  endStream: () => void;
  /** Classify a failed `fetchSegment`: `"end"` (404-past-end / phantom) stops silently; `"error"` surfaces. */
  classifyError: (e: unknown) => "end" | "error";
  onEnd?: (reason: "complete" | "aborted" | "error", detail?: unknown) => void;
}

/**
 * The paced, multi-window feed loop (browser-free core, exported for unit tests). It streams segments while
 * keeping at most `highWaterS` seconds buffered ahead of the playhead — fetching more only as playback drains
 * (back-pressure), so it never over-fetches nor underruns — and crosses grant-window boundaries seamlessly:
 * when the current window's segments are consumed it RENEWS the next window before the buffer empties (the
 * prefetch lead), reporting the real floored `pos` and last-appended `seq` so the mint's pace/replay guards
 * are always satisfied. It stops — sealing via `endStream()` — at the true end: the first segment that won't
 * produce (404 past the sealed content, or a phantom trailing segment whose JIT `preparing` budget is spent),
 * a renew that rejects (expired/paced-out/network), or a renew that returns an empty window. Abort stops it
 * immediately, leaving whatever is buffered.
 */
export async function feedStream(o: FeedOpts): Promise<void> {
  let segments = o.segments;
  let windowTo = o.windowTo;
  try {
    while (!o.aborted()) {
      if (segments.length === 0) {
        let next: Window;
        try {
          next = await o.renew(Math.floor(o.pos()), windowTo);
        } catch {
          break; // grant expired / paced-out / network — end gracefully with what is buffered
        }
        if (!next.manifest || next.manifest.length === 0) break; // mint's true-end signal
        segments = next.manifest;
        windowTo = next.window.to;
        continue;
      }
      // Back-pressure: hold once ~highWaterS seconds are buffered ahead; resume as the playhead drains it.
      while (!o.aborted() && !o.isEnded() && o.bufferedAhead() >= o.highWaterS) {
        await o.waitTick();
      }
      if (o.aborted() || o.isEnded()) break;
      let seg: Uint8Array;
      try {
        seg = await o.fetchSegment(segments[0]);
      } catch (e) {
        if (o.aborted()) break;
        if (o.classifyError(e) === "error") {
          o.onEnd?.("error", e);
          return;
        }
        break; // 404 past-end / phantom trailing segment → the stream's true end
      }
      segments = segments.slice(1);
      try {
        await o.append(seg);
      } catch (e) {
        if (o.aborted()) break;
        o.onEnd?.("error", e);
        return;
      }
    }
    if (o.aborted()) {
      o.onEnd?.("aborted");
    } else {
      o.endStream();
      o.onEnd?.("complete");
    }
  } catch (e) {
    if (!o.aborted()) o.onEnd?.("error", e);
  }
}
