import { CorruptShardHashError, decodeShardHash } from '../hooks/coordinator-download-runner';

// Re-export so callers handling fail-closed semantics can catch the
// manifest-corruption error without reaching back into hook-layer
// modules. `decodeShardHash` (invoked below via `verifyShardIntegrity`)
// is the source of these throws.
export { CorruptShardHashError };

/**
 * Thrown when a downloaded shard's SHA-256 does not match the
 * manifest-declared expected hash. Distinct from `CorruptShardHashError`
 * (which signals manifest-side corruption) so callers can tell apart
 * "the manifest is wrong" from "the bytes on the wire are wrong".
 */
export class ShardIntegrityMismatchError extends Error {
  public readonly context: string;
  constructor(context: string) {
    super(`Shard integrity check failed: ${context}`);
    this.name = 'ShardIntegrityMismatchError';
    this.context = context;
  }
}

/**
 * Verifies a downloaded shard envelope's SHA-256 against the
 * manifest-declared expected hash.
 *
 * Fail-closed semantics (HIGH `security-review-2026-05-22-04`):
 *  - `null` / `undefined` expected hash → skip verification (legacy
 *    pre-hash manifests; intentionally silent so old albums still work).
 *  - Empty string `''` or whitespace-only → throw `CorruptShardHashError`.
 *    A blank server-supplied hash is a corruption/tampering signal, not a
 *    "skip verify" signal.
 *  - Malformed (not base64url-decodable to 32 bytes / not 64-char hex) →
 *    throw `CorruptShardHashError` (propagated from `decodeShardHash`).
 *  - Valid hash that does not match the computed SHA-256 → throw
 *    `ShardIntegrityMismatchError`.
 *
 * The hash is computed over the raw bytes the caller passes in. All
 * existing call sites pass the encrypted shard envelope (matching what
 * the upload pipeline hashed via `sha256Base64Url`), so the comparison
 * is on ciphertext, not plaintext.
 */
export async function verifyShardIntegrity(
  shardBytes: Uint8Array,
  expectedHashValue: string | null | undefined,
  context: string,
): Promise<void> {
  if (expectedHashValue === null || expectedHashValue === undefined) {
    // Legacy missing-hash path — skip verification. decodeShardHash
    // would emit a 32-zero-byte digest here, which would never match a
    // real SHA-256, so we must short-circuit before computing.
    return;
  }
  // Throws CorruptShardHashError for empty / whitespace / malformed.
  const expected = decodeShardHash(expectedHashValue);
  const actualBuffer = await crypto.subtle.digest(
    'SHA-256',
    shardBytes as BufferSource,
  );
  const actual = new Uint8Array(actualBuffer);
  if (!constantTimeEquals(expected, actual)) {
    throw new ShardIntegrityMismatchError(context);
  }
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
