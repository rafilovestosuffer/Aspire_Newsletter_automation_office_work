/**
 * Production build: bundle the app to `dist/` so the container runs plain
 * JavaScript on `node`, not TypeScript through `tsx`.
 *
 * Bundling rather than transpiling, because the source uses extensionless
 * relative imports (`from "../types"`). Node's ESM loader requires explicit
 * `.js` extensions, so a plain `tsc` emit would produce a tree Node refuses to
 * load. esbuild resolves those imports at build time instead, which keeps the
 * source idiomatic and needs no rewrite across every file.
 *
 * `packages: "external"` leaves node_modules alone: pg, mjml and sanitize-html
 * carry native or dynamically-required pieces that do not survive bundling, and
 * they are installed in the image anyway.
 *
 * Output sits at `dist/`, the same depth as `src/`, so `src/paths.ts` resolves
 * the app root identically in the image and in the dev tree.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await build({
  entryPoints: {
    index: "src/index.ts",
    migrate: "src/db/migrate.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  // Surface anything questionable rather than shipping it.
  logLevel: "info",
  metafile: true,
});

const out = Object.entries(result.metafile.outputs)
  .filter(([f]) => f.endsWith(".js"))
  .map(([f, v]) => `${f} ${(v.bytes / 1024).toFixed(1)}kb`);
console.log(`built:\n  ${out.join("\n  ")}`);
