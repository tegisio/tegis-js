// WebCrypto primitives for the real browser player (Gate-F F1). NO node:crypto — these run in the
// browser and, identically, in Bun for the headless e2e. The handshake formula and the AES-CTR segment
// scheme are FROZEN: they must reproduce, byte-for-byte, what the Go mint verifies (verifyHandshake) and
// what the Go packager produced (encryptCTR: IV(16) ‖ AES-128-CTR). WebCrypto AES-CTR with length=128
// matches Go's full-128-bit-block counter (cipher.NewCTR), so decryption is exact.

const te = new TextEncoder();

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(secret: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
}

export async function sha256b64u(s: string): Promise<string> {
  return b64u(await crypto.subtle.digest("SHA-256", te.encode(s)));
}

/**
 * The per-session handshake — HMAC(secret, `att.sha256(ent)b64u.nonce.t`) — identical to the Go mint's
 * verifyHandshake. In production this runs inside the WASM module (F1 §8, obfuscation-grade); this
 * WebCrypto path is the reference/fallback and proves byte-parity with the mint.
 */
export async function handshake(secret: Uint8Array, att: string, ent: string, nonce: string, t: number): Promise<string> {
  const d = await sha256b64u(ent);
  return b64u(await hmacSha256(secret, `${att}.${d}.${nonce}.${t}`));
}

/** Heartbeat signature for the renewal loop — HMAC(hbKey, canonical-heartbeat-json). */
export async function hbSign(hbKeyB64u: string, hbJSON: string): Promise<string> {
  return b64u(await hmacSha256(unb64u(hbKeyB64u), hbJSON));
}

/**
 * Decrypt a reference segment: blob = IV(16) ‖ AES-128-CTR(key, plaintext). Returns the plaintext fMP4.
 * (F7 will add an EME clear-key path for ISO-CENC; this manual path is the launch decrypt for the
 * whole-segment-CTR packaging the reference produces today.)
 */
export async function decryptSegment(keyRaw: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const iv = blob.slice(0, 16);
  const ct = blob.slice(16);
  const key = await crypto.subtle.importKey("raw", keyRaw as BufferSource, { name: "AES-CTR" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CTR", counter: iv as BufferSource, length: 128 }, key, ct as BufferSource);
  return new Uint8Array(pt);
}
