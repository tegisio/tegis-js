# Tegis SDKs

Official JavaScript/TypeScript SDKs for **[Tegis](https://tegis.io)** — the content-protection gateway for
video. Tegis makes automated bulk acquisition uneconomic while keeping viewer join-time near-native.

| Package | What it does |
|---------|--------------|
| **[`@tegis/server`](./packages/server)** | Backend SDK — mint short-lived, signed entitlement grants. Your tenant key never leaves your server. |
| **[`@tegis/player`](./packages/player)** | Browser SDK — the protected hot path (attest → handshake → mint → renew) with WebCrypto AES-CTR segment playback. Holds no keys. |

```sh
bun add @tegis/server   # backend
bun add @tegis/player   # browser
```

See the **[30-minute quickstart](./examples/quickstart)** for an end-to-end integration, and each package's
README for its API.

## This repo

These are the **public SDKs only** — the Tegis engine (data plane, control plane, DRM/watermark internals)
is closed-source. The crypto each package needs is vendored, so the packages are fully self-contained; a
golden-vector parity test (`packages/server`) keeps the bundled crypto byte-identical to the gateway's canon.

Releases are published to npm from CI with [build provenance](https://docs.github.com/actions/security-guides/using-artifact-attestations)
— verify any tarball with `gh attestation verify <tarball> --repo tegisio/tegis-js`.

MIT © okbrk
