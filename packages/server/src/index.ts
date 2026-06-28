// @tegis/server — public entry.
// Mint short-lived, EdDSA-signed entitlement grants on your backend. The tenant signing key never
// leaves your server and never reaches the browser; Tegis validates grants against your published
// JWKS (ADR-D3). Zero npm dependencies — node:crypto only, byte-parity with the Go data plane.
export { TegisServer } from "./server.ts";
export type { TegisServerConfig } from "./server.ts";
