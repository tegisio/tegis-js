// Browser bundle entry — exposes the player on the global so a <script> tag (or Playwright) can use it.
import { TegisPlayer } from "./player.ts";
import { loadWhitenedHandshake } from "./handshake-wasm.ts";
(globalThis as any).TegisPlayer = TegisPlayer;
// F9: build a handshakeFn from a per-tenant whitened module (no secret) — the page passes it to the player.
(globalThis as any).TegisLoadWhitenedHandshake = loadWhitenedHandshake;
