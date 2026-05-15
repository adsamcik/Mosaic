/**
 * Mosaic TypeScript crypto compatibility surface.
 *
 * Rust core/WASM handle APIs are the source of truth for protocol crypto.
 * This package intentionally exposes only the web compatibility helpers that
 * still have callers during the cutover plus shell-safe utilities and types.
 */

export type {
  Argon2Params,
  DeriveKeysResult,
  EncryptedShard,
  EpochKeyBundle,
  IdentityKeypair,
  ManifestEnvelope,
  PhotoMetadata,
  SealedBundle,
  ShardHeader,
  ShardReference,
} from './types';

export {
  AccessTier,
  BUNDLE_SIGN_CONTEXT,
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  KEY_SIZE,
  MANIFEST_SIGN_CONTEXT,
  MAX_SHARD_SIZE,
  NONCE_SIZE,
  ShardTier,
  TAG_SIZE,
} from './types';

export {
  ARGON2_PRESETS,
  isLowMemoryDevice,
  isMobileDevice,
  parseServerArgon2Params,
  selectRegistrationArgon2Params,
  type ServerArgon2ParamsPayload,
} from './argon2-params';

export {
  concat,
  constantTimeEqual,
  fromBase64,
  fromBytes,
  memzero,
  randomBytes,
  toBase64,
  toBytes,
} from './utils';
