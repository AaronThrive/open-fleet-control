#!/usr/bin/env node
/**
 * One-shot backfill: find i18n keys referenced by the frontend but missing
 * from public/locales/en.json, recover their English default from the call
 * site (t() fallback arg, or the data-i18n element's text / paired attribute)
 * and merge them into en.json.
 *
 * Usage: node scripts/checks/i18n-backfill.mjs [--write]
 *   (dry-run by default; prints key -> string and flags unresolved keys)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(".");
const PUBLIC_DIR = path.join(ROOT, "public");
const EN_PATH = path.join(PUBLIC_DIR, "locales", "en.json");
const WRITE = process.argv.includes("--write");

function listFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => path.join(dir, name));
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const htmlFiles = [
  ...listFiles(PUBLIC_DIR, ".html"),
  ...listFiles(path.join(PUBLIC_DIR, "partials"), ".html"),
];
const jsFiles = listJsFiles(path.join(PUBLIC_DIR, "js")).filter(
  (f) => !f.includes(`${path.sep}vendor${path.sep}`) && !f.includes(`${path.sep}lib${path.sep}`),
);

const en = JSON.parse(fs.readFileSync(EN_PATH, "utf8"));

function hasKey(obj, dotted) {
  let node = obj;
  for (const part of dotted.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === "string";
}

function setKey(obj, dotted, value) {
  const parts = dotted.split(".");
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

// --- Collect referenced keys (mirrors i18n-coverage.mjs) --------------------
const ATTRS = ["data-i18n", "data-i18n-title", "data-i18n-placeholder", "data-i18n-aria-label"];
const referenced = new Map(); // key -> { file, attr } | { file, js: true }

for (const file of htmlFiles) {
  const src = fs.readFileSync(file, "utf8");
  for (const attr of ATTRS) {
    const re = new RegExp(`${attr}="([^"]+)"`, "g");
    for (const m of src.matchAll(re)) {
      if (!referenced.has(m[1])) referenced.set(m[1], { file, attr });
    }
  }
}
const allJsSources = [...jsFiles, ...htmlFiles].map((f) => ({
  file: f,
  src: fs.readFileSync(f, "utf8"),
}));
for (const { file, src } of allJsSources) {
  for (const m of src.matchAll(/\b(?:t|i18nText)\(\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], { file, js: true });
  }
  for (const m of src.matchAll(
    /setAttribute\(\s*["']data-i18n["']\s*,\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g,
  )) {
    if (!referenced.has(m[1])) referenced.set(m[1], { file, js: true });
  }
}

const missing = [...referenced.keys()].filter((k) => !hasKey(en, k)).sort();

// --- Recover English defaults ------------------------------------------------
function findJsFallback(key) {
  // t("key", {...}, "fallback") — fallback may be "...", '...' or `...`
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(?:t|i18nText)\\(\\s*["'\`]${keyEsc}["'\`]\\s*,[\\s\\S]{0,500}?,\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)\\s*,?\\s*\\)`,
  );
  for (const { src } of allJsSources) {
    const m = src.match(re);
    if (m) {
      const raw = m[1];
      return raw.slice(1, -1).replace(/\\(["'`\\])/g, "$1");
    }
  }
  return null;
}

function findHtmlDefault(key, attr) {
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const file of htmlFiles) {
    const src = fs.readFileSync(file, "utf8");
    // Grab the whole opening tag containing the attribute, plus trailing text.
    const tagRe = new RegExp(`<[a-zA-Z][^>]*${attr}="${keyEsc}"[^>]*>`, "g");
    const m = tagRe.exec(src);
    if (!m) continue;
    const tag = m[0];
    if (attr !== "data-i18n") {
      // Paired plain attribute holds the English default.
      const plain = attr.replace("data-i18n-", "");
      const pm = tag.match(new RegExp(`(?:^|\\s)${plain}="([^"]*)"`));
      if (pm) return pm[1];
    }
    // Element text content: from end of opening tag to next '<'.
    const after = src.slice(m.index + tag.length);
    const text = after.split("<")[0].replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

const resolved = {};
const unresolved = [];
for (const key of missing) {
  const ref = referenced.get(key);
  let value = findJsFallback(key);
  if (value === null && !ref.js) value = findHtmlDefault(key, ref.attr);
  if (value === null) value = findHtmlDefault(key, "data-i18n");
  if (value === null || value === "") unresolved.push(key);
  else resolved[key] = value;
}

for (const [key, value] of Object.entries(resolved)) {
  console.log(`${key} = ${JSON.stringify(value)}`);
}
if (unresolved.length) {
  console.log(`\nUNRESOLVED (${unresolved.length}):`);
  for (const key of unresolved) console.log(`  ${key}  (${referenced.get(key).file})`);
}
console.log(
  `\n${Object.keys(resolved).length} resolved, ${unresolved.length} unresolved, ${missing.length} missing total`,
);

if (WRITE) {
  for (const [key, value] of Object.entries(resolved)) setKey(en, key, value);
  fs.writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(resolved).length} keys to ${path.relative(ROOT, EN_PATH)}`);
}
