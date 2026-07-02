// JIT tolerance (spec 12 §4.6): the player treats a `preparing` origin response (503 + `Retry-After`, per
// the D1 edge) as graceful back-off + retry — NEVER a playback error — and exposes a `preparing` state hook
// the tenant app can render. These tests inject BOTH the fetch (a scripted queue of Responses) and the
// backoff sleep (a recording no-op), so there is no real network and no real timers: the retry loop runs
// instantly and deterministically. Lives under test/ (not src/) — same as the server golden-parity gate — so
// the player `tsc --noEmit` (include: src) never has to resolve `bun:test`. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { TegisPlayer, type PlayerState, type PreparingState } from "../src/player.ts";

type Jit = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
const DEFAULT_JIT: Jit = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 };

// Minimal harness: a scripted fetch (queue of Response factories, last entry repeats), a state-hook recorder,
// and a recording sleep so backoff is instant. telemetry:false keeps the funnel beacon off the injected fetch
// (so `calls` counts only real segment fetches).
function makePlayer(responses: Array<() => Response>, jit: Jit = DEFAULT_JIT) {
  const states: PlayerState[] = [];
  const delays: number[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    const make = responses[Math.min(calls, responses.length - 1)]!;
    calls++;
    return make();
  }) as typeof fetch;
  const player = new TegisPlayer({
    mint: "https://mint.test",
    edge: "https://edge.test",
    tid: "ten_TEST",
    handshakeSecret: new Uint8Array(32),
    telemetry: false,
    fetchImpl,
    onState: (s) => states.push(s),
    delayFn: async (ms) => {
      delays.push(ms);
    },
    jit,
  });
  return { player, states, delays, calls: () => calls };
}

const preparing = (retryAfter?: string) => () =>
  new Response(null, { status: 503, headers: retryAfter != null ? { "retry-after": retryAfter } : {} });
const preparingMarker = () => () => new Response(null, { status: 202, headers: { "x-tegis-status": "preparing" } });
const ready = (bytes: Uint8Array) => () => new Response(bytes, { status: 200 });
const preps = (states: PlayerState[]): PreparingState[] => states.filter((s): s is PreparingState => s.state === "preparing");

test("preparing (503 + Retry-After) → retries with backoff, fires the state hook, then succeeds with the bytes", async () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  // 3× preparing (Retry-After: 2s) then the real bytes. maxDelayMs high enough that Retry-After isn't capped.
  const h = makePlayer([preparing("2"), preparing("2"), preparing("2"), ready(payload)], {
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 5000,
  });
  const out = await h.player.fetchBytes("/seg/0.m4s");

  expect([...out]).toEqual([1, 2, 3, 4]); // resolved with the real bytes — did NOT throw
  expect(h.calls()).toBe(4); // 3 preparing + 1 success

  const prep = preps(h.states);
  const rdy = h.states.filter((s) => s.state === "ready");
  expect(prep.length).toBe(3);
  expect(rdy.length).toBe(1);

  // The preparing hook fired with the expected shape, honoring Retry-After (2s → 2000ms).
  expect(prep[0]).toMatchObject({ state: "preparing", attempt: 1, maxAttempts: 4, retryAfterMs: 2000 });
  expect(prep[0]!.url).toContain("/seg/0.m4s");
  expect(prep.map((p) => p.attempt)).toEqual([1, 2, 3]);
  expect(h.delays).toEqual([2000, 2000, 2000]);

  // Transitioned back to a ready/normal state once the bytes arrived.
  expect(rdy[0]).toMatchObject({ state: "ready", attempts: 3 });
});

test("exponential backoff when the origin sends no Retry-After, capped at maxDelayMs", async () => {
  const h = makePlayer([preparing(), preparing(), preparing(), ready(new Uint8Array([9]))]);
  await h.player.fetchBytes("https://edge.test/seg/1.m4s");
  // base 10ms doubling → 10, 20, 40 (all under the 100ms cap).
  expect(h.delays).toEqual([10, 20, 40]);
});

test("a large Retry-After is clamped to maxDelayMs (bounded backoff)", async () => {
  const h = makePlayer([preparing("999"), ready(new Uint8Array([0]))]);
  expect(h.delays).toEqual([]); // sanity: nothing waited yet
  await h.player.fetchBytes("/seg/2.m4s");
  expect(h.delays).toEqual([100]); // 999s would be 999000ms — clamped to the 100ms ceiling
  expect(preps(h.states)[0]).toMatchObject({ retryAfterMs: 100 });
});

test("tolerates a non-503 `preparing` marker header too (be-tolerant reading of the origin)", async () => {
  const h = makePlayer([preparingMarker(), preparingMarker(), ready(new Uint8Array([5, 5]))]);
  const out = await h.player.fetchBytes("/seg/3.m4s");
  expect([...out]).toEqual([5, 5]);
  expect(preps(h.states).length).toBe(2);
  expect(h.calls()).toBe(3);
});

test("permanently preparing → bounded retries then a graceful terminal (no crash, no infinite loop)", async () => {
  const h = makePlayer([preparing("1")]); // always preparing
  let threw: unknown;
  try {
    await h.player.fetchBytes("/seg/4.m4s");
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("still preparing");
  expect((threw as Error & { preparing?: boolean }).preparing).toBe(true); // flagged, not a hard failure
  // Exactly maxAttempts (4) preparing retries then give up → 5 fetches, 4 backoffs, 4 hook fires, no ready.
  expect(h.calls()).toBe(5);
  expect(h.delays.length).toBe(4);
  expect(preps(h.states).length).toBe(4);
  expect(h.states.some((s) => s.state === "ready")).toBe(false);
});

test("a genuine non-preparing error (403) still throws immediately — JIT tolerance is not blanket retry", async () => {
  const h = makePlayer([() => new Response(null, { status: 403 })]);
  await expect(h.player.fetchBytes("/seg/5.m4s")).rejects.toThrow("fetch failed 403");
  expect(h.calls()).toBe(1); // no retry on a hard error
  expect(h.states.length).toBe(0); // no preparing hook fired
});

test("the preparing state hook is observable via config.onState with the documented shape", async () => {
  const h = makePlayer([preparing("0"), ready(new Uint8Array([7, 7]))]);
  await h.player.fetchBytes("/seg/6.m4s");
  const prep = preps(h.states)[0];
  expect(prep).toBeDefined();
  expect(prep).toMatchObject({ state: "preparing", attempt: 1, maxAttempts: 4 });
  expect(typeof prep!.retryAfterMs).toBe("number");
  expect(prep!.retryAfterMs).toBe(0); // Retry-After: 0 → 0ms
});
