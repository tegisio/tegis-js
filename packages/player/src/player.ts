// @tegis/player (browser) — the real Gate-F F1 player. WebCrypto + (optional) WASM handshake + MSE.
// The crypto/fetch/decrypt core runs identically in the browser and in Bun (the headless e2e); the MSE
// glue is browser-only (guarded). The player NEVER holds a tenant private key — only a short-lived att +
// grant. Demo headers (x-aegis-tenant/x-aegis-client-ip) are dev-only and gated behind demoHeaders; a
// real deployment routes by Host (F3) and never sets them.

import { handshake as wcHandshake, hbSign, decryptSegment, unb64u } from "./crypto.ts";

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

export class TegisPlayer {
  private att?: string;
  private attSes?: string;
  private evtSes?: string;
  private evtPbk?: string;
  private evtAst?: string;
  private watched = new Set<number>();
  constructor(private cfg: BrowserPlayerConfig) {}

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

  /** Attach the watch-through / first-frame / completion / error listeners once MSE is playing. */
  private wireFunnel(video: HTMLVideoElement): void {
    if (this.cfg.telemetry === false) return;
    video.addEventListener("playing", () => this.beacon("first_frame"), { once: true });
    video.addEventListener("ended", () => this.beacon("completed"), { once: true });
    video.addEventListener("error", () => this.beacon("error", "media_error"), { once: true });
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
  private async post(path: string, body: unknown) {
    const r = await this.f(this.cfg.mint + path, { method: "POST", headers: this.hdr(), body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  }
  private handshake(att: string, ent: string, nonce: string, t: number): Promise<string> {
    return (this.cfg.handshakeFn ?? ((a, e, n, tt) => wcHandshake(this.cfg.handshakeSecret, a, e, n, tt)))(att, ent, nonce, t);
  }

  /** Pre-warm attestation OFF the click→play path (F1 §3): solve the bot-wall at page load, hold the att. */
  async prewarm(opts: { ses?: string; fph?: string; nonce?: string; solution?: string; token?: string } = {}): Promise<string> {
    const ses = opts.ses ?? "ses_" + randHex(4);
    const body: any = { ses, fph: opts.fph ?? "fp_" + ses };
    if (opts.solution) {
      body.nonce = opts.nonce;
      body.solution = opts.solution;
    }
    if (opts.token) body.token = opts.token; // F2: Cloudflare Turnstile token (the mint verifies it via siteverify)
    const r = await this.post("/attest/v1/verify", body);
    if (!r.json.att) throw new Error("attestation failed: " + JSON.stringify(r.json));
    this.att = r.json.att;
    this.attSes = ses;
    return this.att!; // guaranteed set above (throws if attestation missing)
  }

  /** Mint a playback grant for an asset (pre-warms inline if not already warm). */
  async mint(opts: { assetId: string; entitlement: string; ses?: string; fph?: string; token?: string }): Promise<Grant> {
    const ses = this.attSes ?? opts.ses ?? "ses_" + randHex(4);
    if (!this.att) await this.prewarm({ ses, fph: opts.fph, token: opts.token });
    const nonce = (await this.post("/mint/v1/nonce", { ses })).json.nonce;
    const t = Math.floor(Date.now() / 1000);
    const hs = await this.handshake(this.att!, opts.entitlement, nonce, t);
    const r = await this.post("/mint/v1", { assetId: opts.assetId, att: this.att, entitlement: opts.entitlement, nonce, handshake: hs, t });
    if (r.status !== 200) throw new Error("mint failed: " + r.status + " " + JSON.stringify(r.json));
    return r.json as Grant;
  }

  /** Fetch the att-gated content key (AES-128, 16 bytes). */
  async contentKey(assetId: string): Promise<Uint8Array> {
    const r = await this.f(`${this.cfg.mint}/key/v1/${assetId}?att=${this.att}`, { headers: this.hdr() });
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
  private sleep(ms: number): Promise<void> {
    return this.cfg.delayFn ? this.cfg.delayFn(ms) : new Promise((res) => setTimeout(res, ms));
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
  async fetchBytes(url: string): Promise<Uint8Array> {
    const full = url.startsWith("http") ? url : this.cfg.edge + url;
    const jit = this.jitOpts();
    let attempt = 0;
    for (;;) {
      const r = await this.f(full, { headers: this.hdr() });
      if (r.status === 200) {
        if (attempt > 0) this.emitState({ state: "ready", url: full, attempts: attempt });
        return new Uint8Array(await r.arrayBuffer());
      }
      const preparing = this.isPreparing(r);
      if (preparing && attempt < jit.maxAttempts) {
        attempt++;
        const retryAfterMs = this.retryDelayMs(r, attempt, jit);
        this.emitState({ state: "preparing", url: full, attempt, maxAttempts: jit.maxAttempts, retryAfterMs });
        this.beacon("preparing", "jit"); // e2e funnel: cold segment still preparing (best-effort)
        await this.sleep(retryAfterMs);
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
  async decryptedSegment(assetId: string, url: string, key?: Uint8Array): Promise<Uint8Array> {
    const k = key ?? (await this.contentKey(assetId));
    return decryptSegment(k, await this.fetchBytes(url));
  }

  /** Steady-state renewal: report realtime progress to receive the next signed window. */
  async renew(playbackId: string, hbKeyB64u: string, progress: { pos: number; seq: number }): Promise<{ manifest: string[]; window: { from: number; to: number } }> {
    const hb = { pbk: playbackId, pos: progress.pos, seq: progress.seq, state: "playing", iat: Math.floor(Date.now() / 1000) };
    const sig = await hbSign(hbKeyB64u, JSON.stringify(hb));
    const r = await this.post("/mint/v1/renew", { playbackId, heartbeat: hb, sig });
    if (r.status !== 200) throw new Error("renew failed: " + r.status);
    return r.json;
  }

  /**
   * Full browser playback via MSE (browser-only): mint → append the init segment → fetch+decrypt+append
   * each media segment → play. The att-gated key is fetched once. Returns the grant.
   */
  async play(video: HTMLVideoElement, opts: { assetId: string; entitlement: string; ses?: string; fph?: string; mime?: string; token?: string }): Promise<Grant> {
    if (typeof MediaSource === "undefined") throw new Error("MSE unavailable in this environment");
    // Client funnel: tag every step with a stable ses (reused by mint), wire the video listeners, and
    // emit play_requested at the click. All beacons are best-effort and never affect playback.
    const ses = this.attSes ?? opts.ses ?? "ses_" + randHex(4);
    this.evtSes = ses;
    this.evtAst = opts.assetId;
    this.evtPbk = undefined;
    this.watched.clear();
    this.wireFunnel(video);
    this.beacon("play_requested");
    try {
      const g = await this.mint({ ...opts, ses });
      this.evtSes = this.attSes ?? ses; // the ses the mint actually used
      this.evtPbk = g.playbackId;
      this.beacon("granted");
      const key = await this.contentKey(opts.assetId);
      const ms = new MediaSource();
      video.src = URL.createObjectURL(ms);
      await new Promise<void>((res) => ms.addEventListener("sourceopen", () => res(), { once: true }));
      const mime = opts.mime ?? 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"';
      const sb = ms.addSourceBuffer(mime);
      const append = (buf: Uint8Array) =>
        new Promise<void>((res, rej) => {
          sb.addEventListener("updateend", () => res(), { once: true });
          sb.addEventListener("error", (e) => rej(e), { once: true });
          sb.appendBuffer(buf as BufferSource);
        });
      await append(await this.fetchBytes(g.init)); // init segment (unencrypted codec config)
      let firstSeg = true;
      for (const url of g.manifest) {
        let seg: Uint8Array;
        try {
          seg = await this.decryptedSegment(opts.assetId, url, key); // 404 ⇒ past the end of the packaged content
        } catch {
          break;
        }
        if (firstSeg) {
          firstSeg = false;
          this.beacon("first_segment_decrypted");
        }
        await append(seg);
      }
      ms.endOfStream();
      // Best-effort autoplay. Browsers block autoplay-with-audio when media engagement is low (e.g. an
      // incognito session, MEI=0). Muted autoplay is always permitted, so on a block fall back to muted
      // rather than leaving a frozen first frame; if it is still blocked, the element stays paused for the
      // caller's play control. Report the outcome so the caller can surface an unmute/play affordance.
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
      return g;
    } catch (e) {
      // The playback pipeline failed client-side (mint/key/decrypt/MSE). Record where, for the trace.
      this.beacon("error", e instanceof Error ? e.message.slice(0, 80) : "play_failed");
      throw e;
    }
  }
}
