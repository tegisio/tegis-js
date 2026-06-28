# @tegis/server

Backend SDK for **Tegis** — the content-protection gateway for video. Use it on your own server to
mint short-lived, signed **entitlement grants** that authorize one viewer to play one asset. The
tenant signing key never leaves your backend and never reaches the browser; Tegis validates each grant
against your published JWKS.

Zero npm dependencies (`node:crypto` only). Runs on Node ≥18 and Bun.

## Install

```sh
bun add @tegis/server
```

## Usage

```ts
import { TegisServer } from "@tegis/server";

const tegis = new TegisServer({
  tid: "t_yourtenant",                 // your Tegis tenant id
  issuer: "https://yourapp.example",   // your token issuer
  jwksKid: "k1",                       // key id, must match your published JWKS
  signSeed: Buffer.from(process.env.TEGIS_SIGN_SEED!, "base64url"), // 32-byte Ed25519 seed — keep server-side
  ttlSeconds: 300,
});

// In your "can this user watch this asset?" endpoint, after your own authz check:
const entitlement = tegis.mintEntitlement(userId, assetId, { maxRes: "1080p" });
return Response.json({ entitlement }); // the browser hands this to @tegis/player
```

The browser never sees `signSeed`; it only receives the short-lived `entitlement`, which
[`@tegis/player`](https://www.npmjs.com/package/@tegis/player) exchanges for a playback grant.

## API

- `new TegisServer(config: TegisServerConfig)`
- `.mintEntitlement(sub, assetId, opts?: { maxRes?: string; drm?: string }): string`

## Security

Treat `signSeed` like a private key: load it from a secret store, never log it, never ship it to the
client. Rotate by publishing a new `kid` in your JWKS.

MIT © okbrk
