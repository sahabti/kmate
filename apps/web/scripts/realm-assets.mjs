#!/usr/bin/env node
/**
 * Publishes Realm View themes into public/themes/ (git-ignored) and writes
 * public/themes/index.json listing which ones are usable.
 *
 * A theme is a directory under themes/ holding theme.json:
 *   source: "bundled"  — art is committed next to theme.json (CC0 or similar)
 *   source: "external" — art comes from KMATE_ASSETS_DIR and is never committed
 *
 * A theme whose art is missing is simply marked unavailable; the build always
 * succeeds, so a clone with no licensed art still gets the bundled themes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const themesSrc = join(webRoot, "themes");
const assetsDir = resolve(webRoot, process.env.KMATE_ASSETS_DIR ?? "../../assets");
const outRoot = join(webRoot, "public", "themes");

/** Non-commercial pack that must never ship, even if someone lists it in a theme. */
const FORBIDDEN = /(^|\/)Cute_Fantasy_Free(\/|$)/;

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const themeDirs = existsSync(themesSrc)
  ? readdirSync(themesSrc).filter((d) => statSync(join(themesSrc, d)).isDirectory() && existsSync(join(themesSrc, d, "theme.json")))
  : [];

const infos = [];
for (const id of themeDirs.sort()) {
  const dir = join(themesSrc, id);
  const def = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8"));
  const external = def.source === "external";
  const base = external ? assetsDir : dir;

  // every distinct file the roles reference, plus an optional font
  const srcs = new Set();
  for (const r of Object.values(def.roles ?? {})) for (const e of Array.isArray(r) ? r : [r]) if (e.src) srcs.add(e.src);
  const fontSrc = def.$fontSrc ?? (def.font ? def.font : null);

  if (external && !existsSync(base)) {
    infos.push({ id, name: def.name ?? id, author: def.author, license: def.license, url: def.url, available: false, reason: `assets dir not found: ${base}` });
    console.log(`[realm-assets] ${id}: ${base} not found — theme unavailable`);
    continue;
  }

  // flatten source paths to URL-safe names; the published theme.json points at those
  const slugs = new Map();
  const used = new Set();
  const slugFor = (src) => {
    if (slugs.has(src)) return slugs.get(src);
    let s = src.replace(/[^\w.-]+/g, "_").replace(/^_+/, "");
    if (s.length > 80) s = s.slice(-80);
    let out = s, n = 1;
    while (used.has(out)) out = `${n++}_${s}`;
    used.add(out);
    slugs.set(src, out);
    return out;
  };

  const outDir = join(outRoot, id);
  mkdirSync(outDir, { recursive: true });
  let copied = 0, missing = 0, refused = 0;
  for (const src of srcs) {
    if (FORBIDDEN.test(src)) {
      console.error(`[realm-assets] ${id}: refusing ${src} — Cute_Fantasy_Free is non-commercial`);
      refused++;
      continue;
    }
    const from = join(base, src);
    if (!existsSync(from)) { console.warn(`[realm-assets] ${id}: missing ${from}`); missing++; continue; }
    copyFileSync(from, join(outDir, slugFor(src)));
    copied++;
  }

  if (refused) process.exitCode = 1;
  if (copied === 0) {
    rmSync(outDir, { recursive: true, force: true });
    infos.push({ id, name: def.name ?? id, author: def.author, license: def.license, url: def.url, available: false, reason: `no art found under ${base}` });
    console.log(`[realm-assets] ${id}: no art found under ${base} — theme unavailable`);
    continue;
  }

  // publish the theme with rewritten src paths
  const published = { ...def };
  delete published.$fontSrc;
  delete published.$note;
  published.roles = {};
  for (const [role, r] of Object.entries(def.roles ?? {})) {
    const map = (e) => (e.src && slugs.has(e.src) ? { ...e, src: slugs.get(e.src) } : e.src ? null : e);
    published.roles[role] = Array.isArray(r) ? r.map(map).filter(Boolean) : map(r);
    if (!published.roles[role] || (Array.isArray(published.roles[role]) && !published.roles[role].length)) delete published.roles[role];
  }
  if (fontSrc) {
    const from = join(base, fontSrc);
    if (existsSync(from)) { copyFileSync(from, join(outDir, `font${extname(fontSrc)}`)); published.font = `font${extname(fontSrc)}`; }
    else delete published.font;
  }
  writeFileSync(join(outDir, "theme.json"), JSON.stringify(published));
  infos.push({ id, name: def.name ?? id, author: def.author, license: def.license, url: def.url, available: true });
  console.log(`[realm-assets] ${id}: ${copied} files${missing ? `, ${missing} missing` : ""} from ${base}`);
}

const available = infos.filter((t) => t.available);
const defaultTheme = available.find((t) => t.id === "cute-fantasy")?.id ?? available[0]?.id;
writeFileSync(join(outRoot, "index.json"), JSON.stringify({ themes: infos, defaultTheme }));
console.log(`[realm-assets] ${available.length}/${infos.length} themes available; default = ${defaultTheme ?? "none"}`);
