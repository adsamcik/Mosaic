import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  readonly relativePath: string;
  readonly content: string;
}

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * Per-file classification of allowed `@mosaic/crypto` imports.
 *
 * Each entry pins a production module to (a) a rationale and (b) the
 * exact list of symbols it is allowed to import from `@mosaic/crypto`.
 *
 * The symbol set is the boundary that catches the most common
 * regression: a contributor adds an import of a protocol-class helper
 * (e.g. `encryptShard`, `signManifest`) to a module that currently only
 * uses shell-class helpers (`memzero`, `fromBase64`, `AccessTier`). The
 * file-level allowlist would silently approve that change; the
 * symbol-level allowlist below fails the build instead.
 *
 * "Protocol-class" symbols are anything that touches encryption,
 * signing, key derivation, or envelope construction. They should only
 * exist in `workers/crypto.worker.ts` (the central facade) and a small
 * set of upload helpers explicitly classified as compatibility debt
 * pending Rust cutover (`docs/specs/SPEC-WebTypeScriptCryptoProtocolClassification.md`).
 *
 * "Shell-class" symbols are utilities that are not security-critical:
 * memory wiping, base64 codecs, error class re-exports, public type
 * re-exports.
 */
interface CryptoCompatibilityEntry {
  readonly rationale: string;
  /**
   * Allowed identifiers imported from `@mosaic/crypto`. Matched
   * literally — wildcard imports are intentionally not permitted.
   */
  readonly allowedSymbols: readonly string[];
}

const tsCryptoCompatibility = new Map<string, CryptoCompatibilityEntry>([
  [
    'components/Shared/SharedGallery.tsx',
    {
      rationale: 'shared-link base64 decoding (shell-class)',
      allowedSymbols: ['fromBase64'],
    },
  ],
  [
    'hooks/useAlbums.ts',
    {
      rationale: 'epoch key memory wiping (shell-class)',
      allowedSymbols: ['memzero'],
    },
  ],
  [
    'hooks/useLinkKeys.ts',
    {
      rationale:
        'shared-link key unwrap compatibility pending Rust link facade',
      allowedSymbols: [
        'AccessTier',
        'AccessTierEnum',
        'constantTimeEqual',
        'decodeLinkId',
        'decodeLinkSecret',
        'deriveLinkKeys',
        'fromBase64',
        'unwrapTierKeyFromLink',
      ],
    },
  ],
  [
    'hooks/useShareLinks.ts',
    {
      rationale:
        'shared-link key wrapping compatibility pending Rust link facade',
      allowedSymbols: [
        'AccessTier',
        'AccessTierEnum',
        'deriveLinkKeys',
        'deriveTierKeys',
        'encodeLinkId',
        'encodeLinkSecret',
        'generateLinkSecret',
        'wrapTierKeyForLink',
      ],
    },
  ],
  [
    'lib/api-types.ts',
    {
      rationale: 'AccessTier API enum (shell-class type re-export)',
      allowedSymbols: ['AccessTier'],
    },
  ],
  [
    'lib/epoch-key-store.ts',
    {
      rationale: 'epoch seed and sign-key memory wiping (shell-class)',
      allowedSymbols: ['memzero'],
    },
  ],
  [
    'lib/epoch-rotation-service.ts',
    {
      rationale:
        'share-link tier rewrap compatibility pending Rust epoch-rotation facade',
      allowedSymbols: [
        'AccessTier',
        'deriveLinkKeys',
        'deriveTierKeys',
        'memzero',
        'unwrapTierKeyFromLink',
        'wrapTierKeyForLink',
      ],
    },
  ],
  [
    'lib/error-messages.ts',
    {
      rationale: 'TypeScript crypto error mapping (shell-class)',
      allowedSymbols: ['CryptoError', 'CryptoErrorCode'],
    },
  ],
  [
    'lib/session.ts',
    {
      rationale:
        'Argon2id salt-encryption KDF runs on main thread before crypto worker is initialized (security fix H1/H2)',
      allowedSymbols: ['getArgon2Params'],
    },
  ],
  [
    'lib/sync-engine.ts',
    {
      rationale: 'manifest tier-key derivation compatibility',
      allowedSymbols: ['deriveTierKeys', 'memzero'],
    },
  ],
  [
    'lib/thumbnail-generator.ts',
    {
      rationale: 'tiered image encryption compatibility pending Rust media facade',
      allowedSymbols: [
        'EncryptedShard',
        'EpochKey',
        'ShardTier',
        'deriveTierKeys',
        'encryptShard',
      ],
    },
  ],
  [
    'lib/upload/tiered-upload-handler.ts',
    {
      rationale: 'tier-key derivation compatibility pending Rust upload facade',
      allowedSymbols: ['deriveTierKeys'],
    },
  ],
  [
    'lib/upload/video-upload-handler.ts',
    {
      rationale: 'video shard encryption compatibility pending Rust media facade',
      allowedSymbols: ['ShardTier', 'deriveTierKeys', 'encryptShard'],
    },
  ],
  [
    'workers/crypto.worker.ts',
    {
      rationale: 'central TypeScript crypto compatibility facade',
      // Wildcard: this is the single seam every other module must go
      // through. The boundary test accepts any symbol here.
      allowedSymbols: ['*'],
    },
  ],
  [
    'workers/db.worker.ts',
    {
      rationale: 'local OPFS snapshot encryption (shell-class constants + memzero)',
      allowedSymbols: ['NONCE_SIZE', 'TAG_SIZE', 'memzero'],
    },
  ],
  [
    'workers/types.ts',
    {
      rationale: 'temporary EncryptedShard worker API type (shell-class)',
      allowedSymbols: ['EncryptedShard'],
    },
  ],
]);

