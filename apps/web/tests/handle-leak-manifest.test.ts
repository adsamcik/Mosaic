/**
 * Slice 4 boundary guard — `signManifestWithEpoch`,
 * `encryptManifestWithEpoch`, and `decryptManifestWithEpoch` MUST NOT
 * advertise raw secret bytes (per-epoch sign secrets, raw thumb-tier
 * keys, or epoch seeds) in their Comlink contract. The Slice 4 callers
 * (`manifest-service`, `sync-engine`, `photo-edit-service`) only ever
 * pass an opaque `EpochHandleId` for the secret-bearing parameter.
 *
 * This test parses `apps/web/src/workers/types.ts` lexically:
 *
 *   1. Each method declares an `EpochHandleId` parameter for the secret
 *      slot.
 *   2. The signature contains no legacy secret-bearing field/parameter
 *      tokens (`signSecretKey`, `epochSeed`, `readKey`, `signKeypair`).
 *
 * Boundaries are enforced at the type declaration because that is what
 * every Comlink consumer in the web tree binds against.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const typesPath = resolve(here, '../src/workers/types.ts');
const typesSource = readFileSync(typesPath, 'utf8');

/** Returns the full method signature including its return type. */
function extractMethodSignature(
  source: string,
  methodName: string,
): string | null {
  const start = source.indexOf(`${methodName}(`);
  if (start === -1) return null;
  let i = start;
  let braceDepth = 0;
  let angleDepth = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth -= 1;
    else if (ch === '<') angleDepth += 1;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === ';' && braceDepth === 0 && angleDepth === 0) {
      return source.slice(start, i + 1);
    }
    i += 1;
  }
  return null;
}

const FORBIDDEN_SECRET_TOKENS = [
  'signSecretKey',
  'signSecret',
  'epochSeed',
  'readKey:',
  'thumbKey:',
  'signKeypair',
] as const;

const SLICE_4_METHODS = [
  'signManifestWithEpoch',
  'encryptManifestWithEpoch',
  'decryptManifestWithEpoch',
] as const;

describe('Slice 4 boundary guard — manifest sign/encrypt/decrypt', () => {
  for (const methodName of SLICE_4_METHODS) {
    it(`${methodName} declares an EpochHandleId parameter`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();
      expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    });

    it(`${methodName} signature accepts only string-identified secrets, never Uint8Array key bytes`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();

      // First parameter (the secret-bearing slot) MUST be the opaque handle id.
      // Subsequent Uint8Array parameters are public ciphertext / plaintext /
      // signature payloads and are allowed to cross Comlink.
      const openParen = sig!.indexOf('(');
      const closeParen = sig!.lastIndexOf(')');
      const params = sig!.slice(openParen + 1, closeParen);
      const firstParam = params.split(',')[0]!.trim();
      expect(firstParam).toMatch(/^epochHandleId\s*:\s*EpochHandleId\s*$/);

      for (const banned of FORBIDDEN_SECRET_TOKENS) {
        expect(
          sig,
          `${methodName} signature contains forbidden secret-bearing token "${banned}"`,
        ).not.toContain(banned);
      }
    });
  }

  it('signManifestWithEpoch returns a 64-byte Ed25519 signature wire shape', () => {
    const sig = extractMethodSignature(typesSource, 'signManifestWithEpoch');
    expect(sig).not.toBeNull();
    // Returns Promise<Uint8Array> — the signature bytes; not a keypair.
    expect(sig).toMatch(/Promise<Uint8Array>/);
    expect(sig).not.toContain('publicKey:');
    expect(sig).not.toContain('secretKey:');
  });

  it('encryptManifestWithEpoch returns envelope bytes + sha256 (no key material)', () => {
    const sig = extractMethodSignature(
      typesSource,
      'encryptManifestWithEpoch',
    );
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/envelopeBytes\s*:\s*Uint8Array/);
    expect(sig).toMatch(/sha256\s*:\s*string/);
    expect(sig).not.toContain('thumbKey:');
    expect(sig).not.toContain('readKey:');
  });

  it('decryptManifestWithEpoch returns plaintext bytes (caller decodes)', () => {
    const sig = extractMethodSignature(
      typesSource,
      'decryptManifestWithEpoch',
    );
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/Promise<Uint8Array>/);
  });

  it('legacy seed-bearing manifest signatures are removed from the worker contract', () => {
    // The pre-Slice-4 contract had `encryptManifest(meta, readKey, epochId)`,
    // `decryptManifest(envelope, readKey)`, and `signManifest(payload,
    // signSecretKey)`. None of those names should remain on
    // CryptoWorkerApi after Slice 4. We match the method declaration form
    // (two-space indent + name + open paren + newline) so the legacy
    // names can still appear in `// Slice 4 — replaces …` doc comments.
    expect(typesSource).not.toMatch(/^ {2}encryptManifest\(/m);
    expect(typesSource).not.toMatch(/^ {2}decryptManifest\(/m);
    expect(typesSource).not.toMatch(/^ {2}signManifest\(/m);
  });
});
