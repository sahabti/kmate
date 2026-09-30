#!/usr/bin/env node
// Copies the sprites referenced by realm/manifest.json from KMATE_ASSETS_DIR
// into public/realm/ (git-ignored) and writes public/realm/index.json.
// The art (Cute Fantasy by Kenmi) may not be redistributed, so it never enters git.
// Missing assets are not an error: index.json then says { available: false }.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const assetsDir = resolve(webRoot, process.env.KMATE_ASSETS_DIR ?? "../../assets");
const outDir = join(webRoot, "public", "realm");
const manifest = JSON.parse(readFileSync(join(webRoot, "realm", "manifest.json"), "utf8"));

mkdirSync(outDir, { recursive: true });

if (!existsSync(assetsDir)) {
  writeFileSync(join(outDir, "index.json"), JSON.stringify({ available: false, reason: `assets dir not found: ${assetsDir}` }));
  console.log(`[realm-assets] ${assetsDir} not found; Realm View will show the placeholder.`);
  process.exit(0);
}

const out = { available: true, attribution: manifest.attribution, entries: [] };
let copied = 0, missing = 0;
for (const e of manifest.entries) {
  if (/(^|\/)Cute_Fantasy_Free(\/|$)/.test(e.src)) {
    console.error(`[realm-assets] refusing ${e.id}: Cute_Fantasy_Free is non-commercial`);
    process.exitCode = 1;
    continue;
  }
  const src = join(assetsDir, e.src);
  if (!existsSync(src)) {
    console.warn(`[realm-assets] missing ${e.id}: ${src}`);
    missing++;
    continue;
  }
  const file = `${e.id}${extname(e.src).toLowerCase()}`;
  copyFileSync(src, join(outDir, file));
  copied++;
  out.entries.push({ ...e, url: `/realm/${file}` });
}
// resolve animsLike
const byId = Object.fromEntries(out.entries.map((e) => [e.id, e]));
for (const e of out.entries) if (e.animsLike && byId[e.animsLike]) e.anims = byId[e.animsLike].anims;
writeFileSync(join(outDir, "index.json"), JSON.stringify(out));
if (copied === 0) {
  // Directory present but none of the manifest files were in it: same as no assets.
  writeFileSync(join(outDir, "index.json"), JSON.stringify({ available: false, reason: `no manifest files found under ${assetsDir}` }));
  console.log(`[realm-assets] no sprites found under ${assetsDir}; Realm View will show the placeholder.`);
  process.exit(0);
}

console.log(`[realm-assets] copied ${copied} files (${missing} missing) from ${assetsDir} → public/realm`);