const directSodiumPrimitiveAllowlist = new Map<string, string>([
  ['lib/session.ts', 'Argon2id salt-encryption KDF runs on main thread before crypto worker is initialized (security fix H1/H2)'],
  ['workers/crypto.worker.ts', 'central TypeScript crypto compatibility facade'],
  ['workers/db.worker.ts', 'local OPFS snapshot encryption adapter'],
]);

/**
 * Symbols from `@mosaic/crypto` that are protocol-class: encryption,
 * signing, key derivation. Any production module outside the
 * compatibility allowlist that imports these MUST migrate to the
 * Rust-backed crypto worker (`workers/rust-crypto-core.ts`).
 *
 * The list is intentionally explicit rather than a regex so adding a
 * new protocol-class helper to `@mosaic/crypto` requires a deliberate
 * change here. New helpers default to "unrestricted" so the test does
 * not flap; the file-level + symbol-level allowlists above are the
 * gate that keeps unrestricted helpers off non-allowlisted modules.
 */
const PROTOCOL_CLASS_SYMBOLS: ReadonlySet<string> = new Set([
  'encryptShard',
  'decryptShard',
  'verifyShard',
  'encryptContent',
  'decryptContent',
  'encryptManifest',
  'decryptManifest',
  'signManifest',
  'verifyManifest',
  'sealAndSignBundle',
  'verifyAndOpenBundle',
  'openEpochKeyBundle',
  'createEpochKeyBundle',
  'generateEpochKey',
  'deriveContentKey',
  'deriveAuthKeypair',
  'deriveIdentityKeypair',
  'deriveKeys',
  'unwrapAccountKey',
]);

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function collectSourceFiles(directory = srcRoot): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        return [];
      }

      return collectSourceFiles(fullPath);
    }

    if (
      !entry.isFile() ||
      !/\.(ts|tsx)$/.test(entry.name) ||
      entry.name.endsWith('.d.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.test.tsx')
    ) {
      return [];
    }

    return [
      {
        relativePath: normalizePath(relative(srcRoot, fullPath)),
        content: readFileSync(fullPath, 'utf8'),
      },
    ];
  });
}

function importersMatching(pattern: RegExp): string[] {
  return collectSourceFiles()
    .filter((file) => pattern.test(file.content))
    .map((file) => file.relativePath)
    .sort();
}

/**
 * Extract the set of identifiers imported from `@mosaic/crypto` in a
 * given source file. Handles both static `import { ... } from '@mosaic/crypto'`
 * and dynamic `await import('@mosaic/crypto')` followed by destructuring.
 *
 * The parser is intentionally simple and string-based; it only needs to
 * match the patterns this codebase uses today. New patterns (e.g. wildcard
 * imports) will not match and the test below treats that as a failure.
 */
