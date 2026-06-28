// @tegis/server — backend SDK (Node/Bun). The tenant's own server uses this to mint short-lived
// entitlement JWTs signed with the tenant's key; Aegis validates them against the registered JWKS
// (ADR-D3) and never holds the key. Reference imports the repo's jose helper; a published SDK bundles
// its own crypto. The tenant private key NEVER leaves the tenant backend / never reaches the browser.

import { jwsSign } from "./crypto/jose.ts";

export interface TegisServerConfig {
  tid: string;
  issuer: string;
  jwksKid: string;
  signSeed: Buffer; // the tenant's JWKS private seed (held by the tenant)
  ttlSeconds?: number;
}

export class TegisServer {
  constructor(private cfg: TegisServerConfig) {}

  /** Mint a short-lived entitlement JWT authorizing one viewer to play one asset. */
  mintEntitlement(sub: string, assetId: string, opts?: { maxRes?: string; drm?: string }): string {
    const now = Math.floor(Date.now() / 1000);
    return jwsSign(
      { typ: "JWT", kid: this.cfg.jwksKid },
      {
        iss: this.cfg.issuer,
        tid: this.cfg.tid,
        sub,
        aud: assetId,
        ent: { maxRes: opts?.maxRes ?? "1080p", drm: opts?.drm ?? "none" },
        iat: now,
        exp: now + (this.cfg.ttlSeconds ?? 300),
      },
      this.cfg.signSeed,
    );
  }
}
