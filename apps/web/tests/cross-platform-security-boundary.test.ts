import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BoundaryFile {
  readonly relativePath: string;
  readonly content: string;
}

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testRoot, '../../..');

const boundaryFilePaths = [
  'apps/web/src/workers/crypto.worker.ts',
  'apps/web/src/workers/rust-crypto-core.ts',
  'apps/web/src/workers/types.ts',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/AuthSessionState.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/GeneratedRustAccountBridge.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/GeneratedRustMediaBridge.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/ManualUploadCoordinator.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/MediaPort.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/PhotoPickerContracts.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/RustAccountBridge.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/UploadQueueRecord.kt',
  'apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/WorkPolicy.kt',
  'crates/mosaic-client/src/lib.rs',
  'crates/mosaic-uniffi/src/lib.rs',
  'crates/mosaic-wasm/src/lib.rs',
] as const;

const forbiddenDirectLogPatterns = [
  {
    name: 'browser console logging',
    pattern: /\bconsole\.(?:log|debug|info|warn|error|trace)\s*\(/,
  },
  {
    name: 'Android platform logging',
    pattern: /\b(?:android\.util\.Log|Log\.(?:d|i|w|e|v|wtf)|Timber\.(?:d|i|w|e|v|wtf)|println)\s*\(/,
  },
  {
    name: 'Rust stdout/stderr/debug logging',
    pattern: /\b(?:println!|eprintln!|dbg!)\s*\(/,
  },
  {
    name: 'Rust tracing/log crate calls',
    pattern: /\b(?:tracing|log)::(?:trace|debug|info|warn|error)!\s*\(/,
  },
] as const;

const sensitiveIdentifiers =
  '(?:password|privateKey|secretKey|linkSecret|sessionKey|accountKey|identitySeed|epochSeed|tierKey|plaintext|decryptedMetadata|rawUri|contentUri|remoteUser)';

const sensitiveLogValuePattern = new RegExp(
  `(?:console\\.|log\\.|logger\\.|Log\\.|Timber\\.|println!|eprintln!|tracing::|log::)[^\\n]*(?:[,({]\\s*${sensitiveIdentifiers}\\b|\\{[^\\n}]*\\b${sensitiveIdentifiers}\\b\\s*:)`,
  'i',
);

const productionFixturePatterns = [
  /(?:test-only|fixture|dummy)\s+(?:password|secret|key|seed)/i,
  /(?:password|secret|key|seed)\s*[:=]\s*['"](?:password|secret|dummy|test)['"]/i,
] as const;

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function readBoundaryFiles(): BoundaryFile[] {
  return boundaryFilePaths.map((relativePath) => {
    const fullPath = resolve(repoRoot, relativePath);
    return {
      relativePath: normalizePath(relative(repoRoot, fullPath)),
      content: readFileSync(fullPath, 'utf8'),
    };
  });
}

function matchingLines(
  files: readonly BoundaryFile[],
  pattern: RegExp,
): string[] {
  return files.flatMap((file) =>
    file.content
      .split(/\r?\n/)
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => pattern.test(line))
      .map(({ line, lineNumber }) => `${file.relativePath}:${lineNumber}: ${line.trim()}`),
  );
}

function deriveListForStruct(content: string, structName: string): string {
  const pattern = new RegExp(
    `#\\[derive\\(([^\\)]*)\\)\\]\\s*(?:pub\\s+)?struct\\s+${structName}\\b`,
    'm',
  );
  const match = pattern.exec(content);

  expect(match, `${structName} must have an explicit reviewed derive list`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('cross-platform security boundary static guard', () => {
  const boundaryFiles = readBoundaryFiles();

  it('keeps direct logging APIs out of high-risk production boundaries', () => {
    const matches = forbiddenDirectLogPatterns.flatMap(({ name, pattern }) =>
      matchingLines(boundaryFiles, pattern).map((line) => `${name}: ${line}`),
    );

    expect(matches).toEqual([]);
  });

  it('blocks obvious sensitive values from logging statements', () => {
    expect(matchingLines(boundaryFiles, sensitiveLogValuePattern)).toEqual([]);
  });

  it('keeps test fixture secret literals out of production boundary files', () => {
    const matches = productionFixturePatterns.flatMap((pattern) =>
      matchingLines(boundaryFiles, pattern),
    );

    expect(matches).toEqual([]);
  });

  it('keeps plaintext-bearing FFI results out of debug formatting', () => {
    const uniffi = readFileSync(resolve(repoRoot, 'crates/mosaic-uniffi/src/lib.rs'), 'utf8');
    const wasm = readFileSync(resolve(repoRoot, 'crates/mosaic-wasm/src/lib.rs'), 'utf8');

    expect(deriveListForStruct(uniffi, 'DecryptedShardResult')).not.toMatch(/\bDebug\b/);
    expect(deriveListForStruct(wasm, 'DecryptedShardResult')).not.toMatch(/\bDebug\b/);
  });
});
