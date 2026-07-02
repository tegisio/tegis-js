// QoE beacon (visibility backlog V5 / BACKLOG-3): the player measures TTFF (play-requested → first frame),
// the JIT `preparing` clock (occurrences + total waited ms), and rebuffer count, then sends ONE `client.qoe`
// beacon per playback down the SAME client-event path as the funnel beacons (POST `/evt/v1`, `{ses,pbk,ast,
// step}` envelope; edge maps `step:"qoe"` → `client.qoe`). These tests inject BOTH the clock (a stepped fake
// `now()`) and the transport (a scripted fetch that records `/evt/v1` beacon bodies), plus a recording sleep
// so the JIT backoff runs instantly — no real timers, no real network, fully deterministic. Bun has no
// `navigator.sendBeacon`, so the beacon falls back to the injected `fetchImpl`. Lives under test/ (not src/)
// so the player `tsc --noEmit` (include: src) never resolves `bun:test`. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { TegisPlayer } from "../src/player.ts";
import { QoeCollector } from "../src/qoe.ts";

type Jit = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
const DEFAULT_JIT: Jit = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 };
type Beacon = Record<string, unknown>;

// Harness: scripted fetch for segment fetches (queue, last entry repeats) + a recorder for `/evt/v1` beacon
// POSTs, a recording sleep (instant backoff), and an optional injectable stepped clock for TTFF. Telemetry
// stays ON (the default) so the QoE beacon actually lands on the injected fetch; QoE beacons are isolated by
// `step === "qoe"` (the funnel `preparing` beacon shares the same endpoint).
function makePlayer(responses: Array<() => Response>, opts: { jit?: Jit; now?: () => number } = {}) {
  const jit = opts.jit ?? DEFAULT_JIT;
  const beacons: Beacon[] = [];
  const delays: number[] = [];
  let segCalls = 0;
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.endsWith("/evt/v1")) {
      beacons.push(JSON.parse(String(init?.body ?? "{}")) as Beacon);
      return new Response(null, { status: 204 });
    }
    const make = responses[Math.min(segCalls, responses.length - 1)]!;
    segCalls++;
    return make();
  }) as typeof fetch;
  const player = new TegisPlayer({
    mint: "https://mint.test",
    edge: "https://edge.test",
    tid: "ten_TEST",
    handshakeSecret: new Uint8Array(32),
    fetchImpl,
    now: opts.now,
    delayFn: async (ms) => {
      delays.push(ms);
    },
    jit,
  });
  return { player, beacons, delays, segCalls: () => segCalls };
}

const preparing = (retryAfter?: string) => () =>
  new Response(null, { status: 503, headers: retryAfter != null ? { "retry-after": retryAfter } : {} });
const ready = (bytes: Uint8Array) => () => new Response(bytes, { status: 200 });
const qoeOf = (beacons: Beacon[]): Beacon[] => beacons.filter((b) => b.step === "qoe");

test("QoeCollector: TTFF math, hasStarted gate, preparing + rebuffer accumulation, reset", () => {
  let t = 500;
  const c = new QoeCollector(() => t);
  expect(c.snapshot()).toEqual({ ttff_ms: 0, preparing_count: 0, preparing_ms: 0, rebuffer_count: 0 });
  expect(c.hasStarted()).toBe(false);

  c.markPlayRequested(); // t = 500
  t = 500 + 337.6; // fractional elapsed → rounds
  c.markFirstFrame();
  expect(c.hasStarted()).toBe(true);

  c.addPreparing(1500);
  c.addPreparing(500);
  c.addPreparing(-10); // non-positive wait → 0 ms, still counts as an occurrence
  c.addRebuffer();
  c.addRebuffer();

  expect(c.snapshot()).toEqual({ ttff_ms: 338, preparing_count: 3, preparing_ms: 2000, rebuffer_count: 2 });

  c.reset();
  expect(c.snapshot()).toEqual({ ttff_ms: 0, preparing_count: 0, preparing_ms: 0, rebuffer_count: 0 });
  expect(c.hasStarted()).toBe(false);
});

