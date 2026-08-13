// `<tegis-player>` — the shipped player UI.
//
// Until now Tegis shipped a transport: `TegisPlayer` fills a <video> with bytes and every affordance a viewer
// recognises as "a video player" was the tenant's to build. That is why the duration gap went unnoticed for so
// long — nothing we shipped rendered a duration, so nothing we shipped revealed that we didn't have one.
//
// This is a framework-neutral custom element wrapping the SDK. `TegisPlayer` remains the public API and this
// is a consumer of it, so a tenant with their own design system loses nothing by ignoring it.
//
//   <tegis-player mint="…" edge="…" tid="…" asset="ast_…" entitlement="…"></tegis-player>
//
// Theming is CSS custom properties + `part` selectors — never a fork of the markup.

import { TegisPlayer, type BrowserPlayerConfig, type PlayError, type PlayerState, type PlaybackHandle } from "./player.ts";

/** Format seconds as a viewer-facing timestamp: `12:34`, or `1:02:03` past an hour. Non-finite input renders
 *  as `--:--` — the honest rendering of "we don't know yet", never `0:00`, which reads as an empty asset. */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Decode a base64url (or base64) string to bytes — how the handshake secret arrives as an HTML attribute. */
function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Base class for the element, resolved at module load.
 *
 * `class X extends HTMLElement` is evaluated when the module is imported, so referencing the global directly
 * makes the module unimportable anywhere there is no DOM — which includes every server render. A tenant on a
 * server-rendered framework would hit `ReferenceError: HTMLElement is not defined` merely by importing this,
 * before rendering anything. Falling back to an inert base keeps the import safe; registration is separately
 * guarded, so the shim is never actually instantiated.
 */
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as unknown as typeof HTMLElement);

const STYLE = `
:host { display: block; position: relative; background: #000; color: #fff; contain: content;
  font: 500 13px/1.4 var(--tegis-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  --tegis-accent: #3b82f6; --tegis-scrim: rgba(0,0,0,.55); }
:host([hidden]) { display: none; }
video { display: block; width: 100%; height: 100%; background: #000; }
.layer { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.layer > * { pointer-events: auto; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px 10px;
  background: linear-gradient(transparent, var(--tegis-scrim)); display: flex; flex-direction: column; gap: 6px;
  opacity: 0; transition: opacity .18s ease; }
:host(:hover) .bar, :host(:focus-within) .bar, .bar[data-show="1"] { opacity: 1; }
.row { display: flex; align-items: center; gap: 10px; }
.time { font-variant-numeric: tabular-nums; letter-spacing: .01em; }
button { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer;
  padding: 4px; border-radius: 6px; display: grid; place-items: center; font: inherit; }
button:focus-visible, .scrub:focus-visible { outline: 2px solid var(--tegis-accent); outline-offset: 2px; }
.scrub { position: relative; flex: 1; height: 16px; display: flex; align-items: center; cursor: pointer;
  border-radius: 8px; }
.track { position: relative; width: 100%; height: 4px; border-radius: 2px; background: rgba(255,255,255,.28); overflow: hidden; }
.buffered { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.45); width: 0; }
.played { position: absolute; inset: 0 auto 0 0; background: var(--tegis-accent); width: 0; }
.knob { position: absolute; top: 50%; width: 11px; height: 11px; border-radius: 50%; background: #fff;
  transform: translate(-50%,-50%); left: 0; opacity: 0; transition: opacity .15s ease; }
.scrub:hover .knob, .scrub:focus-visible .knob { opacity: 1; }
.badge { background: var(--tegis-scrim); border-radius: 999px; padding: 8px 14px; backdrop-filter: blur(6px); }
.err { background: #7f1d1d; border-radius: 8px; padding: 10px 14px; max-width: 80%; text-align: center; }
.poster { position: absolute; inset: 0; background-size: cover; background-position: center; }
.spinner { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(255,255,255,.3);
  border-top-color: #fff; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.5s; } .bar { transition: none; } }
`;

/**
 * The `<tegis-player>` custom element.
 *
 * Attributes: `mint` `edge` `tid` `asset` `entitlement` `handshake-secret` (base64url) `poster` `autoplay`
 * `muted` `loop`. The handshake secret can also be set as a `handshakeSecret` property (Uint8Array), which is
 * the better path when the host has it as bytes already.
 */
export class TegisPlayerElement extends ElementBase {
  static observedAttributes = ["poster"];

  /** Handshake secret as bytes. Takes precedence over the `handshake-secret` attribute. */
  handshakeSecret?: Uint8Array;

