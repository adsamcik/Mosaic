import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 *
 * After the Rust cutover landed (Slices 1-8), the share-link, manifest,
 * sync-engine, and OPFS DB worker surfaces no longer import
 * `@mosaic/crypto` at all; they route through Rust handles. Their
 * entries have been removed from this map. The
 * `cutover slice retirement guards` describe below pins those modules
 * down with explicit "no protocol-class TS symbols imported" assertions.
 */
interface CryptoCompatibilityEntry {
  readonly rationale: string;
  /**
   * Allowed identifiers imported from `@mosaic/crypto`. Matched
   * literally ÔÇö wildcard imports are intentionally not permitted.
   */
  readonly allowedSymbols: readonly string[];
}

const tsCryptoCompatibility = new Map<string, CryptoCompatibilityEntry>([
  [
    'lib/epoch-key-store.ts',
    {
      rationale: 'epoch seed and sign-key memory wiping (shell-class)',
      allowedSymbols: ['memzero'],
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
  'deriveLinkKeys',
  'wrapTierKeyForLink',
  'unwrapTierKeyFromLink',
  'generateLinkSecret',
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

  // Wildcard imports ÔÇö `import * as crypto from '@mosaic/crypto'` ÔÇö
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
    ).toEqual(['lib/exif-stripper.ts', 'workers/rust-crypto-core.ts']);
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
      // facade". Skip the symbol comparison ÔÇö only the facade is allowed
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
     * It must never import crypto helpers ÔÇö the resolver only operates
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
     * The `notifyContentConflict` seam dispatches a sanitised payload
     * (opaque ids and counts only). Make sure the dispatch site does
     * not accidentally log key material when conflicts occur. The
     * check is lexical ÔÇö "key material" patterns we want to never see
     * in this code path.
     */
    const fullPath = resolve(srcRoot, 'lib/sync-engine.ts');
    const content = readFileSync(fullPath, 'utf8');

    // The notifyContentConflict body should not reference any of these
    // banned identifiers ÔÇö they would indicate plaintext keys leaking
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
        `notifyContentConflict references "${banned}" ÔÇö banned key-material identifier`,
      ).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 1 boundary ÔÇö handle-based methods MUST return string handle IDs only,
// never raw secret-key bytes.
// ---------------------------------------------------------------------------

const typesPath = resolve(srcRoot, 'workers/types.ts');
const typesSource = readFileSync(typesPath, 'utf8');

/**
 * Methods that mint or close handle objects. We assert each declares a
 * return type containing `HandleId` (or `void` for close methods) ÔÇö the
 * regex below is conservative; a method that returns `Uint8Array` for a
 * handle slot fails this check.
 */
const HANDLE_RETURN_METHODS = [
  // Account
  { name: 'unlockAccount', mustContain: 'AccountHandleId', mustNotContain: ['accountKey:', 'accountSeed:'] },
  { name: 'createNewAccount', mustContain: 'AccountHandleId', mustNotContain: ['accountKey:', 'accountSeed:'] },
  { name: 'getAccountHandleId', mustContain: 'AccountHandleId | null', mustNotContain: ['Uint8Array'] },
  // Identity
  { name: 'createIdentityForAccount', mustContain: 'IdentityHandleId', mustNotContain: ['identitySecretKey:', 'signingSecretKey:'] },
  { name: 'openIdentityForAccount', mustContain: 'IdentityHandleId', mustNotContain: ['identitySecretKey:', 'signingSecretKey:'] },
  // Epoch
  { name: 'createEpochHandle', mustContain: 'EpochHandleId', mustNotContain: ['epochSeed:'] },
  { name: 'openEpochHandle', mustContain: 'EpochHandleId', mustNotContain: ['epochSeed:'] },
  { name: 'getEpochHandleId', mustContain: 'EpochHandleId | null', mustNotContain: ['Uint8Array'] },
];

function extractMethodSignature(
  source: string,
  methodName: string,
): string | null {
  // Match `methodName(...): ReturnType;` allowing nested braces in either side.
  // We greedily consume from the method name to the next `;` at zero brace
  // depth ÔÇö robust enough for the typed Comlink contract.
  const start = source.indexOf(`${methodName}(`);
  if (start === -1) return null;
  let i = start;
  let depth = 0;
  let inAngle = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '<') inAngle += 1;
    else if (ch === '>') inAngle = Math.max(0, inAngle - 1);
    else if (ch === ';' && depth === 0 && inAngle === 0) {
      return source.slice(start, i + 1);
    }
    i += 1;
  }
  return null;
}

describe('web Rust cutover handle-id boundary (Slice 1)', () => {
  for (const { name, mustContain, mustNotContain } of HANDLE_RETURN_METHODS) {
    it(`${name}() declares ${mustContain} in its return type`, () => {
      const sig = extractMethodSignature(typesSource, name);
      expect(sig, `${name} method not found in workers/types.ts`).not.toBeNull();
      expect(sig).toContain(mustContain);
    });

    it(`${name}() does not leak raw secret bytes in its return type`, () => {
      const sig = extractMethodSignature(typesSource, name);
      expect(sig).not.toBeNull();
      for (const banned of mustNotContain) {
        expect(
          sig,
          `${name} return type contains forbidden secret-key field "${banned}"`,
        ).not.toContain(banned);
      }
    });
  }

  it('exposes a stable WorkerCryptoErrorCode enum mirroring Rust ClientErrorCode', () => {
    // Anchor that the enum exports the codes Slice 1 callers branch on.
    const requiredCodes = [
      'StaleHandle = 1000',
      'HandleNotFound = 1001',
      'HandleWrongKind = 1002',
      'ClosedHandle = 1003',
      'WorkerNotInitialized = 1004',
      'InvalidKeyLength = 201',
      'AuthenticationFailed = 205',
      'BundleSignatureInvalid = 216',
    ];
    for (const code of requiredCodes) {
      expect(typesSource).toContain(code);
    }
  });

  it('exports a WorkerCryptoError class with a `code` field for Comlink round-tripping', () => {
    expect(typesSource).toMatch(
      /export\s+class\s+WorkerCryptoError\s+extends\s+Error/,
    );
    expect(typesSource).toMatch(/readonly\s+code\s*:\s*WorkerCryptoErrorCode/);
  });
});

