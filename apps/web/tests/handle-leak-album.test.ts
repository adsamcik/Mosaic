/**
 * Slice 7 boundary guard — `encryptAlbumContent`, `decryptAlbumContent`,
 * `encryptAlbumName`, and `decryptAlbumName` MUST NOT advertise raw
 * secret bytes in their Comlink contract. The handle-based contract for
 * Slice 7 mirrors the Slice 3 epoch-handle guarantee: the worker takes
 * an opaque `EpochHandleId`, never an `epochSeed` / `signSecret`.
 *
 * The boundary is enforced lexically against the public
 * `apps/web/src/workers/types.ts` declaration because that is what every
 * Comlink consumer in the web tree binds against.
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
  'epochSeed',
  'signSecretKey',
  'signSecret',
  'readKey',
  'tierKey:',
  // `secretKey:` (with the colon) catches object-literal secret-key
  // fields without flagging legitimate identifier tokens elsewhere.
  'secretKey:',
] as const;

const SLICE_7_ALBUM_METHODS = [
  'encryptAlbumContent',
  'decryptAlbumContent',
  'encryptAlbumName',
  'decryptAlbumName',
] as const;

describe('Slice 7 boundary guard — album content + name handle-only contract', () => {
  for (const methodName of SLICE_7_ALBUM_METHODS) {
    it(`${methodName} accepts only an EpochHandleId, never raw secret bytes`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(
        sig,
        `${methodName} not found in workers/types.ts`,
      ).not.toBeNull();
      // Authoritative input: an `EpochHandleId`-typed parameter.
      expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    });

    it(`${methodName} does not advertise epoch seed / sign secret / tier-key bytes`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();
      for (const banned of FORBIDDEN_SECRET_TOKENS) {
        expect(
          sig,
          `${methodName} signature contains forbidden secret-bearing token "${banned}"`,
        ).not.toContain(banned);
      }
    });
  }

  it('encryptAlbumContent return shape carries only opaque ciphertext + nonce', () => {
    const sig = extractMethodSignature(typesSource, 'encryptAlbumContent');
    expect(sig).not.toBeNull();
    // Plaintext input + ciphertext/nonce output — no secret-key fields.
    expect(sig).toMatch(/plaintext\s*:\s*Uint8Array/);
    expect(sig).toMatch(/nonce\s*:\s*Uint8Array/);
    expect(sig).toMatch(/ciphertext\s*:\s*Uint8Array/);
    expect(sig).not.toMatch(/contentKey\s*:/);
  });

  it('decryptAlbumContent takes only handle id + opaque envelope inputs', () => {
    const sig = extractMethodSignature(typesSource, 'decryptAlbumContent');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/nonce\s*:\s*Uint8Array/);
    expect(sig).toMatch(/ciphertext\s*:\s*Uint8Array/);
    expect(sig).not.toMatch(/contentKey\s*:/);
    // The legacy Slice-1 contract carried `epochId: number` as an AAD
    // parameter; Slice 7 binds the epoch id internally via the handle.
    expect(sig).not.toMatch(/epochId\s*:\s*number/);
  });

  it('encryptAlbumName returns shard envelope bytes (Uint8Array), no key material', () => {
    const sig = extractMethodSignature(typesSource, 'encryptAlbumName');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/nameBytes\s*:\s*Uint8Array/);
    // Return type is just `Promise<Uint8Array>` — no { tier, key, ... }
    // shape that could leak tier-key material.
    expect(sig).toMatch(/Promise<Uint8Array>/);
  });

  it('decryptAlbumName accepts envelope bytes only (no tier-key parameter)', () => {
    const sig = extractMethodSignature(typesSource, 'decryptAlbumName');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/envelopeBytes\s*:\s*Uint8Array/);
    expect(sig).toMatch(/Promise<Uint8Array>/);
  });

  it('legacy seed-bearing album content methods are gone from the contract', () => {
    // The pre-Slice-7 contract carried `epochSeed: Uint8Array` /
    // `epochId: number` parameters on `encryptAlbumContent`. Make sure
    // those never re-appear — a regression here would silently allow
    // raw seed bytes back across Comlink.
    const encryptSig = extractMethodSignature(typesSource, 'encryptAlbumContent');
    expect(encryptSig).not.toBeNull();
    expect(encryptSig).not.toMatch(/epochSeed\s*:\s*Uint8Array/);

    const decryptSig = extractMethodSignature(typesSource, 'decryptAlbumContent');
    expect(decryptSig).not.toBeNull();
    expect(decryptSig).not.toMatch(/epochSeed\s*:\s*Uint8Array/);
  });

  it('Slice 1 `*WithEpoch` album-content aliases were retired by Slice 7', () => {
    // The transitional names `encryptAlbumContentWithEpoch` /
    // `decryptAlbumContentWithEpoch` were Slice 1 stubs; Slice 7
    // collapses them into the canonical `encryptAlbumContent` /
    // `decryptAlbumContent`. Their continued presence would imply two
    // Comlink methods for the same operation.
    expect(typesSource).not.toContain('encryptAlbumContentWithEpoch(');
    expect(typesSource).not.toContain('decryptAlbumContentWithEpoch(');
  });
});
