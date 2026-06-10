#!/usr/bin/env node
/**
 * Check: i18n coverage
 *
 * Extracts every translation key referenced by the frontend:
 *   - data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label
 *     attributes in public/*.html and public/partials/*.html
 *   - dynamic setAttribute("data-i18n", "...") calls
 *   - t("key", ...) / i18nText("key", ...) runtime calls in public/js/** and
 *     in the inline scripts of public/*.html
 *
 * FAILS (exit 1) when a referenced key is missing from public/locales/en.json.
 * WARNS (exit 0) for locale keys that are never referenced (the legacy
 * `phrases.*` text-node translator data is exempt — it is matched by literal
 * English text, not by key).
 *
 * Usage: node scripts/checks/i18n-coverage.mjs [repo-root]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.argv[2] || ".");
const PUBLIC_DIR = path.join(ROOT, "public");
const LOCALES = ["en"];

// Locale subtrees that are not addressed by key from markup/JS.
const UNUSED_EXEMPT_PREFIXES = ["phrases."];

function listFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => path.join(dir, name));
}

const htmlFiles = [
  ...listFiles(PUBLIC_DIR, ".html"),
  ...listFiles(path.join(PUBLIC_DIR, "partials"), ".html"),
];

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

const jsFiles = listJsFiles(path.join(PUBLIC_DIR, "js")).filter(
  (file) =>
    !file.includes(`${path.sep}vendor${path.sep}`) && !file.includes(`${path.sep}lib${path.sep}`),
);

// --- Key extraction ---------------------------------------------------------

const ATTR_RE = /data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g;
const SET_ATTR_RE =
  /setAttribute\(\s*["']data-i18n(?:-title|-placeholder|-aria-label)?["']\s*,\s*["']([^"']+)["']/g;
const CALL_RE = /\b(?:t|i18nText)\(\s*["'`]([A-Za-z0-9_.-]+)["'`]/g;

/** @type {Map<string, Set<string>>} key -> referencing files */
const used = new Map();

function record(key, file) {
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(path.relative(ROOT, file));
}

function scan(file, regexes) {
  const content = fs.readFileSync(file, "utf8");
  for (const re of regexes) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) record(match[1], file);
  }
}

for (const file of htmlFiles) scan(file, [ATTR_RE, SET_ATTR_RE, CALL_RE]);
// JS files can also embed data-i18n attributes inside template strings
// (e.g. views.js renderLoading/renderError).
for (const file of jsFiles) scan(file, [ATTR_RE, SET_ATTR_RE, CALL_RE]);

// Keys referenced through dynamic lookup maps the static scan cannot see
// (index.html setConnectionStatus() i18nKeyMap -> setAttribute("data-i18n", key)).
const KNOWN_DYNAMIC_KEYS = ["app.live", "app.connecting", "app.disconnected"];
for (const key of KNOWN_DYNAMIC_KEYS) record(key, path.join(PUBLIC_DIR, "index.html"));

// --- Locale flattening ------------------------------------------------------

function flatten(obj, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, full, out);
    } else {
      out.add(full);
    }
  }
  return out;
}

const localeKeys = {};
for (const locale of LOCALES) {
  const file = path.join(PUBLIC_DIR, "locales", `${locale}.json`);
  localeKeys[locale] = flatten(JSON.parse(fs.readFileSync(file, "utf8")));
}

// --- Report -----------------------------------------------------------------

let failed = false;

for (const locale of LOCALES) {
  const missing = [...used.keys()].filter((key) => !localeKeys[locale].has(key)).sort();
  if (missing.length > 0) {
    failed = true;
    console.error(`✗ ${missing.length} key(s) missing from locales/${locale}.json:`);
    for (const key of missing) {
      console.error(`    ${key}  (used in: ${[...used.get(key)].join(", ")})`);
    }
  }
}

const unused = [...localeKeys.en]
  .filter((key) => !used.has(key))
  .filter((key) => !UNUSED_EXEMPT_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .sort();
if (unused.length > 0) {
  console.warn(`⚠ ${unused.length} locale key(s) defined but never referenced (warn only):`);
  for (const key of unused) console.warn(`    ${key}`);
}

if (failed) {
  process.exit(1);
}
console.log(
  `✓ i18n coverage OK — ${used.size} referenced keys present in ${LOCALES.join(" + ")}` +
    (unused.length ? ` (${unused.length} unused, warn only)` : ""),
);
