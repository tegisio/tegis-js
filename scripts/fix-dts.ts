#!/usr/bin/env bun
// Post-build: rewrite relative `.ts` import specifiers to `.js` in emitted .d.ts files.
//
// The package source imports with explicit `.ts` extensions (Bun style). `bun build` inlines those into a
// single bundled .js, but `tsc --emitDeclarationOnly` leaves `.ts` specifiers in the .d.ts re-exports,
// which a consumer's TypeScript cannot resolve (it looks for `X.ts`, only `X.d.ts` ships). This rewrites
// `from "./x.ts"` → `from "./x.js"` so declarations resolve against their sibling `.d.ts`. Deterministic;
// not reliant on `rewriteRelativeImportExtensions` (a no-op for declaration re-exports under TS6).
import { Glob } from "bun";

const dir = process.argv[2] ?? "dist";
let changed = 0;
for await (const rel of new Glob("**/*.d.ts").scan(dir)) {
  const path = `${dir}/${rel}`;
  const src = await Bun.file(path).text();
  const out = src.replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"');
  if (out !== src) {
    await Bun.write(path, out);
    changed++;
  }
}
console.log(`fix-dts: rewrote .ts→.js specifiers in ${changed} declaration file(s) under ${dir}/`);
