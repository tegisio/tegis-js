// WASM handshake loader (Gate-F F1): instantiates the SHA-256/HMAC WASM module and returns a
// `handshakeFn` the player uses, so the per-session handshake is computed inside the opaque module
// (obfuscation-grade — a scraper must run our WASM, not a one-line JS HMAC). The output is byte-identical
// to the WebCrypto path (wasm-handshake.test.ts proves it), so the Go mint accepts it unchanged. In
// production the WASM is additionally whitened/rotated; this is the functional reference.

import { b64u } from "./crypto.ts";

export type HandshakeFn = (att: string, ent: string, nonce: string, t: number) => Promise<string>;

/**
 * Build a WASM-backed handshake function bound to the tenant's handshake secret. `wasmBytes` is the
 * compiled hmac-sha256.wasm (embedded in the bundle, or fetched).
 */
export async function loadWasmHandshake(secret: Uint8Array, wasmBytes: BufferSource): Promise<HandshakeFn> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { abort: () => { throw new Error("wasm abort"); } },
  });
  const ex = instance.exports as any;
  const te = new TextEncoder();
  const mem = () => new Uint8Array(ex.memory.buffer); // re-read: heap.alloc can grow (and detach) the buffer

  function write(data: Uint8Array): number {
    const p = ex.alloc(data.length);
    mem().set(data, p);
    return p;
  }
  function sha256(data: Uint8Array): Uint8Array {
    const p = write(data);
    const out = ex.alloc(32);
    ex.sha256(p, data.length, out);
    return mem().slice(out, out + 32);
  }
  function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
    const kp = write(key);
    const mp = write(msg);
    const out = ex.alloc(32);
    ex.hmac(kp, key.length, mp, msg.length, out);
    return mem().slice(out, out + 32);
  }

  return async (att, ent, nonce, t) => {
    const entDigest = b64u(sha256(te.encode(ent))); // sha256 of the entitlement, in WASM
    const msg = te.encode(`${att}.${entDigest}.${nonce}.${t}`);
    return b64u(hmac(secret, msg)); // HMAC-SHA256, in WASM
  };
}

/**
 * F9: load a per-tenant WHITENED module (src/whiten.ts output). Unlike loadWasmHandshake, it takes NO
 * secret — the tenant's HMAC key lives inside the module as split ipad/opad midstates and never crosses
 * the JS↔WASM boundary. The module exports `sha256` (pure, for the entitlement digest) and `signKeyed`
 * (HMAC with the baked key). Output is byte-identical to HMAC-SHA256(hs_tenant, msg), so the mint accepts it.
 */
export async function loadWhitenedHandshake(wasmBytes: BufferSource): Promise<HandshakeFn> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { abort: () => { throw new Error("wasm abort"); } },
  });
  const ex = instance.exports as any;
  const te = new TextEncoder();
  const mem = () => new Uint8Array(ex.memory.buffer);
  function write(data: Uint8Array): number {
    const p = ex.alloc(data.length);
    mem().set(data, p);
    return p;
  }
  function call(fn: (p: number, l: number, o: number) => void, data: Uint8Array): Uint8Array {
    const p = write(data);
    const out = ex.alloc(32);
    fn(p, data.length, out);
    return mem().slice(out, out + 32);
  }
  return async (att, ent, nonce, t) => {
    const entDigest = b64u(call(ex.sha256, te.encode(ent)));
    const msg = te.encode(`${att}.${entDigest}.${nonce}.${t}`);
    return b64u(call(ex.signKeyed, msg)); // HMAC with the BAKED key — no secret passed in
  };
}
