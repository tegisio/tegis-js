// Golden-vector parity gate for the PACKAGED @tegis/server (S1-3 anti-drift backstop).
//
// @tegis/server vendors its own Ed25519 + JWS (src/crypto/) so it has zero repo-relative imports. This
// gate proves that vendored copy did NOT diverge from the committed golden vectors — the same fixture the
// Go data plane validates (`reference/dataplane-go: go test ./canon`). If anyone edits the packaged crypto
// and it drifts by a single byte, this fails. Run: `cd packages/server && bun test`.
//
// Imports go through the package's OWN src (what gets published via `files`), not the repo reference.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signEd25519, verifyEd25519, publicRawFromSeed, b64u, utf8 } from "../src/crypto/ed25519.ts";
import { TegisServer } from "../src/index.ts";

const GV = JSON.parse(
  readFileSync(join(import.meta.dir, "golden-vectors.json"), "utf8"),
) as {
  keys: Record<string, { seedHex: string; publicKeyB64u: string }>;
  vectors: Array<{ name: string; kid: string; canonical: string; sigB64u: string }>;
};

test("packaged crypto reproduces every golden vector byte-for-byte", () => {
  expect(GV.vectors.length).toBeGreaterThan(0);
  for (const v of GV.vectors) {
    const k = GV.keys[v.kid];
    const seed = Buffer.from(k.seedHex, "hex");

    // 1. public-key derivation parity (raw 32-byte key, base64url no-pad)
    expect(b64u(publicRawFromSeed(seed))).toBe(k.publicKeyB64u);

    // 2. signature parity over the exact canonical string
    expect(b64u(signEd25519(seed, utf8(v.canonical)))).toBe(v.sigB64u);

    // 3. the vendored verifier accepts the committed signature
    expect(verifyEd25519(publicRawFromSeed(seed), utf8(v.canonical), Buffer.from(v.sigB64u, "base64url"))).toBe(true);
  }
});

test("public TegisServer.mintEntitlement signs with the same vendored Ed25519", () => {
  const seed = Buffer.from(GV.keys.kid_demoA.seedHex, "hex");
  const jwt = new TegisServer({
    tid: "ten_DEMO",
    issuer: "https://demo.example",
    jwksKid: "kid_demoA",
    signSeed: seed,
  }).mintEntitlement("u_1", "ast_DEMO1", { maxRes: "1080p" });

  const [h, p, s] = jwt.split(".");
  expect(jwt.split(".").length).toBe(3);
  expect(JSON.parse(Buffer.from(h, "base64url").toString()).alg).toBe("EdDSA");
  // the JWS signature must verify under the vendored verifier with the key derived from the same seed
  expect(verifyEd25519(publicRawFromSeed(seed), utf8(`${h}.${p}`), Buffer.from(s, "base64url"))).toBe(true);
});
