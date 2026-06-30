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

## Releasing & the demo testbed

Two npm dist-tags gate every release:

- **`latest`** — what `bun add @tegis/player` installs.
- **`next`** — the canary. [demo.tegis.io](https://demo.tegis.io) runs `@tegis/player@next` live, so an
  unreleased build is proven in a real browser before anyone on `latest` gets it.

Publishing is the manual, provenance-attested **publish** Action (Actions → publish → Run workflow). Bump
the version first — npm rejects republishing an existing version.

```sh
# package: player | server | both   ·   tag: next | latest
gh workflow run publish.yml -R tegisio/tegis-js -f package=player -f tag=next
```

The ship → test → promote loop:

1. **Ship to `next`** — make the change, set `packages/player/package.json` to a prerelease
   (`0.1.x-next.N`), push, then dispatch with `tag=next`.
2. **Test on the demo** — the demo host pulls the canary (`bun update @tegis/player`) and restarts;
   verify it in a real browser at [demo.tegis.io](https://demo.tegis.io).
3. **Promote** — bump to the final version (`0.1.x`), push, then dispatch with `tag=latest`. Consumers'
   `bun add @tegis/player` now gets it.

Inspect the live tags any time with `npm view @tegis/player dist-tags`.

MIT © Tegis