function extractMosaicCryptoSymbols(content: string): {
  symbols: Set<string>;
  hasWildcard: boolean;
} {
  const symbols = new Set<string>();
  let hasWildcard = false;

  // Static imports: `import { a, b as c, type D } from '@mosaic/crypto';`
  const staticImportRe =
    /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"]@mosaic\/crypto(?:\/[^'"]*)?['"]/g;
  for (const match of content.matchAll(staticImportRe)) {
    const list = match[1] ?? '';
    for (const raw of list.split(',')) {
      const trimmed = raw.trim().replace(/^type\s+/, '');
      if (!trimmed) continue;
      const [imported] = trimmed.split(/\s+as\s+/);
      if (imported) symbols.add(imported.trim());
    }
  }

  // Dynamic imports with destructuring:
  //   const { a, b } = await import('@mosaic/crypto')
  // We capture the destructure pattern that immediately precedes a
  // dynamic import statement; this matches the existing call sites in
  // hooks/useShareLinks.ts and lib/upload/*.
  const dynamicImportRe =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*['"]@mosaic\/crypto(?:\/[^'"]*)?['"]\s*\)/g;
  for (const match of content.matchAll(dynamicImportRe)) {
    const list = match[1] ?? '';
    for (const raw of list.split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const [imported] = trimmed.split(/\s*:\s*/);
      if (imported) symbols.add(imported.trim());
    }
  }

  // Wildcard imports — `import * as crypto from '@mosaic/crypto'` —
  // bypass per-symbol classification and must always fail the boundary.
  if (
    /import\s*\*\s*as\s+\w+\s*from\s*['"]@mosaic\/crypto(?:\/[^'"]*)?['"]/.test(
      content,
    )
  ) {
    hasWildcard = true;
  }

  return { symbols, hasWildcard };
}

