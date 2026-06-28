// ed25519.ts — Ed25519 over a raw 32-byte seed, zero npm deps (node:crypto, works in Bun).
// Interoperates byte-for-byte with Go's crypto/ed25519 (both RFC 8032, deterministic).
// Seed → PKCS8 DER via the fixed Ed25519 prefix (RFC 8410), then node:crypto loads it.

import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

// PKCS8 DER prefix for an Ed25519 private key; 32-byte seed is appended.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

// raw 32-byte public key derived from the seed (matches Go's priv.Public()).
export function publicRawFromSeed(seed: Buffer): Buffer {
  const jwk = createPublicKey(privateKeyFromSeed(seed)).export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

export function signEd25519(seed: Buffer, msg: Buffer): Buffer {
  return nodeSign(null, msg, privateKeyFromSeed(seed)); // Ed25519 ⇒ algorithm = null
}

export function verifyEd25519(pubRaw: Buffer, msg: Buffer, sig: Buffer): boolean {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubRaw.toString("base64url") }, format: "jwk" });
  return nodeVerify(null, msg, pub, sig);
}

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
export const unb64u = (s: string) => Buffer.from(s, "base64url");
export const utf8 = (s: string) => Buffer.from(s, "utf8");