test("QoeCollector: a first-frame mark before any play-request is ignored (no phantom/negative TTFF)", () => {
  let t = 100;
  const c = new QoeCollector(() => t);
  c.markFirstFrame(); // no play requested yet → ignored
  expect(c.hasStarted()).toBe(false);
  expect(c.snapshot().ttff_ms).toBe(0);
  c.markPlayRequested(); // t = 100
  t = 250;
  c.markFirstFrame(); // t = 250 → 150ms
  expect(c.snapshot().ttff_ms).toBe(150);
});

test("TTFF: an injected clock spans play-requested → first-frame; the beacon carries the exact ttff_ms", () => {
  let t = 1_000;
  const h = makePlayer([], { now: () => t });
  const p = h.player as unknown as {
    qoe: { markPlayRequested(): void; markFirstFrame(): void };
    emitQoe(): void;
  };
  p.qoe.markPlayRequested(); // t = 1000
  t = 1_420;
  p.qoe.markFirstFrame(); // t = 1420 → TTFF 420
  p.emitQoe();
  const qoe = qoeOf(h.beacons)[0];
  expect(qoe).toBeDefined();
  expect(qoe!.ttff_ms).toBe(420);
});

test("preparing (503 + Retry-After) → the qoe beacon's preparing_count / preparing_ms reflect the injected waits", async () => {
  // 3× preparing (Retry-After: 2s, uncapped) then the real bytes → 3 occurrences totalling 6000ms.
  const h = makePlayer([preparing("2"), preparing("2"), preparing("2"), ready(new Uint8Array([1]))], {
    jit: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 5000 },
  });
  await h.player.fetchBytes("/seg/0.m4s");
  expect(h.delays).toEqual([2000, 2000, 2000]); // sanity: the injected backoffs

  (h.player as unknown as { emitQoe(): void }).emitQoe();
  const qoe = qoeOf(h.beacons)[0];
  expect(qoe).toBeDefined();
  expect(qoe!.preparing_count).toBe(3);
  expect(qoe!.preparing_ms).toBe(6000);
  expect(qoe!.rebuffer_count).toBe(0);
  expect(qoe!.ttff_ms).toBe(0); // no first frame in this fetch-only flow
});

test("single-send: two terminal triggers (completed then pagehide) emit exactly ONE client.qoe beacon", () => {
  const h = makePlayer([]);
  const p = h.player as unknown as { evtSes?: string; evtPbk?: string; evtAst?: string; emitQoe(): void };
  p.evtSes = "ses_abc";
  p.evtPbk = "pbk_xyz";
  p.evtAst = "ast_1";
  p.emitQoe(); // terminal #1: completed / error
  p.emitQoe(); // terminal #2: pagehide / visibilitychange — idempotent via the `sent` flag
  expect(qoeOf(h.beacons).length).toBe(1);
});

test("envelope: the qoe beacon mirrors the funnel ids/shape and carries no geo / IP / UA", () => {
  const h = makePlayer([]);
  const p = h.player as unknown as {
    evtSes?: string;
    evtPbk?: string;
    evtAst?: string;
    qoe: { markPlayRequested(): void };
    emitQoe(): void;
  };
  p.evtSes = "ses_abc";
  p.evtPbk = "pbk_xyz";
  p.evtAst = "ast_1";
  p.qoe.markPlayRequested();
  p.emitQoe();
  const qoe = qoeOf(h.beacons)[0]!;
  expect(qoe).toBeDefined();

  // Same envelope ids as a funnel beacon, routed by `step`.
  expect(qoe).toMatchObject({ ses: "ses_abc", pbk: "pbk_xyz", ast: "ast_1", step: "qoe" });
  // The four pinned QoE metrics, all numeric.
  for (const k of ["ttff_ms", "preparing_count", "preparing_ms", "rebuffer_count"]) {
    expect(qoe).toHaveProperty(k);
    expect(typeof qoe[k]).toBe("number");
  }
  // No geo / IP / UA — the gateway stamps viewer country server-side (D3).
  for (const k of ["cty", "country", "geo", "ip", "clientIp", "ua", "userAgent"]) {
    expect(qoe).not.toHaveProperty(k);
  }
  // Exact key set: the funnel envelope ids + the QoE metrics, nothing else.
  expect(Object.keys(qoe).sort()).toEqual(
    ["ast", "pbk", "preparing_count", "preparing_ms", "rebuffer_count", "ses", "step", "ttff_ms"].sort(),
  );
});
