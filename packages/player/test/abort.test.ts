// AbortSignal plumbing: the fetch/decrypt path forwards the caller's signal so teardown (handle.stop() /
// opts.signal) cancels in-flight segment fetches — not just the loop between them. Run: `bun test` from root.

import { test, expect } from "bun:test";
import { TegisPlayer } from "../src/player.ts";

function mkPlayer(fetchImpl: typeof fetch) {
  return new TegisPlayer({
    mint: "https://m",
    edge: "https://e",
    tid: "ten_x",
    handshakeSecret: new Uint8Array(32),
    fetchImpl,
    telemetry: false,
  });
}

test("fetchBytes forwards the AbortSignal to the fetch impl", async () => {
  let seen: AbortSignal | undefined;
  const p = mkPlayer((async (_url: string, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch);
  const ac = new AbortController();
  await p.fetchBytes("https://e/seg", ac.signal);
  expect(seen).toBe(ac.signal);
});

test("fetchBytes rejects when the fetch impl honors an already-aborted signal", async () => {
  const p = mkPlayer((async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return new Response(new Uint8Array([1]), { status: 200 });
  }) as unknown as typeof fetch);
  const ac = new AbortController();
  ac.abort();
  await expect(p.fetchBytes("https://e/seg", ac.signal)).rejects.toThrow();
});
