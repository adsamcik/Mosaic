import { describe, expect, it } from 'vitest';
import * as crypto from '../src/index';

describe('public TypeScript crypto compatibility surface', () => {
  it('stays locked to the post-Rust-cutover export shape', () => {
    expect(Object.keys(crypto).sort()).toEqual([
      'ARGON2_PRESETS',
      'AccessTier',
      'BUNDLE_SIGN_CONTEXT',
      'CryptoError',
      'CryptoErrorCode',
      'ENVELOPE_HEADER_SIZE',
      'ENVELOPE_MAGIC',
      'ENVELOPE_VERSION',
      'KEY_SIZE',
      'MANIFEST_SIGN_CONTEXT',
      'MAX_SHARD_SIZE',
      'NONCE_SIZE',
      'ShardTier',
      'TAG_SIZE',
      'concat',
      'constantTimeEqual',
      'fromBase64',
      'fromBytes',
      'isLowMemoryDevice',
      'isMobileDevice',
      'memzero',
      'parseServerArgon2Params',
      'randomBytes',
      'selectRegistrationArgon2Params',
      'toBase64',
      'toBytes',
    ]);
  });
});
