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
}

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
  constructor(private cfg: BrowserPlayerConfig) {}

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
  async fetchBytes(url: string): Promise<Uint8Array> {
    const r = await this.f(url.startsWith("http") ? url : this.cfg.edge + url, { headers: this.hdr() });
    if (r.status !== 200) throw new Error("fetch failed " + r.status + ": " + url);
    return new Uint8Array(await r.arrayBuffer());
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
    const g = await this.mint(opts);
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
    for (const url of g.manifest) {
      let seg: Uint8Array;
      try {
        seg = await this.decryptedSegment(opts.assetId, url, key); // 404 ⇒ past the end of the packaged content
      } catch {
        break;
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
  }
}
