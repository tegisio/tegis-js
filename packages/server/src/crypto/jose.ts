// jose.ts — minimal compact EdDSA JWS (att, entitlement, grant tokens). Zero deps.
// Real deployments may use `jose`; this keeps the reference self-contained.

import { signEd25519, verifyEd25519, b64u, unb64u, utf8 } from "./ed25519.ts";

export function jwsSign(header: Record<string, unknown>, payload: Record<string, unknown>, seed: Buffer): string {
  const signingInput = `${b64u(utf8(JSON.stringify({ alg: "EdDSA", ...header })))}.${b64u(utf8(JSON.stringify(payload)))}`;
  return `${signingInput}.${b64u(signEd25519(seed, utf8(signingInput)))}`;
}

export function jwsVerify(token: string, pubRaw: Buffer): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!verifyEd25519(pubRaw, utf8(`${h}.${p}`), unb64u(s))) return null;
  try {
    return JSON.parse(unb64u(p).toString("utf8"));
  } catch {
    return null;
  }
}
