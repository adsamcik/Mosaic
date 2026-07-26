/**
 * P-W7.6 boundary guard — share-link key-wrapping methods MUST take an
 * opaque `EpochHandleId` as input, not a raw tier-key buffer.
 *
 * The Slice 6 cutover replaced the legacy `wrapTierKeyForLink(tierKey,
 * tier, wrappingKey)` worker contract with a handle-scoped variant
 * `wrapTierKeyForLink(epochHandleId, tier, wrappingKey)`. The tier key
 * itself is now derived inside Rust and never materialises in JavaScript
 * memory.
 *
 * This test parses `apps/web/src/workers/types.ts` and asserts:
 *
 *   1. The supported import, v2 wrap, tier import, and decrypt methods are
 *      declared on the Comlink contract.
 *   2. Legacy `createLinkShareHandle` and `wrapLinkTierHandle` writers are absent.
 *   3. `wrapLinkTierHandleV2` takes opaque handle IDs and no raw tier key.
 *   4. None of the supported methods leak raw tier-key fields.
 *
 * Like the Slice 3 epoch handle-leak test, the boundary is enforced
 * lexically against the public type declaration because that is what
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

const LINK_HANDLE_METHODS = [
  'importLinkShareHandle',
  'wrapLinkTierHandleV2',
  'importLinkTierHandle',
  'decryptShardWithLinkTierHandle',
] as const;

const FORBIDDEN_TIER_KEY_FIELDS = [
  'tierKey:',
  'thumbKey:',
  'previewKey:',
  'fullKey:',
] as const;

describe('P-W7.6 boundary guard — share-link key wrapping', () => {
  for (const methodName of LINK_HANDLE_METHODS) {
    it(`${methodName} is declared on the worker contract`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig, `${methodName} not found in workers/types.ts`).not.toBeNull();
    });

    it(`${methodName} does not advertise raw tier-key bytes in its signature`, () => {
      const sig = extractMethodSignature(typesSource, methodName);
      expect(sig).not.toBeNull();
      for (const banned of FORBIDDEN_TIER_KEY_FIELDS) {
        expect(
          sig,
          `${methodName} signature contains forbidden tier-key field "${banned}"`,
        ).not.toContain(banned);
      }
    });
  }

  it('legacy v1 share-link writers are absent from the worker contract', () => {
    expect(
      extractMethodSignature(typesSource, 'createLinkShareHandle'),
    ).toBeNull();
    expect(
      extractMethodSignature(typesSource, 'wrapLinkTierHandle'),
    ).toBeNull();
  });

  it('wrapLinkTierHandleV2 takes opaque handles, not raw tier-key bytes', () => {
    const sig = extractMethodSignature(typesSource, 'wrapLinkTierHandleV2');
    expect(sig).not.toBeNull();
    // Authoritative input: an EpochHandleId-typed parameter.
    expect(sig).toMatch(/linkShareHandleId\s*:\s*LinkShareHandleId/);
    expect(sig).toMatch(/epochHandleId\s*:\s*EpochHandleId/);
    // The pre-Slice-6 signature took `tierKey: Uint8Array` directly. That
    // shape must not be present anymore.
    expect(sig).not.toMatch(/tierKey\s*:\s*Uint8Array/);
  });

  it('link handle wrapping uses protocol tier bytes (1 | 2 | 3)', () => {
    const sig = extractMethodSignature(typesSource, 'wrapLinkTierHandleV2');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/tier\s*:\s*1\s*\|\s*2\s*\|\s*3/);
  });

  it('share-link contract has no `*Rust`-suffixed legacy methods left', () => {
    expect(typesSource).not.toMatch(/generateLinkSecret\s*\(/);
    expect(typesSource).not.toMatch(/deriveLinkKeys\s*\(/);
    expect(typesSource).not.toMatch(/wrapTierKeyForLink\s*\(/);
    expect(typesSource).not.toMatch(/unwrapTierKeyFromLink\s*\(/);
  });
});
