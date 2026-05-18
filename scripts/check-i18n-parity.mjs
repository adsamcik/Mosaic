#!/usr/bin/env node
/**
 * i18n key parity gate (v1.0.1 s29).
 *
 * Asserts that `apps/web/src/locales/en.json` and
 * `apps/web/src/locales/cs.json` carry the same set of dotted-path
 * leaf keys, after normalizing i18next CLDR plural suffixes
 * (`_zero`, `_one`, `_two`, `_few`, `_many`, `_other`). Plural
 * suffixes are stripped because different languages legitimately
 * need different plural categories (e.g. Czech requires `_few`,
 * English does not), so the parity invariant is on the *base* key.
 *
 * Exit code:
 *   0  - sets are identical
 *   1  - drift detected; a useful diff is printed to stderr
 *
 * No third-party deps; pure Node.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const EN_PATH = resolve(REPO_ROOT, 'apps/web/src/locales/en.json');
const CS_PATH = resolve(REPO_ROOT, 'apps/web/src/locales/cs.json');

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Recursively collect every dotted-path leaf key from a nested
 * translation object. Arrays are treated as leaves.
 */
function collectLeafKeys(obj, prefix = '', out = new Set()) {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of Object.keys(obj)) {
      collectLeafKeys(obj[key], prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.add(prefix);
  }
  return out;
}

function normalizePluralSuffix(key) {
  return key.replace(PLURAL_SUFFIX, '');
}

function loadLocale(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`[check-i18n-parity] Failed to read/parse ${path}: ${err.message}`);
    process.exit(2);
  }
}

const en = loadLocale(EN_PATH);
const cs = loadLocale(CS_PATH);

const enLeaves = collectLeafKeys(en);
const csLeaves = collectLeafKeys(cs);

const enBase = new Set([...enLeaves].map(normalizePluralSuffix));
const csBase = new Set([...csLeaves].map(normalizePluralSuffix));

const missingInCs = [...enBase].filter((k) => !csBase.has(k)).sort();
const missingInEn = [...csBase].filter((k) => !enBase.has(k)).sort();

if (missingInCs.length === 0 && missingInEn.length === 0) {
  console.log(
    `[check-i18n-parity] OK — ${enBase.size} base keys match across en.json and cs.json ` +
      `(en raw: ${enLeaves.size}, cs raw: ${csLeaves.size}; differences are plural-suffix only).`,
  );
  process.exit(0);
}

console.error('[check-i18n-parity] FAIL — translation key sets differ.\n');

if (missingInCs.length > 0) {
  console.error(`Keys present in en.json but missing in cs.json (${missingInCs.length}):`);
  for (const k of missingInCs) console.error(`  - ${k}`);
  console.error('');
}
if (missingInEn.length > 0) {
  console.error(`Keys present in cs.json but missing in en.json (${missingInEn.length}):`);
  for (const k of missingInEn) console.error(`  - ${k}`);
  console.error('');
}

console.error(
  'Note: plural-suffix variants (_zero/_one/_two/_few/_many/_other) are normalized before comparison, ' +
    'so legitimate per-language plural forms are NOT reported as drift. The above keys represent real divergence.',
);

process.exit(1);
