/**
 * Mosaic Crypto Library - Envelope Module
 *
 * Implements the 64-byte shard envelope header format
 * with XChaCha20-Poly1305 AEAD encryption.
 *
 * Header Format (64 bytes):
 * - Magic:    4 bytes  "SGzk" (0x53 0x47 0x7a 0x6b)
 * - Version:  1 byte   0x03
 * - EpochID:  4 bytes  Little-endian u32
 * - ShardID:  4 bytes  Little-endian u32
 * - Nonce:    24 bytes Random (MUST be unique per encryption)
 * - Tier:     1 byte   ShardTier enum (1=thumb, 2=preview, 3=original)
 * - Reserved: 26 bytes MUST be zero (validated on decrypt)
 */

import sodium from 'libsodium-wrappers-sumo';
import {
  CryptoError,
  CryptoErrorCode,
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  KEY_SIZE,
  NONCE_SIZE,
  MAX_SHARD_SIZE,
  ShardTier,
  type ShardHeader,
  type EncryptedShard,
} from './types';
import { sha256 } from './utils';

/** Magic bytes as Uint8Array */
const MAGIC_BYTES = new Uint8Array([0x53, 0x47, 0x7a, 0x6b]); // "SGzk"

/** Offset positions in header */
const OFFSET_MAGIC = 0;
const OFFSET_VERSION = 4;
const OFFSET_EPOCH_ID = 5;
const OFFSET_SHARD_ID = 9;
const OFFSET_NONCE = 13;
const OFFSET_TIER = 37;
const OFFSET_RESERVED = 38;

/** Reserved bytes length (reduced by 1 for tier byte) */
const RESERVED_LENGTH = 26;

/**
 * Build a shard envelope header.
 * Nonce is always fresh random bytes.
 *
 * @param epochId - Epoch identifier
 * @param shardId - Shard index within photo
 * @param tier - Shard content tier (thumb, preview, original)
 * @returns 64-byte header
 */
function buildHeader(
  epochId: number,
  shardId: number,
  tier: ShardTier,
): Uint8Array {
  const header = new Uint8Array(ENVELOPE_HEADER_SIZE);
  const view = new DataView(header.buffer);

  // Magic (4 bytes)
  header.set(MAGIC_BYTES, OFFSET_MAGIC);

  // Version (1 byte)
  header[OFFSET_VERSION] = ENVELOPE_VERSION;

  // EpochID (4 bytes, little-endian)
  view.setUint32(OFFSET_EPOCH_ID, epochId, true);

  // ShardID (4 bytes, little-endian)
  view.setUint32(OFFSET_SHARD_ID, shardId, true);

  // Nonce (24 bytes) - CRITICAL: always fresh random bytes
  const nonce = sodium.randombytes_buf(NONCE_SIZE);
  header.set(nonce, OFFSET_NONCE);

  // Tier (1 byte)
  header[OFFSET_TIER] = tier;

  // Reserved (26 bytes) - already zeroed from Uint8Array constructor

  return header;
}

/**
 * Parse and validate an envelope header.
 *
 * @param envelope - Complete envelope (header + ciphertext)
 * @returns Parsed header fields
 * @throws CryptoError if header is invalid
 */
