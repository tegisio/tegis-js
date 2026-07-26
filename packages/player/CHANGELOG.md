# Changelog

All notable changes to `@tegis/player` are documented here. This project follows [semver](https://semver.org).

## [0.1.5]

The first stable in the 0.1.5 line, consolidating the `0.1.5-next.x` work since `0.1.4`.

- **Multi-window playback:** `play()` now renews past the first grant window and streams to the asset's true
  end, instead of stopping after one segment-TTL window. The renewal pump is playback-paced (it renews only as
  the buffer drains, reporting the real playhead) so the mint's realtime pace guard is always satisfied, and it
  runs detached so TTFF and the return contract are unchanged.
- **MSE attach hardening:** attaches the `MediaSource` via `MediaSourceHandle` + `video.srcObject` — the path
  that survives Chrome's removal of `URL.createObjectURL(MediaSource)` — preferring `ManagedMediaSource` where
  present so playback works on **iOS Safari**; falls back to the object URL only where no handle is available.
- **JIT preparing-tolerance:** a cold-segment `503`/`preparing` response is a graceful back-off + retry
  (honoring `Retry-After`), never a playback error, surfaced via a `preparing`/`ready` `onState` hook.
- **QoE + funnel telemetry:** one `client.qoe` beacon per playback (TTFF / preparing / rebuffer) plus the
  play→first-frame→watch-through→complete client funnel steps. Privacy-safe — opaque `ses`/`pbk`/`ast` only.
- **Robustness:** a null-`<video>` guard in `play()`, and a muted-autoplay fallback that reports the outcome
  (`playing`/`muted`/`blocked`) instead of leaving a frozen frame.

## [0.1.2]

- First release from the public `tegisio/tegis-js` repo, published with GitHub build provenance. No API changes.

## [0.1.1]

- **Fix:** `0.1.0` shipped a non-bundled stub `dist/index.js` (a newer `bun build` regressed bundling); the
  entry is now a verified self-contained bundle. Use `>=0.1.1` — `0.1.0` is broken.

## [0.1.0]

Initial extraction from the Tegis reference SDK (formerly the private `@aegis/sdk`).

- `TegisPlayer` — the browser hot path (attest → handshake → mint → renew) with WebCrypto AES-CTR
  segment decryption over MSE.
- `loadWasmHandshake` / `loadWhitenedHandshake` — WASM-backed handshake (obfuscation-grade), byte-identical
  to the WebCrypto path so the Go mint accepts it unchanged. Ships the compiled `wasm/hmac-sha256.wasm`.
- Self-contained: no repo-relative imports.

> Note: demo-only `x-aegis-*` request headers are retained as the current frozen wire contract; a real
> deployment routes by Host and never sets them. Renaming the wire headers is a coordinated server+client
> change, tracked separately from this packaging work.
