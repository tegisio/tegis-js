# @tegis/player

Browser player SDK for **Tegis** — the content-protection gateway for video. It runs the protected hot
path in the browser: **attest → handshake → mint → renew**, then decrypts and plays segments with
WebCrypto (AES-CTR) over Media Source Extensions. The player **never holds a tenant key** — only a
short-lived attestation and playback grant.

The crypto/fetch/decrypt core runs identically in the browser and in Bun (for headless e2e); the MSE
glue is browser-only and guarded.

## Install

```sh
bun add @tegis/player
```

## Usage

```ts
import { TegisPlayer, loadWasmHandshake } from "@tegis/player";

// 1. (Recommended) load the WASM handshake so the per-session signature is computed inside an opaque
//    module rather than a one-line JS HMAC. `handshakeSecret` is delivered by Tegis (WASM-whitened in prod).
const wasm = await fetch(new URL("@tegis/player/wasm/hmac-sha256.wasm", import.meta.url)).then(r => r.arrayBuffer());
const handshakeFn = await loadWasmHandshake(handshakeSecret, wasm);

const player = new TegisPlayer({
  mint: "https://your-tenant.tegis.io",   // your tenant CNAME (mint endpoint)
  edge: "https://your-tenant.tegis.io",   // edge / CDN base
  tid: "t_yourtenant",
  handshakeSecret,                         // Uint8Array, delivered by Tegis
  handshakeFn,                             // optional WASM override (falls back to WebCrypto)
});

// `entitlement` comes from your backend via @tegis/server.
const video = document.querySelector("video")!;
await player.play(video, { assetId, entitlement });
```

For best join-time, call `player.prewarm()` at page load (solves the bot-wall off the click→play path).

## API

- `new TegisPlayer(config: BrowserPlayerConfig)`
- `.prewarm(opts?)` — pre-solve attestation and hold it
- `.play(video, { assetId, entitlement, ... })` — full hot path + MSE playback
- `.mint(...)`, `.renew(...)`, `.decryptedSegment(...)` — lower-level steps
- `loadWasmHandshake(secret, wasmBytes)` / `loadWhitenedHandshake(wasmBytes)` — build a `HandshakeFn`

A `@tegis/player/bundle` entry exposes `TegisPlayer` on `globalThis` for `<script>`-tag use.

## Browser support

Playback requires **real Chrome** (H.264 + MSE) — see the Tegis docs for the supported-browser matrix.
Surface a clear unsupported-browser message to viewers on other engines.

MIT © Tegis
