// contentKey source selection: the AES content key must come from the mint grant's single-use SIGNED URL
// (grant.key) when the edge enforces AEGIS_KEY_REQUIRE_SIGNED — the att-gated bearer endpoint is 403'd there.
// Falls back to the att endpoint when no signed URL is provided. Run: `bun test` from root. See issue #7.

import { test, expect } from "bun:test";
import { TegisPlayer } from "../src/player.ts";

// A 16-byte AES key (bytes 0..15) as base64url — the shape the key endpoint returns.
const KEY_B64U = "AAECAwQFBgcICQoLDA0ODw";

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

function capturingFetch(seen: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ key: KEY_B64U }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("contentKey fetches the signed grant.key URL when provided, not the att endpoint", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const p = mkPlayer(capturingFetch(seen));
  const signed = "https://cdn.example/key/abc?exp=1&sig=xyz";
  const key = await p.contentKey("ast_1", undefined, signed);
  expect(seen.map((s) => s.url)).toEqual([signed]);
  expect(key).toEqual(new Uint8Array(Array.from({ length: 16 }, (_, i) => i)));
});

test("contentKey sends NO auth headers on the signed URL (preflight-free simple GET)", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const p = mkPlayer(capturingFetch(seen));
  await p.contentKey("ast_1", undefined, "https://cdn.example/key/abc?sig=xyz");
  expect(seen[0]?.init?.headers).toBeUndefined();
});

test("contentKey resolves a relative signed URL against the mint origin", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const p = mkPlayer(capturingFetch(seen));
  await p.contentKey("ast_1", undefined, "/key/abc?sig=xyz");
  expect(seen[0]?.url).toBe("https://m/key/abc?sig=xyz");
});

test("contentKey falls back to the att-gated endpoint when no signed URL is given", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const p = mkPlayer(capturingFetch(seen));
  await p.contentKey("ast_1");
  expect(seen[0]?.url).toContain("/key/v1/ast_1?att=");
});
