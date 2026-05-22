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

/**
 * Thrown when the manifest-declared hash array is structurally
 * inconsistent with the shard list being verified.
 *
 * Distinct from `CorruptShardHashError` (per-entry corruption) and
 * `ShardIntegrityMismatchError` (computed-vs-expected mismatch) so
 * callers can distinguish "the manifest itself is malformed" from
 * "an individual hash entry is bad" from "the bytes on the wire are
 * wrong".
 *
 * Raised by `verifyShardListIntegrity` (HIGH `security-review-2026-05-22-06`)
 * when an `expectedHashes` array is *present* but does not have exactly one
 * entry per shard. Present-but-shorter arrays must NOT silently fall back
 * to legacy-skip semantics, or selected shards can bypass SHA-256
 * verification entirely.
 */
export class CorruptShardManifest extends Error {
  public readonly context: string;
  constructor(context: string, detail: string) {
    super(`Corrupt shard manifest: ${context}: ${detail}`);
    this.name = 'CorruptShardManifest';
    this.context = context;
  }
}

/**
 * Verifies SHA-256 for a list of shards against a manifest-declared
 * array of expected hashes, with strict presence-aware semantics.
 *
 * Fail-closed semantics (HIGH `security-review-2026-05-22-06`):
 *  - `expectedHashes == null` (`null` or `undefined`) → legacy missing
 *    path. The entire manifest pre-dates per-shard hashes; verification
 *    is skipped silently for all shards.
 *  - `expectedHashes` is present (even if empty) → MUST contain exactly
 *    `shardBytes.length` entries. Any mismatch throws
 *    `CorruptShardManifest`. Selecting a per-shard subset and silently
 *    skipping verification on the unmatched tail is forbidden.
 *  - Each per-shard entry is then run through `verifyShardIntegrity`,
 *    which fails closed on empty/whitespace/malformed values (HIGH
 *    `security-review-2026-05-22-04`).
 *
 * The hash is computed over the bytes the caller passes in. Existing
 * call sites pass the encrypted shard envelope (matching what the
 * upload pipeline hashed via `sha256Base64Url`), so the comparison is
 * on ciphertext, not plaintext.
 */
export async function verifyShardListIntegrity(
  shardBytes: ReadonlyArray<Uint8Array>,
  expectedHashes: ReadonlyArray<string> | null | undefined,
  context: string,
): Promise<void> {
  if (expectedHashes === null || expectedHashes === undefined) {
    // Legacy missing path — skip verification entirely.
    return;
  }
  if (expectedHashes.length !== shardBytes.length) {
    throw new CorruptShardManifest(
      context,
      `hash array length ${expectedHashes.length} != shard count ${shardBytes.length}`,
    );
  }
  for (let i = 0; i < shardBytes.length; i++) {
    await verifyShardIntegrity(
      shardBytes[i]!,
      expectedHashes[i]!,
      `${context}[${i}]`,
    );
  }
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