function parseHeader(envelope: Uint8Array): ShardHeader {
  if (envelope.length < ENVELOPE_HEADER_SIZE) {
    throw new CryptoError(
      `Envelope too short: ${envelope.length} bytes, minimum ${ENVELOPE_HEADER_SIZE}`,
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }

  // Stryker disable next-line MethodExpression: slice creates a copy for DataView; using envelope directly is semantically equivalent as we only access fixed offsets
  const header = envelope.slice(0, ENVELOPE_HEADER_SIZE);
  const view = new DataView(header.buffer, header.byteOffset);

  // Validate magic
  // Stryker disable next-line MethodExpression,ArithmeticOperator: slice bounds mutations are equivalent since loop only accesses indices 0-3
  const magic = header.slice(OFFSET_MAGIC, OFFSET_MAGIC + 4);
  // Stryker disable next-line EqualityOperator: loop running 5 times compares undefined !== undefined which is false (no throw), semantically equivalent
  for (let i = 0; i < 4; i++) {
    if (magic[i] !== MAGIC_BYTES[i]) {
      throw new CryptoError(
        'Invalid envelope magic bytes',
        CryptoErrorCode.INVALID_ENVELOPE,
      );
    }
  }

  // Validate version
  const version = header[OFFSET_VERSION];
  if (version !== ENVELOPE_VERSION) {
    throw new CryptoError(
      `Unsupported envelope version: ${version}, expected ${ENVELOPE_VERSION}`,
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }

  // Parse and validate tier
  const tierByte = header[OFFSET_TIER]!;
  if (tierByte < ShardTier.THUMB || tierByte > ShardTier.ORIGINAL) {
    throw new CryptoError(
      `Invalid shard tier: ${tierByte}`,
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }
  const tier = tierByte as ShardTier;

  // Validate reserved bytes are zero
  const reserved = header.slice(
    OFFSET_RESERVED,
    OFFSET_RESERVED + RESERVED_LENGTH,
  );
  for (let i = 0; i < RESERVED_LENGTH; i++) {
    if (reserved[i] !== 0) {
      throw new CryptoError(
        'Invalid envelope: reserved bytes must be zero',
        CryptoErrorCode.RESERVED_NOT_ZERO,
      );
    }
  }

  return {
    magic: ENVELOPE_MAGIC,
    version,
    epochId: view.getUint32(OFFSET_EPOCH_ID, true),
    shardId: view.getUint32(OFFSET_SHARD_ID, true),
    nonce: header.slice(OFFSET_NONCE, OFFSET_NONCE + NONCE_SIZE),
    tier,
    reserved,
  };
}

/**
 * Encrypt data into a shard envelope.
 *
 * Uses XChaCha20-Poly1305 with the header as AAD (authenticated additional data).
 * This ensures header tampering is detected during decryption.
 *
 * @param data - Plaintext data to encrypt (max 6MB)
 * @param tierKey - Tier-specific encryption key (32 bytes)
 * @param epochId - Current epoch ID
 * @param shardIndex - Shard index within photo
 * @param tier - Content tier (thumb, preview, original)
 * @returns Encrypted shard with SHA256 hash
 * @throws CryptoError if inputs are invalid
 */
export async function encryptShard(
  data: Uint8Array,
  tierKey: Uint8Array,
  epochId: number,
  shardIndex: number,
  tier: ShardTier = ShardTier.ORIGINAL,
): Promise<EncryptedShard> {
  if (tierKey.length !== KEY_SIZE) {
    throw new CryptoError(
      `Tier key must be ${KEY_SIZE} bytes, got ${tierKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  if (data.length > MAX_SHARD_SIZE) {
    throw new CryptoError(
      `Shard data too large: ${data.length} bytes, maximum ${MAX_SHARD_SIZE}`,
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }

  // Build header with fresh random nonce and tier
  const header = buildHeader(epochId, shardIndex, tier);
  const nonce = header.slice(OFFSET_NONCE, OFFSET_NONCE + NONCE_SIZE);

  // Encrypt with header as AAD
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    data,
    header, // AAD - authenticated additional data
    null, // nsec (unused in this algorithm)
    nonce,
    tierKey,
  );

  // Combine header + ciphertext
  const envelope = new Uint8Array(ENVELOPE_HEADER_SIZE + ciphertext.length);
  envelope.set(header, 0);
  envelope.set(ciphertext, ENVELOPE_HEADER_SIZE);

  // Compute hash for manifest
  const hash = await sha256(envelope);

  return {
    ciphertext: envelope,
    sha256: hash,
  };
}

/**
 * Decrypt a shard envelope.
 *
 * Validates header, checks reserved bytes, then decrypts.
 * Header tampering is detected via AAD verification.
 * Use peekHeader() first to determine the tier and select the correct key.
 *
 * @param envelope - Complete envelope (header + ciphertext)
 * @param tierKey - Tier-specific decryption key (32 bytes)
 * @returns Decrypted plaintext
 * @throws CryptoError if decryption fails or envelope is invalid
 */
export async function decryptShard(
  envelope: Uint8Array,
  tierKey: Uint8Array,
): Promise<Uint8Array> {
  if (tierKey.length !== KEY_SIZE) {
    throw new CryptoError(
      `Tier key must be ${KEY_SIZE} bytes, got ${tierKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Parse and validate header (includes reserved byte check)
  const headerData = parseHeader(envelope);

  const header = envelope.slice(0, ENVELOPE_HEADER_SIZE);
  const ciphertext = envelope.slice(ENVELOPE_HEADER_SIZE);

  if (ciphertext.length === 0) {
    throw new CryptoError(
      'Envelope has no ciphertext',
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }

  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // nsec (unused)
      ciphertext,
      header, // AAD
      headerData.nonce,
      tierKey,
    );
    return plaintext;
  } catch (error) {
    throw new CryptoError(
      'Decryption failed - wrong key or tampered data',
      CryptoErrorCode.DECRYPTION_FAILED,
      error,
    );
  }
}

/**
 * Parse shard header without decrypting.
 * Useful for routing shards to correct epoch key and tier key.
 *
 * @param envelope - Complete envelope
 * @returns Parsed header fields (epochId, shardId, tier, nonce)
 * @throws CryptoError if header is malformed
 */
export function peekHeader(envelope: Uint8Array): {
  epochId: number;
  shardId: number;
  tier: ShardTier;
  nonce: Uint8Array;
} {
  const header = parseHeader(envelope);
  return {
    epochId: header.epochId,
    shardId: header.shardId,
    tier: header.tier,
    nonce: header.nonce,
  };
}

/**
 * Parse full shard header.
 *
 * @param envelope - Complete envelope
 * @returns Complete ShardHeader
 */
export function parseShardHeader(envelope: Uint8Array): ShardHeader {
  return parseHeader(envelope);
}

/**
 * Verify shard integrity against expected hash.
 *
 * @param envelope - Downloaded envelope
 * @param expectedSha256 - Hash from manifest (base64url)
 * @returns true if hash matches
 */
export async function verifyShard(
  envelope: Uint8Array,
  expectedSha256: string,
): Promise<boolean> {
  const actualHash = await sha256(envelope);
  return actualHash === expectedSha256;
}
