# Tegis quickstart (≈30 minutes)

Go from zero to **protected video playback** using only the two published packages —
[`@tegis/server`](https://www.npmjs.com/package/@tegis/server) (backend) and
[`@tegis/player`](https://www.npmjs.com/package/@tegis/player) (browser). No Tegis repo internals.

**The shape:** your server mints a short-lived **entitlement** (signing key stays server-side) → the browser
exchanges it for a playback grant via `@tegis/player` → segments stream, decrypted in-browser.

```
 browser ──/entitlement──▶ your server ──@tegis/server.mint──▶ entitlement (JWS)
 browser ──@tegis/player.play(entitlement)──▶ Tegis mint/edge ──▶ protected segments
```

## Prerequisites

- **Bun** (`curl -fsSL https://bun.sh/install | bash`)
- A **Tegis tenant**: your `tid`, a 32-byte Ed25519 **signing seed**, a **handshake secret**, and your
  **mint/edge endpoint** (tenant CNAME) — from Tegis onboarding.
- **Real Chrome** for playback (H.264 + MSE) — see *Browser support* below.

## 1. Install

```sh
bun add @tegis/server @tegis/player
```

## 2. Configure

```sh
cp .env.example .env   # then fill in TEGIS_SIGN_SEED, TEGIS_TID, TEGIS_MINT_URL, etc.
```

The signing seed is a server secret — it never appears in the browser bundle.

## 3. Mint entitlements on your server — [`server.ts`](./server.ts)

The key lines (full file in `server.ts`):

```ts
import { TegisServer } from "@tegis/server";

const tegis = new TegisServer({ tid, issuer, jwksKid, signSeed, ttlSeconds: 300 });

// POST /entitlement — after YOUR OWN authz check:
const entitlement = tegis.mintEntitlement(userId, assetId, { maxRes: "1080p" });
```

## 4. Play in the browser — [`public/app.ts`](./public/app.ts)

```ts
import { TegisPlayer } from "@tegis/player";

const player = new TegisPlayer({ mint, edge, tid, handshakeSecret });
player.prewarm();                                   // solve the bot-wall at page load
await player.play(video, { assetId, entitlement }); // attest → handshake → mint → renew → MSE
```

For obfuscation-grade hardening, swap in the WASM handshake (`loadWasmHandshake` /
`loadWhitenedHandshake`) — see the `@tegis/player` README.

## 5. Run

```sh
bun run start     # builds public/app.js, then starts the server
# open http://localhost:3000 in Chrome → click "Play protected asset"
```

## What "done" looks like

The page loads, prewarm succeeds (attestation ready), and clicking **Play** streams the protected asset —
segments are fetched per-session, signed, and decrypted in the browser. A naive scraper that grabs the
manifest URLs gets nothing playable.

> **Note:** steps 1–3 (install + server-side minting) run standalone today. Step 4's *actual playback*
> needs a running Tegis gateway at `TEGIS_MINT_URL`/`TEGIS_EDGE_URL` — your deployed tenant. Point the env there.

## Browser support

Playback requires **real Chrome** (H.264 + MSE). Detect and show a clear message on other engines:

```ts
if (!window.MediaSource) status.textContent = "This player requires a Chromium-based browser.";
```

## Security recap

- The **signing seed never leaves your server** — only short-lived entitlements reach the browser.
- The player **never holds a tenant key** — only a per-session attestation + grant.
- Rotate by publishing a new `kid` in your JWKS.
