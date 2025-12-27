/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import type { CryptoWorkerApi, PhotoMeta, EncryptedShard } from './types';

// Import real crypto functions from @mosaic/crypto
import {
  deriveKeys,
  encryptShard as cryptoEncryptShard,
  decryptShard as cryptoDecryptShard,
  verifyManifest as cryptoVerifyManifest,
  memzero,
  getArgon2Params,
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
}

// Create worker instance and expose via Comlink
const worker = new CryptoWorker();
Comlink.expose(worker);
