// Tegis quickstart — your backend.
// Two jobs: (1) mint entitlements with @tegis/server (the tenant signing key stays here, never reaches
// the browser), and (2) serve the page + a /config the player needs. This file imports ONLY the published
// @tegis/server package — no Tegis repo internals.
import { TegisServer } from "@tegis/server";

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k} (see .env.example)`);
  return v;
};

// 32-byte Ed25519 seed, base64url. Load from a secret store; NEVER log it or send it to the client.
const signSeed = Buffer.from(env("TEGIS_SIGN_SEED"), "base64url");
const tegis = new TegisServer({
  tid: env("TEGIS_TID"),
  issuer: env("TEGIS_ISSUER", "https://localhost"),
  jwksKid: env("TEGIS_KID", "k1"),
  signSeed,
  ttlSeconds: 300,
});

const PORT = Number(env("PORT", "3000"));

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // (1) Config the player needs: your tenant's mint/edge endpoints + the handshake secret Tegis
    //     delivered to you. In production prefer the WASM-whitened handshake (no secret in the browser) —
    //     see the @tegis/player README.
    if (url.pathname === "/config") {
      return Response.json({
        tid: env("TEGIS_TID"),
        mint: env("TEGIS_MINT_URL"),
        edge: env("TEGIS_EDGE_URL"),
        handshakeSecretB64u: env("TEGIS_HANDSHAKE_SECRET"),
        // Local demo gateway routes by the x-aegis-tenant header (no CNAME); a deployed tenant routes by
        // Host, so leave this false in production.
        demoHeaders: env("TEGIS_DEMO_HEADERS", "false") === "true",
      });
    }

    // (2) The entitlement endpoint. Do YOUR OWN authorization first, then mint.
    if (url.pathname === "/entitlement" && req.method === "POST") {
      const { userId, assetId } = (await req.json()) as { userId: string; assetId: string };
      // TODO: verify this user is allowed to watch this asset (session / subscription check).
      const entitlement = tegis.mintEntitlement(userId, assetId, { maxRes: "1080p" });
      return Response.json({ entitlement });
    }

    // (3) Static page + built player bundle.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file("public" + path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Tegis quickstart → http://localhost:${PORT}`);
