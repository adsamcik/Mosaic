/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import type { CryptoWorkerApi, PhotoMeta, EncryptedShard, ExportedKeys } from './types';

// Import real crypto functions from @mosaic/crypto
import {
  deriveKeys,
  deriveIdentityKeypair,
  encryptShard as cryptoEncryptShard,
  decryptShard as cryptoDecryptShard,
  verifyShard as cryptoVerifyShard,
  verifyManifest as cryptoVerifyManifest,
  signManifest as cryptoSignManifest,
  generateEpochKey as cryptoGenerateEpochKey,
  sealAndSignBundle,
  verifyAndOpenBundle,
  memzero,
  getArgon2Params,
  deriveLinkKeys as cryptoDeriveLinkKeys,
  wrapTierKeyForLink as cryptoWrapTierKeyForLink,
  unwrapTierKeyFromLink as cryptoUnwrapTierKeyFromLink,
  generateLinkSecret as cryptoGenerateLinkSecret,
  AccessTier,
  type IdentityKeypair,
} from '@mosaic/crypto';

/**
 * Crypto Worker Implementation
 *
 * Real implementation using libsodium-wrappers-sumo and @mosaic/crypto.
 * All cryptographic operations run in this dedicated worker thread.
 */
class CryptoWorker implements CryptoWorkerApi {
  /** Session key derived from password for database encryption */
  private sessionKey: Uint8Array | null = null;

  /** Account key (L2) for key hierarchy operations */
  private accountKey: Uint8Array | null = null;

  /** User identity keypair (Ed25519 + X25519) */
  private identityKeypair: IdentityKeypair | null = null;

  /** Whether libsodium has been initialized */
  private sodiumReady = false;

  /**
   * Ensure libsodium is initialized before crypto operations.
   */
  private async ensureSodiumReady(): Promise<void> {
    if (!this.sodiumReady) {
      await sodium.ready;
      this.sodiumReady = true;
    }
  }