describe('web Rust crypto cutover boundaries', () => {
  it('keeps generated Rust WASM imports behind the worker Rust facade', () => {
    expect(
      importersMatching(
        /from\s+['"][^'"]*generated\/mosaic-wasm\/mosaic_wasm\.js['"]/,
      ),
    ).toEqual(['workers/rust-crypto-core.ts']);
  });

  it('keeps the Rust crypto facade behind the Comlink crypto worker', () => {
    expect(
      importersMatching(/from\s+['"][^'"]*rust-crypto-core['"]/),
    ).toEqual(['workers/crypto.worker.ts']);
  });

  it('classifies every production @mosaic/crypto import as compatibility debt', () => {
    const importers = importersMatching(
      /(?:from\s+['"]@mosaic\/crypto(?:\/[^'"]*)?['"]|import\(\s*['"]@mosaic\/crypto(?:\/[^'"]*)?['"]\s*\))/,
    );

    const unclassified = importers.filter(
      (relativePath) => !tsCryptoCompatibility.has(relativePath),
    );

    expect(unclassified).toEqual([]);
  });

  it('keeps direct libsodium primitive imports behind known worker adapters', () => {
    expect(importersMatching(/from\s+['"]libsodium-wrappers-sumo['"]/)).toEqual(
      [...directSodiumPrimitiveAllowlist.keys()].sort(),
    );
  });

  it('keeps reference-only TypeScript crypto mocks out of production web source', () => {
    expect(
      importersMatching(
        /(?:from\s+['"][^'"]*(?:@mosaic\/crypto\/mock|libs\/crypto\/src\/mock|\/src\/mock)['"]|import\(\s*['"][^'"]*(?:@mosaic\/crypto\/mock|libs\/crypto\/src\/mock|\/src\/mock)['"]\s*\))/,
      ),
    ).toEqual([]);
  });
});

// =============================================================================
// Per-symbol classification: each allowlisted module declares the exact
// `@mosaic/crypto` identifiers it may import. Catches the silent
// upgrade where a shell-class module starts pulling in protocol-class
// helpers without a SPEC update.
// =============================================================================

describe('web Rust crypto cutover per-symbol allowlist', () => {
  for (const [relativePath, entry] of tsCryptoCompatibility) {
    it(`${relativePath} only imports its declared @mosaic/crypto symbols`, () => {
      const fullPath = resolve(srcRoot, relativePath);
      const content = readFileSync(fullPath, 'utf8');
      const { symbols, hasWildcard } = extractMosaicCryptoSymbols(content);

      expect(
        hasWildcard,
        `${relativePath} uses wildcard import from @mosaic/crypto, which bypasses per-symbol classification (rationale: ${entry.rationale})`,
      ).toBe(false);

      // `*` wildcard in the allowedSymbols means "this is the central
      // facade". Skip the symbol comparison — only the facade is allowed
      // to use the full surface.
      if (entry.allowedSymbols.includes('*')) {
        return;
      }

      const unexpected = [...symbols].filter(
        (sym) => !entry.allowedSymbols.includes(sym),
      );

      expect(
        unexpected,
        `${relativePath} imports unexpected @mosaic/crypto symbols (${unexpected.join(', ')}); rationale: ${entry.rationale}`,
      ).toEqual([]);
    });
  }

  it('enforces no protocol-class helpers leak into shell-class modules', () => {
    /**
     * Cross-check: any allowlisted file whose declared symbol list
     * intersects PROTOCOL_CLASS_SYMBOLS must be either the central
     * crypto worker facade or an explicitly-classified compatibility
     * shim. If a new file is added with a protocol-class symbol but its
     * rationale does not contain "compatibility" or "facade", the test
     * surfaces it for review.
     */
    const offenders: Array<{ file: string; symbols: string[]; rationale: string }> = [];

    for (const [relativePath, entry] of tsCryptoCompatibility) {
      const protocolSymbols = entry.allowedSymbols.filter((sym) =>
        PROTOCOL_CLASS_SYMBOLS.has(sym),
      );
      if (protocolSymbols.length === 0) continue;

      const rationale = entry.rationale.toLowerCase();
      const hasJustification =
        rationale.includes('facade') ||
        rationale.includes('compatibility') ||
        rationale.includes('pending rust');

      if (!hasJustification) {
        offenders.push({
          file: relativePath,
          symbols: protocolSymbols,
          rationale: entry.rationale,
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('verifies the conflict-resolution module is shell-class (no @mosaic/crypto imports)', () => {
    /**
     * `lib/conflict-resolution.ts` is a pure deterministic merge module
     * added by Lane B for `docs/specs/SPEC-SyncConflictResolution.md`.
     * It must never import crypto helpers — the resolver only operates
     * on already-decrypted plaintext block documents and must remain
     * trivially testable without crypto setup.
     */
    const fullPath = resolve(srcRoot, 'lib/conflict-resolution.ts');
    const content = readFileSync(fullPath, 'utf8');

    expect(content).not.toMatch(/@mosaic\/crypto/);
    expect(content).not.toMatch(/libsodium-wrappers-sumo/);
    expect(content).not.toMatch(/rust-crypto-core/);
  });

  it('verifies sync-engine notifyContentConflict does not log key material', () => {
    /**
     * The new `notifyContentConflict` seam dispatches a sanitised
     * payload (opaque ids and counts only). Make sure the dispatch
     * site does not accidentally log key material when conflicts
     * occur. The check is lexical — "key material" patterns we want
     * to never see in this code path.
     */
    const fullPath = resolve(srcRoot, 'lib/sync-engine.ts');
    const content = readFileSync(fullPath, 'utf8');

    // The notifyContentConflict body should not reference any of these
    // banned identifiers — they would indicate plaintext keys leaking
    // into log output.
    const bannedInDispatch = [
      'epochSeed',
      'signSecretKey',
      'identitySecret',
      'accountKey',
    ];
    const start = content.indexOf('notifyContentConflict');
    expect(start, 'notifyContentConflict not found in sync-engine.ts').toBeGreaterThan(-1);

    // Take a window of ~1500 chars around the method to check.
    const window = content.slice(start, start + 1500);
    for (const banned of bannedInDispatch) {
      expect(
        window,
        `notifyContentConflict references "${banned}" — banned key-material identifier`,
      ).not.toContain(banned);
    }
  });
});


