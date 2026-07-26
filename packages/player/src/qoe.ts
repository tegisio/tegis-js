// @tegis/player — QoE (quality-of-experience) collector. One instance per player; reset per playback.
// Measures the three viewer-experience signals the region-decision analytics needs (visibility backlog V5 /
// BACKLOG-3): TTFF (play-requested → first frame), the JIT `preparing` clock (occurrences + total waited ms),
// and rebuffer count. Pure + deterministic — the clock is injectable so tests drive it with a fake `now()`.
// Carries NO viewer PII and NO geo: the gateway stamps viewer country server-side (D3), never the client.

/** The three QoE signals for one playback, snapshotted for the `client.qoe` beacon body. Durations in ms. */
export interface QoeSnapshot {
  /** Time-to-first-frame: play-requested → first frame, rounded ms. 0 = a first frame was never reached. */
  ttff_ms: number;
  /** How many times a cold segment came back `preparing` (JIT back-off) during the playback. */
  preparing_count: number;
  /** Total ms waited across all `preparing` back-offs (the sum of the honored retry delays). */
  preparing_ms: number;
  /** Post-start stall cycles (a `waiting` after the first frame) — the rebuffer count. */
  rebuffer_count: number;
  /** Total ms the viewer spent rebuffering after start (sum of `waiting`→`playing` span durations). The
   *  "how bad was it" companion to `rebuffer_count` ("how often"). */
  rebuffer_ms: number;
}

/** Per-playback QoE accumulator. The player feeds it at the funnel / JIT touch-points; `snapshot()` is
 *  emitted once per playback in the `client.qoe` beacon. Call `reset()` at the start of every playback. */
export class QoeCollector {
  private readonly now: () => number;
  private playRequestedAt: number | null = null;
  private firstFrameAt: number | null = null;
  private preparingCount = 0;
  private preparingMs = 0;
  private rebufferCount = 0;
  private rebufferMs = 0;
  private rebufferStartedAt: number | null = null;

  /** @param now injectable monotonic clock (ms). Defaults to `performance.now()` (falls back to `Date.now()`). */
  constructor(now?: () => number) {
    this.now =
      now ??
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now());
  }

  /** Clear every counter for a fresh playback. */
  reset(): void {
    this.playRequestedAt = null;
    this.firstFrameAt = null;
    this.preparingCount = 0;
    this.preparingMs = 0;
    this.rebufferCount = 0;
    this.rebufferMs = 0;
    this.rebufferStartedAt = null;
  }

  /** Stamp the play-request instant (the click / `play_requested` beacon). Opens the TTFF span. */
  markPlayRequested(): void {
    this.playRequestedAt = this.now();
  }

  /** Stamp the first-frame instant (the media element's first `playing`). Idempotent — only the first wins,
   *  and only if a play was requested first (so a stray `playing` can't invent a negative TTFF). */
  markFirstFrame(): void {
    if (this.firstFrameAt == null && this.playRequestedAt != null) this.firstFrameAt = this.now();
  }

  /** True once the first frame has rendered — lets the player tell initial buffering from a rebuffer. */
  hasStarted(): boolean {
    return this.firstFrameAt != null;
  }

  /** Record one JIT `preparing` back-off and the ms it waited (non-finite/negative waits count as 0 ms). */
  addPreparing(waitMs: number): void {
    this.preparingCount++;
    this.preparingMs += Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
  }

  /** Record one post-start rebuffer (a `waiting` after the first frame): increments the count and opens the
   *  duration span. Repeated `waiting`s within one stall keep the same span open (first `waiting` wins). */
  addRebuffer(): void {
    this.rebufferCount++;
    if (this.rebufferStartedAt == null) this.rebufferStartedAt = this.now();
  }

  /** Close an open rebuffer span (the `playing` that resumes it), adding its duration to `rebuffer_ms`.
   *  A no-op when no span is open (a `playing` that isn't ending a stall). */
  endRebuffer(): void {
    if (this.rebufferStartedAt != null) {
      this.rebufferMs += Math.max(0, this.now() - this.rebufferStartedAt);
      this.rebufferStartedAt = null;
    }
  }

  /** The current QoE snapshot for the beacon body. TTFF stays 0 until a first frame is reached. */
  snapshot(): QoeSnapshot {
    const ttff =
      this.playRequestedAt != null && this.firstFrameAt != null
        ? Math.max(0, Math.round(this.firstFrameAt - this.playRequestedAt))
        : 0;
    return {
      ttff_ms: ttff,
      preparing_count: this.preparingCount,
      preparing_ms: Math.round(this.preparingMs),
      rebuffer_count: this.rebufferCount,
      rebuffer_ms: Math.round(this.rebufferMs),
    };
  }
}
