#!/usr/bin/env node
// Regenerates the deterministic portions of the test-vector corpus and
// verifies that the committed JSON fixtures under `tests/vectors/` and the
// generated Rust include file under `crates/mosaic-crypto/tests/` are
// byte-identical with the canonical references.
//
// What this script does:
//
//   1. Regenerates `crates/mosaic-crypto/tests/sharing_vector.rs.inc`
//      from `scripts/dump-bundle-vector.mjs` — the one programmatically
//      generated artefact in the corpus.
//
//   2. Runs the cross-client differential parity tests in
//      `mosaic-vectors`, `mosaic-uniffi`, and `mosaic-parity-tests`. These
//      tests load every `tests/vectors/*.json` fixture and assert that
//      Rust reproduces the captured bytes. A passing run is the bit-identity
//      proof for the hand-authored JSON corpus.
//
//   3. Asserts that no committed fixture under `tests/vectors/` or
//      `crates/mosaic-crypto/tests/sharing_vector.rs.inc` was mutated by
//      the regeneration — `git diff --exit-code` fails the script if any
//      content changed.
//
// The 22 `tests/vectors/*.json` fixtures are canonical reference vectors,
// not auto-generated. They are authored by hand using deterministic test
// inputs and expected outputs computed against the libsodium / TS reference
// implementation. New vectors must be added by editing JSON directly; see
// `tests/vectors/README.md` for the authoring procedure.
//
// Usage:
//   node scripts/regenerate-test-vectors.mjs        # regenerate + verify
//   node scripts/regenerate-test-vectors.mjs --check # verify only, no regen
//
// Exit codes:
//   0 — corpus is bit-identical with canonical references
//   1 — drift detected, dependency missing, or a parity test failed

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SHARING_VECTOR_INC = join(
  REPO_ROOT,
  'crates',
  'mosaic-crypto',
  'tests',
  'sharing_vector.rs.inc',
);
const VECTORS_DIR = join(REPO_ROOT, 'tests', 'vectors');
const LIBS_CRYPTO_DIR = join(REPO_ROOT, 'libs', 'crypto');
const DUMP_BUNDLE_SCRIPT = join(REPO_ROOT, 'scripts', 'dump-bundle-vector.mjs');

const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has('--check');

function log(message) {
  process.stdout.write(`[regenerate-test-vectors] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[regenerate-test-vectors] ERROR: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
  });
  if (result.error) {
    fail(`failed to spawn ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function regenerateSharingVector() {
  if (!existsSync(join(LIBS_CRYPTO_DIR, 'node_modules', 'libsodium-wrappers-sumo'))) {
    fail(
      `libsodium-wrappers-sumo is not installed under libs/crypto/node_modules. ` +
        `Run \`npm install\` in libs/crypto/ before regenerating vectors.`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'mosaic-vectors-'));
  const outputFile = join(tmpDir, 'sharing_vector.rs.inc');

  log(`Regenerating ${SHARING_VECTOR_INC} via dump-bundle-vector.mjs`);
  const result = spawnSync(process.execPath, [DUMP_BUNDLE_SCRIPT], {
    cwd: LIBS_CRYPTO_DIR,
    encoding: 'utf8',
  });
  if (result.error) {
    fail(`failed to spawn node: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    fail(`dump-bundle-vector.mjs exited with status ${result.status}`);
  }
  writeFileSync(outputFile, result.stdout, { encoding: 'utf8' });
  writeFileSync(SHARING_VECTOR_INC, result.stdout, { encoding: 'utf8' });
}

function runParityTests() {
  log('Running Rust cross-client parity tests (this is the bit-identity gate)');
  run('cargo', [
    'test',
    '-p',
    'mosaic-vectors',
    '--test',
    'differential',
    '--locked',
  ]);
  run('cargo', [
    'test',
    '-p',
    'mosaic-uniffi',
    '--features',
    'cross-client-vectors',
    '--test',
    'cross_client_vectors',
    '--locked',
  ]);
  run('cargo', [
    'test',
    '-p',
    'mosaic-parity-tests',
    '--features',
    'cross-client-vectors',
    '--locked',
  ]);
}

function assertNoDrift() {
  log('Asserting committed corpus is byte-identical via git diff --exit-code');
  const result = spawnSync(
    'git',
    [
      'diff',
      '--exit-code',
      '--',
      'tests/vectors/',
      'crates/mosaic-crypto/tests/sharing_vector.rs.inc',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (result.error) {
    fail(`failed to spawn git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      'committed test vectors differ from regenerated output. ' +
        'Either (a) intentional change: review the diff, update consumers, and commit; ' +
        'or (b) accidental drift: revert.',
    );
  }
  log('OK — committed corpus is bit-identical with canonical references.');
}

function main() {
  if (!existsSync(VECTORS_DIR)) {
    fail(`tests/vectors/ not found at ${VECTORS_DIR}`);
  }
  if (!CHECK_ONLY) {
    regenerateSharingVector();
  } else {
    log('--check mode: skipping regeneration, only running parity + drift gates');
  }
  runParityTests();
  assertNoDrift();
}

main();