  /**
   * Initialize crypto with user credentials.
   * Derives L0 → L1 → L2 key hierarchy using Argon2id + HKDF.
   *
   * @param password - User password
   * @param userSalt - 16-byte salt stored on server (per-user)
   * @param accountSalt - 16-byte salt stored on server (unique per account)
   */
  async init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array
  ): Promise<void> {
    await this.ensureSodiumReady();

    // Get device-appropriate Argon2 parameters
    const params = getArgon2Params();

    // Derive full key hierarchy
    const keys = await deriveKeys(password, userSalt, accountSalt, params);

    // Store account key for future operations
    this.accountKey = new Uint8Array(keys.accountKey);

    // Derive session key from account key using BLAKE2b
    // This provides a separate key for database encryption
    this.sessionKey = sodium.crypto_generichash(32, keys.accountKey);

    // Wipe intermediate keys
    memzero(keys.masterKey);
    memzero(keys.rootKey);
    // Note: Keep accountKey reference, but wipe the DerivedKeys copy
    memzero(keys.accountKey);
  }

  /**
   * Clear all keys from memory.
   */
  async clear(): Promise<void> {
    if (this.sessionKey) {
      memzero(this.sessionKey);
      this.sessionKey = null;
    }
    if (this.accountKey) {
      memzero(this.accountKey);
      this.accountKey = null;
    }
    if (this.identityKeypair) {
      memzero(this.identityKeypair.ed25519.secretKey);
      memzero(this.identityKeypair.x25519.secretKey);
      this.identityKeypair = null;
    }
  }

  /**
   * Get session key for database encryption.
   *
   * @returns Copy of the 32-byte session key
   * @throws Error if worker not initialized
   */
  async getSessionKey(): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Crypto worker not initialized');
    }
    // Return a copy to prevent external modification
    return new Uint8Array(this.sessionKey);
  }

  /**
   * Encrypt a photo shard using XChaCha20-Poly1305.
   *
   * Creates a 64-byte envelope header with fresh random nonce,
   * then encrypts data with header as AAD for tamper detection.
   *
   * @param data - Plaintext data to encrypt (max 6MB)
   * @param readKey - Epoch read key (32 bytes)
   * @param epochId - Current epoch ID
   * @param shardIndex - Shard index within photo
   * @returns Encrypted shard with SHA256 hash
   */
  async encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<EncryptedShard> {
    await this.ensureSodiumReady();
    return cryptoEncryptShard(data, readKey, epochId, shardIndex);
  }

  /**
   * Decrypt a photo shard.
   *
   * Validates envelope header, checks reserved bytes are zero,
   * then decrypts using XChaCha20-Poly1305 with header as AAD.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @param readKey - Epoch read key (32 bytes)
   * @returns Decrypted plaintext
   * @throws Error if decryption fails or envelope is invalid
   */
  async decryptShard(
    envelope: Uint8Array,
    readKey: Uint8Array
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoDecryptShard(envelope, readKey);
  }

  /**
   * Verify shard integrity against expected hash.
   * Should be called before decryption to ensure shard wasn't tampered with.
   */
  async verifyShard(
    envelope: Uint8Array,
    expectedSha256: string
  ): Promise<boolean> {
    await this.ensureSodiumReady();
    return cryptoVerifyShard(envelope, expectedSha256);
  }

  /**
   * Decrypt manifest metadata.
   *
   * Manifest metadata is encrypted as a shard (with epoch 0, shard 0),
   * containing JSON-encoded PhotoMeta.
   *
   * @param encryptedMeta - Encrypted manifest bytes (envelope format)
   * @param readKey - Epoch read key (32 bytes)
   * @returns Decrypted and parsed PhotoMeta
   */
  async decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array
  ): Promise<PhotoMeta> {
    await this.ensureSodiumReady();

    // Manifest metadata uses the envelope format
    // Epoch 0 and shard 0 are reserved for manifest metadata
    const plaintext = await cryptoDecryptShard(encryptedMeta, readKey);

    // Parse JSON from decrypted bytes
    const decoder = new TextDecoder();
    const json = decoder.decode(plaintext);

    try {
      return JSON.parse(json) as PhotoMeta;
    } catch {
      throw new Error('Failed to parse manifest metadata: invalid JSON');
    }
  }

  /**
   * Verify manifest signature using Ed25519.
   *
   * Uses domain separation (Mosaic_Manifest_v1 context prefix)
   * to prevent signature reuse attacks.
   *
   * @param manifest - Manifest bytes that were signed
   * @param signature - Ed25519 signature (64 bytes)
   * @param pubKey - Ed25519 signing public key (32 bytes)
   * @returns true if signature is valid
   */
  async verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array
  ): Promise<boolean> {
    await this.ensureSodiumReady();
    return cryptoVerifyManifest(manifest, signature, pubKey);
  }

  /**
   * Get the user's identity public key (Ed25519).
   * Returns null if identity keypair not yet derived.
   */
  async getIdentityPublicKey(): Promise<Uint8Array | null> {
    if (!this.identityKeypair) {
      return null;
    }
    return new Uint8Array(this.identityKeypair.ed25519.publicKey);
  }

  /**
   * Derive identity keypair from account key.
   * Must be called after init() and before identity-dependent operations.
   */
  async deriveIdentity(): Promise<void> {
    if (!this.accountKey) {
      throw new Error('Crypto worker not initialized');
    }
    await this.ensureSodiumReady();

    // Derive identity keypair from account key
    this.identityKeypair = deriveIdentityKeypair(this.accountKey);
  }

  /**
   * Open (decrypt) an epoch key bundle.
   */
  async openEpochKeyBundle(
    bundle: Uint8Array,
    senderPubkey: Uint8Array,
    albumId: string,
    minEpochId: number
  ): Promise<{ epochSeed: Uint8Array; signPublicKey: Uint8Array; signSecretKey: Uint8Array }> {
    if (!this.identityKeypair) {
      throw new Error('Identity not derived - call deriveIdentity() first');
    }
    await this.ensureSodiumReady();

    // Parse the bundle format: signature (64) || sealed box
    if (bundle.length < 64) {
      throw new Error('Bundle too short');
    }
    const signature = bundle.slice(0, 64);
    const sealedBox = bundle.slice(64);

    // Build validation context
    const context = {
      albumId,
      minEpochId,
    };

    // Verify and open the bundle
    const opened = verifyAndOpenBundle(
      sealedBox,
      signature,
      senderPubkey,
      this.identityKeypair,
      context
    );

    return {
      epochSeed: opened.epochSeed,
      signPublicKey: opened.signKeypair.publicKey,
      signSecretKey: opened.signKeypair.secretKey,
    };
  }

  /**
   * Create an epoch key bundle for sharing with another user.
   */
  async createEpochKeyBundle(
    albumId: string,
    epochId: number,
    epochSeed: Uint8Array,
    signPublicKey: Uint8Array,
    signSecretKey: Uint8Array,
    recipientPubkey: Uint8Array
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array }> {
    if (!this.identityKeypair) {
      throw new Error('Identity not derived - call deriveIdentity() first');
    }
    await this.ensureSodiumReady();

    // Create the epoch key bundle
    const bundle = {
      version: 1,
      albumId,
      epochId,
      recipientPubkey,
      epochSeed,
      signKeypair: {
        publicKey: signPublicKey,
        secretKey: signSecretKey,
      },
    };

    // Seal and sign the bundle
    const sealed = sealAndSignBundle(bundle, recipientPubkey, this.identityKeypair);

    return {
      encryptedBundle: sealed.sealed,
      signature: sealed.signature,
    };
  }

  /**
   * Generate a new epoch key for album creation or rotation.
   */
  async generateEpochKey(
    epochId: number
  ): Promise<{ epochSeed: Uint8Array; signPublicKey: Uint8Array; signSecretKey: Uint8Array }> {
    await this.ensureSodiumReady();

    const epochKey = cryptoGenerateEpochKey(epochId);

    return {
      epochSeed: epochKey.epochSeed,
      signPublicKey: epochKey.signKeypair.publicKey,
      signSecretKey: epochKey.signKeypair.secretKey,
    };
  }

  /**
   * Encrypt manifest metadata for upload.
   * Uses the same envelope format as shards with epoch and shard index 0.
   */
  async encryptManifest(
    meta: PhotoMeta,
    readKey: Uint8Array,
    epochId: number
  ): Promise<{ ciphertext: Uint8Array; sha256: string }> {
    await this.ensureSodiumReady();

    // Serialize metadata to JSON bytes
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(meta));

    // Encrypt using shard envelope format (epoch 0 and shard 0 are manifest convention)
    // Note: We use the actual epochId but shardIndex 0 for manifest metadata
    const encrypted = await cryptoEncryptShard(plaintext, readKey, epochId, 0);

    return {
      ciphertext: encrypted.ciphertext,
      sha256: encrypted.sha256,
    };
  }

  /**
   * Sign manifest data for upload.
   */
  async signManifest(
    manifestData: Uint8Array,
    signSecretKey: Uint8Array
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoSignManifest(manifestData, signSecretKey);
  }

  /**
   * Wrap data with the account key (L2) for secure storage.
   * Used for encrypting share link secrets.
   */
  async wrapWithAccountKey(data: Uint8Array): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    if (!this.accountKey) {
      throw new Error('Account key not initialized - call init() first');
    }

    // Generate random nonce (24 bytes for XChaCha20-Poly1305)
    const nonce = sodium.randombytes_buf(24);

    // Encrypt with XChaCha20-Poly1305
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      data,
      null, // no additional data
      null, // secret nonce (not used)
      nonce,
      this.accountKey
    );

    // Return nonce || ciphertext
    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, nonce.length);
    return result;
  }

  /**
   * Unwrap data that was encrypted with the account key (L2).
   * Used for decrypting owner-encrypted share link secrets during epoch rotation.
   */
  async unwrapWithAccountKey(wrapped: Uint8Array): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    if (!this.accountKey) {
      throw new Error('Account key not initialized - call init() first');
    }

    if (wrapped.length < 24 + 16) {
      throw new Error('Wrapped data too short (minimum 40 bytes for nonce + tag)');
    }

    // Extract nonce (first 24 bytes) and ciphertext (rest)
    const nonce = wrapped.subarray(0, 24);
    const ciphertext = wrapped.subarray(24);

    // Decrypt with XChaCha20-Poly1305
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // secret nonce (not used)
      ciphertext,
      null, // no additional data
      nonce,
      this.accountKey
    );

    return plaintext;
  }

  // =========================================================================
  // Link Sharing Operations
  // =========================================================================

  /**
   * Derive link ID and wrapping key from a link secret.
   */
  async deriveLinkKeys(linkSecret: Uint8Array): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }> {
    await this.ensureSodiumReady();
    return cryptoDeriveLinkKeys(linkSecret);
  }

  /**
   * Wrap a tier key for share link storage.
   */
  async wrapTierKeyForLink(
    tierKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }> {
    await this.ensureSodiumReady();
    const wrapped = cryptoWrapTierKeyForLink(tierKey, tier as AccessTier, wrappingKey);
    return {
      tier: wrapped.tier,
      nonce: wrapped.nonce,
      encryptedKey: wrapped.encryptedKey,
    };
  }

  /**
   * Unwrap a tier key from share link storage.
   */
  async unwrapTierKeyFromLink(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    const wrapped = {
      tier: tier as AccessTier,
      nonce,
      encryptedKey,
    };
    return cryptoUnwrapTierKeyFromLink(wrapped, tier as AccessTier, wrappingKey);
  }

  /**
   * Generate a new random link secret (32 bytes).
   */
  async generateLinkSecret(): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoGenerateLinkSecret();
  }

  // =========================================================================
  // Key Export/Import for Session Caching
  // =========================================================================

  /**
   * Export all keys for caching.
   * Returns base64-encoded keys for secure storage.
   */
  async exportKeys(): Promise<ExportedKeys | null> {
    if (!this.sessionKey || !this.accountKey || !this.identityKeypair) {
      return null;
    }

    return {
      accountKey: sodium.to_base64(this.accountKey, sodium.base64_variants.ORIGINAL),
      sessionKey: sodium.to_base64(this.sessionKey, sodium.base64_variants.ORIGINAL),
      identitySecretKey: sodium.to_base64(this.identityKeypair.ed25519.secretKey, sodium.base64_variants.ORIGINAL),
      identityPublicKey: sodium.to_base64(this.identityKeypair.ed25519.publicKey, sodium.base64_variants.ORIGINAL),
      identityX25519SecretKey: sodium.to_base64(this.identityKeypair.x25519.secretKey, sodium.base64_variants.ORIGINAL),
      identityX25519PublicKey: sodium.to_base64(this.identityKeypair.x25519.publicKey, sodium.base64_variants.ORIGINAL),
    };
  }

  /**
   * Import previously exported keys to restore session.
   */
  async importKeys(keys: ExportedKeys): Promise<void> {
    await this.ensureSodiumReady();

    // Clear any existing keys first
    await this.clear();

    // Restore keys from base64
    this.accountKey = sodium.from_base64(keys.accountKey, sodium.base64_variants.ORIGINAL);
    this.sessionKey = sodium.from_base64(keys.sessionKey, sodium.base64_variants.ORIGINAL);

    // Restore identity keypair
    this.identityKeypair = {
      ed25519: {
        publicKey: sodium.from_base64(keys.identityPublicKey, sodium.base64_variants.ORIGINAL),
        secretKey: sodium.from_base64(keys.identitySecretKey, sodium.base64_variants.ORIGINAL),
      },
      x25519: {
        publicKey: sodium.from_base64(keys.identityX25519PublicKey, sodium.base64_variants.ORIGINAL),
        secretKey: sodium.from_base64(keys.identityX25519SecretKey, sodium.base64_variants.ORIGINAL),
      },
    };
  }

  // =========================================================================
  // LocalAuth Authentication Methods
  // =========================================================================

  /** Auth context for domain separation (must match backend) */
  private static readonly AUTH_CHALLENGE_CONTEXT = 'Mosaic_Auth_Challenge_v1';

  /**
   * Sign an authentication challenge for LocalAuth login.
   * Uses the identity Ed25519 key to prove ownership.
   * 
   * Message format: context || username_len(4 BE) || username || [timestamp(8 BE)] || challenge
   */
  async signAuthChallenge(
    challenge: Uint8Array,
    username: string,
    timestamp?: number
  ): Promise<Uint8Array> {
    if (!this.identityKeypair) {
      throw new Error('Identity not derived - call deriveIdentity() first');
    }
    await this.ensureSodiumReady();

    // Build message exactly as backend expects
    const contextBytes = new TextEncoder().encode(CryptoWorker.AUTH_CHALLENGE_CONTEXT);
    const usernameBytes = new TextEncoder().encode(username);
    
    // Username length as 4 bytes big-endian
    const usernameLenBytes = new Uint8Array(4);
    new DataView(usernameLenBytes.buffer).setUint32(0, usernameBytes.length, false); // false = big-endian
    
    // Build message parts
    const parts: Uint8Array[] = [contextBytes, usernameLenBytes, usernameBytes];
    
    // Add timestamp if provided (8 bytes big-endian)
    if (timestamp !== undefined) {
      const timestampBytes = new Uint8Array(8);
      const view = new DataView(timestampBytes.buffer);
      // JavaScript numbers are 64-bit floats, but we need uint64
      // For timestamps in the valid range, this works correctly
      view.setBigUint64(0, BigInt(timestamp), false); // false = big-endian
      parts.push(timestampBytes);
    }
    
    // Add challenge
    parts.push(challenge);
    
    // Concatenate all parts
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const message = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      message.set(part, offset);
      offset += part.length;
    }
    
    // Sign with Ed25519
    return sodium.crypto_sign_detached(message, this.identityKeypair.ed25519.secretKey);
  }

  /**
   * Get the Ed25519 public key for authentication.
   * This is the "auth pubkey" stored on server for challenge verification.
   */
  async getAuthPublicKey(): Promise<Uint8Array | null> {
    if (!this.identityKeypair) {
      return null;
    }
    // Return a copy to prevent external modification
    return new Uint8Array(this.identityKeypair.ed25519.publicKey);
  }
}

// Create worker instance and expose via Comlink
const worker = new CryptoWorker();
Comlink.expose(worker);
