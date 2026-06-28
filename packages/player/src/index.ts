// @tegis/player — public entry.
// The browser hot path: attest → (WASM) handshake → mint → renew, with WebCrypto AES-CTR segment
// playback over MSE. Never holds a tenant key — only a short-lived attestation + grant.
export { TegisPlayer } from "./player.ts";
export type { BrowserPlayerConfig, Grant } from "./player.ts";
export { loadWasmHandshake, loadWhitenedHandshake } from "./handshake-wasm.ts";
export type { HandshakeFn } from "./handshake-wasm.ts";
