# Changelog

All notable changes to `@tegis/player` are documented here. This project follows [semver](https://semver.org).

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
