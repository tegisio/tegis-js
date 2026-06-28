# Changelog

All notable changes to `@tegis/server` are documented here. This project follows [semver](https://semver.org).

## [0.1.2]

- First release from the public `tegisio/tegis-js` repo, published with GitHub build provenance. No API changes.

## [0.1.1]

- First working publish. (`0.1.0` did not persist to the registry — a concurrent first-publish race on the
  brand-new `@tegis` scope.) CI now serializes publishes and verifies the bundle is self-contained first.

## [0.1.0]

Initial extraction from the Tegis reference SDK (formerly the private `@aegis/sdk`).

- `TegisServer.mintEntitlement(sub, assetId, opts)` — short-lived, EdDSA-signed entitlement grants.
- Vendored, zero-dependency crypto (Ed25519 + compact JWS) — no repo-relative imports; byte-parity
  with the Go data plane's verifier (golden-vector gate).