  private video!: HTMLVideoElement;
  private root!: ShadowRoot;
  private player?: TegisPlayer;
  private handle?: PlaybackHandle;
  private els: Record<string, HTMLElement> = {};
  private durationSec = 0;
  private started = false;
  /** True while a scrubber drag is in progress: `syncProgress` must not fight the knob the viewer is holding. */
  private scrubbing = false;

  connectedCallback(): void {
    if (this.root) return;
    this.root = this.attachShadow({ mode: "open" });
    this.render();
    this.wire();
    if (this.hasAttribute("autoplay")) void this.start();
  }

  disconnectedCallback(): void {
    // Tearing down on unmount is the whole reason a scroll feed of these doesn't leak playbacks: `stop()`
    // cancels in-flight fetches and detaches the MediaSource.
    void this.handle?.stop();
    this.handle = undefined;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "poster" && this.els.poster) {
      this.els.poster.style.backgroundImage = value ? `url("${value}")` : "";
    }
  }

  private render(): void {
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);

    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.setAttribute("part", "video");
    if (this.hasAttribute("muted")) this.video.muted = true;
    if (this.hasAttribute("loop")) this.video.loop = true;
    this.root.append(this.video);

    // NOTE: never touch `this.root.innerHTML` after appending nodes. The ShadowRoot innerHTML setter runs
    // "replace all" — even for `+= ""` — which serialises and re-parses the subtree, so the <style> and
    // <video> appended above are replaced by fresh nodes. `this.video` would then hold a detached element:
    // the SDK would feed a MediaSource into an orphan while the viewer watched an empty <video>, with no
    // error anywhere. Build the tree with append() only.
    const mk = (tag: string, cls: string, part?: string): HTMLElement => {
      const e = document.createElement(tag);
      e.className = cls;
      if (part) e.setAttribute("part", part);
      return e;
    };

    const poster = mk("div", "poster", "poster");
    const p = this.getAttribute("poster");
    if (p) poster.style.backgroundImage = `url("${p}")`;
    this.root.append(poster);

    const layer = mk("div", "layer");
    const status = mk("div", "badge", "status");
    status.style.display = "none";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const err = mk("div", "err", "error");
    err.style.display = "none";
    err.setAttribute("role", "alert");
    layer.append(status, err);
    this.root.append(layer);

    const bar = mk("div", "bar", "controls");
    const row = mk("div", "row");

    const play = mk("button", "", "play-button") as HTMLButtonElement;
    play.type = "button";
    play.setAttribute("aria-label", "Play");
    play.textContent = "▶";

    const cur = mk("span", "time", "time-current");
    cur.textContent = "0:00";
    const dur = mk("span", "time", "time-duration");
    dur.textContent = "--:--"; // honest until the grant reports a real length

    // The scrubber is a real slider to assistive tech, not a div with a click handler — so arrow keys, screen
    // readers, and voice control all address it without us writing anything bespoke.
    const scrub = mk("div", "scrub", "scrubber");
    scrub.tabIndex = 0;
    scrub.setAttribute("role", "slider");
    scrub.setAttribute("aria-label", "Seek");
    scrub.setAttribute("aria-valuemin", "0");
    scrub.setAttribute("aria-valuenow", "0");
    scrub.setAttribute("aria-valuetext", "0:00");
    const track = mk("div", "track");
    const buffered = mk("div", "buffered", "buffered");
    const played = mk("div", "played", "played");
    const knob = mk("div", "knob");
    track.append(buffered, played, knob);
    scrub.append(track);

    const mute = mk("button", "", "mute-button") as HTMLButtonElement;
    mute.type = "button";
    mute.setAttribute("aria-label", "Mute");
    mute.textContent = "🔊";

    const full = mk("button", "", "fullscreen-button") as HTMLButtonElement;
    full.type = "button";
    full.setAttribute("aria-label", "Fullscreen");
    full.textContent = "⛶";

    row.append(play, cur, scrub, dur, mute, full);
    bar.append(row);
    this.root.append(bar);

    this.els = { poster, status, err, bar, play, cur, dur, scrub, buffered, played, knob, mute, full };
  }

  private wire(): void {
    const v = this.video;
    const { play, scrub, mute, full } = this.els;

    play.addEventListener("click", () => void this.toggle());
    mute.addEventListener("click", () => {
      v.muted = !v.muted;
      this.syncMute();
    });
    full.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.requestFullscreen?.();
    });

    // Scrubbing COMMITS on release, not on every pointer sample.
    //
    // Assigning `currentTime` during a drag fires a `seeking` event each time, and the SDK answers each one
    // with a mint round trip. A ~0.7s drag samples ~50 times: that alone exhausts the per-playback seek budget
    // (60/min), so every subsequent seek 429s and the viewer is told "Can't skip there" on a tenant that has
    // seeking enabled — and each request that does land signs a fresh 15-segment window against the session's
    // acquisition budget. During the drag we only move the visual knob; one real seek happens on pointerup.
    const posFor = (clientX: number): number => {
      const r = scrub.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return ratio * this.durationSec;
    };
    const preview = (clientX: number) => {
      if (!this.durationSec) return;
      const pct = (posFor(clientX) / this.durationSec) * 100;
      this.els.played.style.width = `${pct}%`;
      this.els.knob.style.left = `${pct}%`;
      this.els.cur.textContent = formatTime(posFor(clientX));
    };
    scrub.addEventListener("pointerdown", (e) => {
      if (!this.durationSec) return;
      const ev = e as PointerEvent;
      scrub.setPointerCapture(ev.pointerId);
      this.scrubbing = true;
      preview(ev.clientX);
      const move = (m: PointerEvent) => preview(m.clientX);
      const finish = (u: PointerEvent) => {
        // Detach FIRST, and on every terminal event — pointerup, pointercancel, and lostpointercapture. A
        // drag that ends off-element (or is cancelled by the browser) previously left `pointermove` attached,
        // so afterwards merely hovering the bar scrubbed the video.
        scrub.removeEventListener("pointermove", move);
        scrub.removeEventListener("pointerup", finish);
        scrub.removeEventListener("pointercancel", finish);
        scrub.removeEventListener("lostpointercapture", finish);
        this.scrubbing = false;
        v.currentTime = posFor(u.clientX ?? ev.clientX); // the one real seek
      };
      scrub.addEventListener("pointermove", move);
      scrub.addEventListener("pointerup", finish);
      scrub.addEventListener("pointercancel", finish);
      scrub.addEventListener("lostpointercapture", finish);
    });

    // Keyboard: the conventional set, so the element behaves the way a viewer already expects.
    this.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      const nudge = (d: number) => {
        v.currentTime = Math.max(0, Math.min(this.durationSec || v.currentTime + d, v.currentTime + d));
        e.preventDefault();
      };
      if (k === " " || k === "k") {
        void this.toggle();
        e.preventDefault();
      } else if (k === "ArrowRight") nudge(5);
      else if (k === "ArrowLeft") nudge(-5);
      else if (k === "m") {
        v.muted = !v.muted;
        this.syncMute();
      } else if (k === "f") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void this.requestFullscreen?.();
      }
    });

    for (const ev of ["timeupdate", "progress", "seeking", "seeked", "durationchange"]) {
      v.addEventListener(ev, () => this.syncProgress());
    }
    v.addEventListener("play", () => this.syncPlay());
    v.addEventListener("pause", () => this.syncPlay());
    v.addEventListener("waiting", () => this.setStatus("Buffering…", true));
    v.addEventListener("playing", () => this.setStatus(""));
    v.addEventListener("ended", () => this.syncPlay());
  }

  /** Start playback. Idempotent — a second call while already playing is a no-op. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const cfg: BrowserPlayerConfig = {
      mint: this.getAttribute("mint") ?? "",
      edge: this.getAttribute("edge") ?? "",
      tid: this.getAttribute("tid") ?? "",
      handshakeSecret: this.handshakeSecret ?? b64uToBytes(this.getAttribute("handshake-secret") ?? ""),
      onState: (s) => this.onPlayerState(s),
    };
    this.player = new TegisPlayer(cfg);
    this.setStatus("Loading…", true);
    try {
      this.handle = await this.player.play(this.video, {
        assetId: this.getAttribute("asset") ?? "",
        entitlement: this.getAttribute("entitlement") ?? "",
        muted: this.hasAttribute("muted"),
        loop: this.hasAttribute("loop"),
        onError: (e) => this.onPlayError(e),
        onFirstFrame: () => {
          this.els.poster.style.display = "none";
          this.setStatus("");
        },
      });
      // An autoplay that fell back to muted needs an affordance, or the viewer sits through silent video
      // assuming it's broken.
      if (this.handle.autoplay === "muted") this.setStatus("Muted — tap to unmute", true);
      if (this.handle.autoplay === "blocked") this.setStatus("Tap to play", true);
      this.durationSec = this.handle.duration ?? 0;
      this.syncProgress();
      this.syncPlay();
    } catch (e) {
      this.started = false;
      this.showError(e instanceof Error ? e.message : "Playback failed");
    }
  }

  private async toggle(): Promise<void> {
    if (!this.started) return void this.start();
    if (this.video.paused) {
      this.setStatus("");
      await this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  }

  /** Render the SDK's JIT state. `preparing` is the cold-start case: the asset is being packaged on demand,
   *  and the viewer deserves to be told that rather than watching an unexplained spinner. */
  private onPlayerState(s: PlayerState): void {
    if (s.state === "preparing") {
      // Prefer REAL progress from the origin over a guess derived from the retry budget. "Preparing… 43%"
      // answers the viewer's actual question; "up to 30s" is only a ceiling on our own retry loop and can be
      // wildly wrong in either direction.
      if (s.progress !== undefined) {
        this.setStatus(`Preparing… ${Math.round(s.progress * 100)}%`, true);
      } else if (s.producedThrough !== undefined) {
        this.setStatus(`Preparing… ${s.producedThrough} segments ready`, true);
      } else {
        const eta = Math.ceil((s.retryAfterMs * (s.maxAttempts - s.attempt + 1)) / 1000);
        this.setStatus(`Preparing… up to ${eta}s`, true);
      }
    } else {
      this.setStatus("");
    }
  }

  private onPlayError(e: PlayError): void {
    // A refused seek is not fatal — playback continues where it was, so it gets a transient note, not the
    // error surface.
    if (e.code === "seek_refused") {
      this.setStatus("Can't skip there", true);
      setTimeout(() => this.setStatus(""), 2500);
      return;
    }
    this.showError(e.message);
  }

  private setStatus(text: string, spinner = false): void {
    const el = this.els.status;
    el.style.display = text ? "block" : "none";
    el.replaceChildren(); // not innerHTML — this component builds and clears DOM through node APIs only
    if (text && spinner) {
      const sp = document.createElement("div");
      sp.className = "spinner";
      sp.style.margin = "0 auto 8px";
      el.append(sp);
    }
    if (text) el.append(document.createTextNode(text));
  }

  private showError(msg: string): void {
    this.els.err.style.display = "block";
    this.els.err.textContent = msg;
    this.setStatus("");
  }

  private syncPlay(): void {
    const playing = !this.video.paused && !this.video.ended;
    this.els.play.textContent = playing ? "❚❚" : "▶";
    this.els.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    this.els.bar.dataset.show = playing ? "0" : "1"; // keep controls up while paused
  }

  private syncMute(): void {
    this.els.mute.textContent = this.video.muted ? "🔇" : "🔊";
    this.els.mute.setAttribute("aria-label", this.video.muted ? "Unmute" : "Mute");
  }

  private syncProgress(): void {
    if (this.scrubbing) return; // the viewer owns the knob mid-drag; playback events must not yank it back
    const v = this.video;
    // The asset's length comes from the GRANT and nowhere else. `video.duration` is not a fallback: under MSE
    // it tracks the buffered end, so on any asset whose shape hasn't been published it reports a few seconds
    // and climbs. Rendering that would show "0:06" for a two-hour film, pin the buffered bar at 100%, and map
    // the scrubber's full width onto six seconds — the far right of the bar seeking to six seconds in.
    //
    // When the length is unknown we say so: "--:--", an indeterminate scrubber, and no seeking. That is the
    // honest state, and it is visibly different from a real duration, which is what makes a missing backfill
    // obvious instead of silently wrong.
    const d = this.durationSec;
    this.els.cur.textContent = formatTime(v.currentTime);
    this.els.dur.textContent = d ? formatTime(d) : "--:--";
    const pct = d ? (v.currentTime / d) * 100 : 0;
    this.els.played.style.width = `${pct}%`;
    this.els.knob.style.left = `${pct}%`;
    let end = 0;
    for (let i = 0; i < v.buffered?.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.25) end = Math.max(end, v.buffered.end(i));
    }
    this.els.buffered.style.width = d ? `${Math.min(100, (end / d) * 100)}%` : "0";
    const scrub = this.els.scrub;
    // An unknown length means the slider has no meaningful range: expose it as disabled rather than as a
    // 0..0 slider that assistive tech would announce as a real, seekable control.
    if (d) {
      scrub.removeAttribute("aria-disabled");
      scrub.setAttribute("aria-valuemax", String(Math.floor(d)));
      scrub.setAttribute("aria-valuenow", String(Math.floor(v.currentTime)));
      scrub.setAttribute("aria-valuetext", `${formatTime(v.currentTime)} of ${formatTime(d)}`);
    } else {
      scrub.setAttribute("aria-disabled", "true");
      scrub.removeAttribute("aria-valuemax");
      scrub.setAttribute("aria-valuetext", `${formatTime(v.currentTime)}, total length unknown`);
    }
  }
}

/** Register `<tegis-player>`. Safe to call more than once, and a no-op outside a browser. */
export function defineTegisPlayer(tag = "tegis-player"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, TegisPlayerElement);
}

if (typeof customElements !== "undefined") defineTegisPlayer();
