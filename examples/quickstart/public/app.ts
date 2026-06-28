// Tegis quickstart — the browser. Imports ONLY the published @tegis/player package.
// Flow: read your app's /config → get an entitlement from your backend → TegisPlayer plays the protected
// asset (attest → handshake → mint → renew, with WebCrypto AES-CTR segment decryption over MSE).
import { TegisPlayer } from "@tegis/player";

const b64uToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const ASSET_ID = "ast_DEMO1"; // the asset to play (wire this to your catalog)

const video = document.querySelector<HTMLVideoElement>("#video")!;
const playBtn = document.querySelector<HTMLButtonElement>("#play")!;
const status = document.querySelector<HTMLPreElement>("#status")!;
const log = (m: string) => (status.textContent += m + "\n");

const cfg = await (await fetch("/config")).json();
const player = new TegisPlayer({
  mint: cfg.mint,
  edge: cfg.edge,
  tid: cfg.tid,
  handshakeSecret: b64uToBytes(cfg.handshakeSecretB64u),
  demoHeaders: cfg.demoHeaders, // local stack routes by x-aegis-tenant; false against a deployed tenant
  // For obfuscation-grade hardening, pass `handshakeFn: await loadWasmHandshake(secret, wasmBytes)`
  // (or loadWhitenedHandshake for the no-secret-in-browser path). See the @tegis/player README.
});

// Solve the bot-wall at page load, off the click→play path, for near-native join time.
player.prewarm().then(() => log("prewarmed (attestation ready)")).catch((e) => log("prewarm: " + e.message));

playBtn.addEventListener("click", async () => {
  try {
    log("requesting entitlement from your backend…");
    const { entitlement } = await (
      await fetch("/entitlement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "u_1", assetId: ASSET_ID }),
      })
    ).json();

    log("playing protected asset…");
    await player.play(video, { assetId: ASSET_ID, entitlement });
    log("✓ protected playback started");
  } catch (e) {
    log("✗ " + (e as Error).message);
  }
});
