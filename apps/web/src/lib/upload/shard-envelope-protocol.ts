const SHARD_ENVELOPE_VERSION_OFFSET = 4;
const SHARD_ENVELOPE_PREFIX_BYTES = SHARD_ENVELOPE_VERSION_OFFSET + 1;
const SHARD_ENVELOPE_MAGIC = Uint8Array.of(
  'S'.charCodeAt(0),
  'G'.charCodeAt(0),
  'z'.charCodeAt(0),
  'k'.charCodeAt(0),
);

export const SHARD_BLOB_FORMAT_VERSION = 1;
export const SUPPORTED_SHARD_ENVELOPE_VERSIONS = new Set([3, 4]);

export interface ShardEnvelopeProtocol {
  readonly envelopeVersion: number;
  readonly blobFormatVersion: number;
}

/**
 * Reads protocol metadata from the exact encrypted bytes that will be
 * uploaded. This keeps TUS metadata and manifest finalization aligned with
 * the authenticated envelope header instead of a caller-maintained default.
 */
export function readShardEnvelopeProtocol(
  envelopeBytes: Uint8Array,
): ShardEnvelopeProtocol {
  if (envelopeBytes.byteLength < SHARD_ENVELOPE_PREFIX_BYTES) {
    throw new Error('encrypted shard is missing its envelope prefix');
  }
  for (let index = 0; index < SHARD_ENVELOPE_MAGIC.byteLength; index += 1) {
    if (envelopeBytes[index] !== SHARD_ENVELOPE_MAGIC[index]) {
      throw new Error('encrypted shard has invalid envelope magic');
    }
  }

  const envelopeVersion = envelopeBytes[SHARD_ENVELOPE_VERSION_OFFSET]!;
  if (!SUPPORTED_SHARD_ENVELOPE_VERSIONS.has(envelopeVersion)) {
    throw new Error(
      `encrypted shard has unsupported envelope version ${String(envelopeVersion)}`,
    );
  }

  return {
    envelopeVersion,
    blobFormatVersion: SHARD_BLOB_FORMAT_VERSION,
  };
}
