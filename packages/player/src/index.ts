// @tegis/player — public entry.
// The browser hot path: attest → (WASM) handshake → mint → renew, with WebCrypto AES-CTR segment
// playback over MSE. Never holds a tenant key — only a short-lived attestation + grant.
export { TegisPlayer } from "./player.ts";
export type {
  BrowserPlayerConfig,
  Grant,
  JitConfig,
  PlayerState,
  PreparingState,
  ReadyState,
  PlayOpts,
  PlaybackHandle,
  PlayError,
} from "./player.ts";
export { loadWasmHandshake, loadWhitenedHandshake } from "./handshake-wasm.ts";
export type { HandshakeFn } from "./handshake-wasm.ts";

// SDK build version — lets consumers introspect which @tegis/player they're running. Kept in sync with
// package.json by the release workflow's version bump.
export const VERSION = "0.2.6";
