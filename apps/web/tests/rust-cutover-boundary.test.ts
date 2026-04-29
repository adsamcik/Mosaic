import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  readonly relativePath: string;
  readonly content: string;
}

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const tsCryptoCompatibilityAllowlist = new Map<string, string>([
  ['components/Shared/SharedGallery.tsx', 'shared-link base64 decoding'],
  ['hooks/useAlbums.ts', 'epoch key memory wiping'],
  ['hooks/useLinkKeys.ts', 'shared-link key unwrap compatibility'],
  ['hooks/useShareLinks.ts', 'shared-link key wrapping compatibility'],
  ['lib/api-types.ts', 'AccessTier API enum'],
  ['lib/epoch-key-store.ts', 'epoch seed and sign-key memory wiping'],
  ['lib/epoch-rotation-service.ts', 'share-link tier rewrap compatibility'],
  ['lib/error-messages.ts', 'TypeScript crypto error mapping'],
  ['lib/session.ts', 'Argon2id salt-encryption KDF runs on main thread before crypto worker is initialized (security fix H1/H2)'],
  ['lib/sync-engine.ts', 'manifest tier-key derivation compatibility'],
  ['lib/thumbnail-generator.ts', 'tiered image encryption compatibility'],
  ['lib/upload/tiered-upload-handler.ts', 'tier-key derivation compatibility'],
  ['lib/upload/video-upload-handler.ts', 'video shard encryption compatibility'],
  ['workers/crypto.worker.ts', 'central TypeScript crypto compatibility facade'],
  ['workers/db.worker.ts', 'local OPFS snapshot encryption'],
  ['workers/types.ts', 'temporary EncryptedShard worker API type'],
]);

const directSodiumPrimitiveAllowlist = new Map<string, string>([
  ['lib/session.ts', 'Argon2id salt-encryption KDF runs on main thread before crypto worker is initialized (security fix H1/H2)'],
  ['workers/crypto.worker.ts', 'central TypeScript crypto compatibility facade'],
  ['workers/db.worker.ts', 'local OPFS snapshot encryption adapter'],
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
      (relativePath) => !tsCryptoCompatibilityAllowlist.has(relativePath),
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