// ---------------------------------------------------------------------------
// Cutover slice retirement guards ÔÇö every module the Rust handle cutover
// migrated MUST stop importing protocol-class TypeScript crypto symbols.
//
// The per-symbol allowlist above is the positive boundary (modules that may
// still touch `@mosaic/crypto` and exactly which symbols they may use).
// The retirement guards below are the negative boundary: modules that were
// in the pre-cutover allowlist but have been migrated to Rust handles
// MUST import zero protocol-class helpers and MUST NOT pull libsodium in
// directly. A regression that re-introduces a TS crypto import to one of
// these surfaces fails the build.
// ---------------------------------------------------------------------------

interface RetiredModuleAssertion {
  readonly slice: string;
  readonly relativePath: string;
  readonly forbidLibsodium: boolean;
}

const CUTOVER_RETIRED_MODULES: readonly RetiredModuleAssertion[] = [
  // Slice 2 ÔÇö account/session bootstrap migrated to Rust account-handle contract.
  // lib/session.ts retains a single shell-class import (getArgon2Params for the
  // pre-worker Argon2id KDF). The retirement check below pins the protocol-class
  // surface closed; the per-symbol allowlist pins the shell-class surface.
  { slice: 'Slice 2 (account/session bootstrap)', relativePath: 'lib/session.ts', forbidLibsodium: false },
  // Slice 3 ÔÇö epoch key lifecycle uses Rust epoch handles end-to-end.
  // lib/epoch-key-store.ts retains a single shell-class import (memzero) for
  // wiping the legacy in-memory caches as they drain.
  { slice: 'Slice 3 (epoch key lifecycle)', relativePath: 'lib/epoch-key-store.ts', forbidLibsodium: true },
  { slice: 'Slice 3 (epoch key lifecycle)', relativePath: 'hooks/useAlbums.ts', forbidLibsodium: true },
  // Slice 4 ÔÇö manifest sign/verify + sync routes through Rust epoch handles.
  { slice: 'Slice 4 (manifest sign/verify + sync)', relativePath: 'lib/sync-engine.ts', forbidLibsodium: true },
  { slice: 'Slice 4 (manifest sign/verify + sync)', relativePath: 'lib/manifest-service.ts', forbidLibsodium: true },
  { slice: 'Slice 4 (manifest sign/verify + sync)', relativePath: 'lib/photo-edit-service.ts', forbidLibsodium: true },
  { slice: 'Slice 4 (manifest sign/verify + sync)', relativePath: 'components/Shared/SharedGallery.tsx', forbidLibsodium: true },
  // Slice 6 ÔÇö share-link key wrapping migrated to Rust handles.
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'hooks/useLinkKeys.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'hooks/useShareLinks.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'hooks/useMemberManagement.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'lib/epoch-rotation-service.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'lib/link-encoding.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'lib/link-tier-key-store.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'lib/api-types.ts', forbidLibsodium: true },
  { slice: 'Slice 6 (share-link key wrapping)', relativePath: 'lib/error-messages.ts', forbidLibsodium: true },
  // Slice 7 ÔÇö album content + UI utility uses Rust epoch handles.
  { slice: 'Slice 7 (album content + UI utility)', relativePath: 'contexts/AlbumContentContext.tsx', forbidLibsodium: true },
  // Slice 8 ÔÇö OPFS DB worker encryption routed through Rust wrap_key/unwrap_key.
  { slice: 'Slice 8 (OPFS DB worker encryption)', relativePath: 'workers/db.worker.ts', forbidLibsodium: true },
];

describe('Rust cutover slice retirement guards', () => {
  for (const { slice, relativePath, forbidLibsodium } of CUTOVER_RETIRED_MODULES) {
    it(`${slice}: ${relativePath} imports no protocol-class @mosaic/crypto symbols`, () => {
      const fullPath = resolve(srcRoot, relativePath);
      // The module MUST exist after the cutover lands. If it was deleted
      // outright by the migration, the importer-equality test above already
      // catches any regression that resurrects it.
      expect(
        existsSync(fullPath),
        `${relativePath} not found ÔÇö retirement guard cannot verify it`,
      ).toBe(true);

      const content = readFileSync(fullPath, 'utf8');
      const { symbols, hasWildcard } = extractMosaicCryptoSymbols(content);

      expect(
        hasWildcard,
        `${relativePath} uses wildcard @mosaic/crypto import after ${slice} retirement`,
      ).toBe(false);

      const protocolClassImports = [...symbols].filter((sym) =>
        PROTOCOL_CLASS_SYMBOLS.has(sym),
      );

      expect(
        protocolClassImports,
        `${relativePath} imports protocol-class TS crypto symbols (${protocolClassImports.join(', ')}) despite being retired by ${slice} ÔÇö must route through Rust handles instead`,
      ).toEqual([]);

      if (forbidLibsodium) {
        expect(
          /from\s+['"]libsodium-wrappers-sumo['"]/.test(content),
          `${relativePath} imports libsodium-wrappers-sumo directly after ${slice} retirement ÔÇö must route through the Rust crypto worker`,
        ).toBe(false);
      }
    });
  }
});
