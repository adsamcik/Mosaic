#!/usr/bin/env node
/**
 * Production WASM weak-kdf guard (HIGH security-review-2026-05-20-02).
 *
 * Defense-in-depth check invoked from the frontend prebuild and from
 * vite.config.ts before bundling. Asserts that the canonical production
 * WASM artifact at apps/web/src/generated/mosaic-wasm/mosaic_wasm_bg.wasm
 * has NOT been overwritten with weak-kdf bytes from the test-only
 * artifact at apps/web/src/generated/mosaic-wasm-test-weak/.
 *
 * The `weak-kdf` Cargo feature is a compile-time gate that does not leave
 * a literal "weak-kdf" string in the binary, so we cannot grep the wasm
 * directly. Instead we rely on two invariants:
 *
 *   1. If both artifacts exist and their bytes hash to the same SHA256,
 *      one of them was built with the wrong feature flag. Since the
 *      canonical path MUST be production-grade, fail.
 *
 *   2. If VITE_E2E_WEAK_KEYS=true is set during a production build,
 *      fail — production must never enable the weak-kdf redirect.
 *
 * Exit codes:
 *   0  — canonical artifact is safe
 *   64 — weak-kdf contamination detected (EX_USAGE-style misconfiguration)
 *   65 — canonical artifact missing (EX_DATAERR-style)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const canonicalDir = resolve(repoRoot, 'apps/web/src/generated/mosaic-wasm');
const weakDir = resolve(repoRoot, 'apps/web/src/generated/mosaic-wasm-test-weak');
const canonicalWasm = resolve(canonicalDir, 'mosaic_wasm_bg.wasm');
const weakWasm = resolve(weakDir, 'mosaic_wasm_bg.wasm');

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function fail(code, message) {
  console.error(`❌ ${message}`);
  process.exit(code);
}

// Resolve a path to its real (symlink-followed) absolute form when it
// exists; otherwise return the input. HIGH security-review-2026-05-20-03.
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Invariant 2: production builds must not request weak-kdf redirect.
const isProductionish =
  process.env.NODE_ENV === 'production' || process.env.MOSAIC_PRODUCTION_BUILD === '1';
if (isProductionish && process.env.VITE_E2E_WEAK_KEYS === 'true') {
  fail(
    64,
    'VITE_E2E_WEAK_KEYS=true is set in a production build context. ' +
      'Weak KDF must never reach production bundles (security-review-2026-05-20-02).',
  );
}

if (!existsSync(canonicalWasm)) {
  fail(
    65,
    `Canonical production WASM is missing at ${canonicalWasm}. Run scripts/build-rust-wasm.sh (without weak-kdf) before building the frontend.`,
  );
}

// HIGH security-review-2026-05-20-03: if the canonical and test-weak
// directories resolve to the same real path (e.g. one is a symlink to
// the other, or they were collapsed by `..`/`./` aliases at build time),
// the production artifact is contaminated by definition.
if (existsSync(canonicalDir) && existsSync(weakDir)) {
  const canonRealDir = safeRealpath(canonicalDir);
  const weakRealDir = safeRealpath(weakDir);
  if (canonRealDir === weakRealDir) {
    fail(
      64,
      `Canonical and test-weak WASM directories resolve to the same real path (${canonRealDir}). ` +
        'This means a path-alias or symlink bypass routed weak-kdf bytes into the production path ' +
        '(security-review-2026-05-20-03).',
    );
  }
}

const canonicalHash = sha256(canonicalWasm);

// Invariant 1: canonical bytes must not equal known weak-kdf bytes.
if (existsSync(weakWasm)) {
  const canonRealFile = safeRealpath(canonicalWasm);
  const weakRealFile = safeRealpath(weakWasm);
  if (canonRealFile === weakRealFile) {
    fail(
      64,
      `Canonical WASM (${canonicalWasm}) resolves to the same real file as the test-weak artifact ` +
        `(${weakRealFile}). Symlink / path-alias bypass detected (security-review-2026-05-20-03).`,
    );
  }
  const weakHash = sha256(weakWasm);
  if (canonicalHash === weakHash) {
    fail(
      64,
      `Canonical WASM (${canonicalWasm}) is byte-identical to the test-weak artifact (${weakWasm}).\n   This means the weak-kdf build overwrote the production output. ` +
        'Rebuild the production WASM with MOSAIC_WASM_CARGO_FEATURES unset, or pass MOSAIC_WASM_OUT_DIR=apps/web/src/generated/mosaic-wasm-test-weak when building weak-kdf (security-review-2026-05-20-02).',
    );
  }
}

console.log(
  `✅ Production WASM guard passed (canonical sha256=${canonicalHash.slice(0, 16)}…).`,
);
