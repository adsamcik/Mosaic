/**
 * Slice 3 boundary guard — `generateEpochKey`, `openEpochKeyBundle`, and
 * `createEpochKeyBundle` MUST NOT advertise raw secret bytes in their
 * Comlink contract. This test parses `apps/web/src/workers/types.ts` and
 * asserts:
 *
 *   1. Their declared return types contain `EpochHandleId` (or `Uint8Array`
 *      only for the publishable wrapped seed / sign public key on
 *      `generateEpochKey`), but never any of the legacy secret-bearing
 *      field names — `epochSeed`, `signSecretKey`, `signSecret`,
 *      `secretKey`.
 *   2. Their parameter list does not accept secret-bearing arguments
 *      (`createEpochKeyBundle` switched from raw seed/sign-secret bytes to
 *      an opaque `EpochHandleId`).
 *
 * The boundary is enforced lexically against the public type declaration
 * because that is what every Comlink consumer in the web tree binds
 * against. Slice 4-7 callers can then be migrated incrementally without
 * the worker leaking secrets in the meantime.
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

const FORBIDDEN_SECRET_FIELDS = [
  'epochSeed',
  'signSecretKey',
  'signSecret',
  // `secretKey:` (with the colon) appears only on object-literal types; the
  // bare token `secretKey` is permissible in identifiers like
  // `signKeypair.secretKey` parameter access elsewhere. We anchor on the
  // colon to limit the check to type fields.
  'secretKey:',
] as const;

const SLICE_3_METHODS = [
  'generateEpochKey',
  'openEpochKeyBundle',
  'createEpochKeyBundle',
] as const;

describe('Slice 3 boundary guard — epoch key lifecycle', () => {
  for (const methodName of SLICE_3_METHODS) {
    it(`${methodName} declares an EpochHandleId in its signature`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();
      expect(sig).toContain('EpochHandleId');
    });

    it(`${methodName} does not advertise raw epoch seed or sign-secret bytes`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();
      for (const banned of FORBIDDEN_SECRET_FIELDS) {
        expect(
          sig,
          `${methodName} signature contains forbidden secret-bearing token "${banned}"`,
        ).not.toContain(banned);
      }
    });
  }

  it('createEpochKeyBundle takes an opaque epoch handle id, not raw seed/sign secret bytes', () => {
    const sig = extractMethodSignature(typesSource, 'createEpochKeyBundle');
    expect(sig).not.toBeNull();
    // Authoritative input: an EpochHandleId-typed parameter.
    expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    // None of the legacy raw-byte parameters that the pre-Slice-3 contract
    // accepted may be present anymore.
    expect(sig).not.toMatch(/epochSeed\s*:\s*Uint8Array/);
    expect(sig).not.toMatch(/signSecretKey\s*:\s*Uint8Array/);
  });

  it('openEpochKeyBundle return type exposes only handle id, epoch id, and sign public key', () => {
    const sig = extractMethodSignature(typesSource, 'openEpochKeyBundle');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    expect(sig).toMatch(/epochId\s*:\s*number/);
    expect(sig).toMatch(/signPublicKey\s*:\s*Uint8Array/);
  });

  it('generateEpochKey return type exposes only handle id, wrapped seed, and sign public key', () => {
    const sig = extractMethodSignature(typesSource, 'generateEpochKey');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    // wrappedSeed is the persistable wrapped-under-account-key blob; it is
    // safe to expose because unwrapping requires the account secret.
    expect(sig).toMatch(/wrappedSeed\s*:\s*Uint8Array/);
    expect(sig).toMatch(/signPublicKey\s*:\s*Uint8Array/);
  });
});
