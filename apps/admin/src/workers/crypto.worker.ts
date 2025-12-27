/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { CryptoWorkerApi, PhotoMeta, EncryptedShard } from './types';

/**
 * Mock Crypto Worker Implementation
 * 
 * This is a placeholder for parallel development.
 * Will be replaced with real libsodium implementation from libs/crypto
 * when Stream A (Crypto) integration is complete.
 */
class CryptoWorker implements CryptoWorkerApi {
  private sessionKey: Uint8Array | null = null;

  async init(
    password: string,
    _userSalt: Uint8Array,
    _accountSalt: Uint8Array
  ): Promise<void> {
    // Mock: Derive session key from password using Web Crypto SHA-256
    // Real implementation will use Argon2id → HKDF key derivation
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    this.sessionKey = new Uint8Array(hashBuffer);
  }

  async clear(): Promise<void> {
    if (this.sessionKey) {
      // Clear sensitive key material
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
  }

  async getSessionKey(): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Crypto worker not initialized');
    }
    // Return a copy to prevent external modification
    return new Uint8Array(this.sessionKey);
  }

  async encryptShard(
    data: Uint8Array,
    _readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<EncryptedShard> {
    // Mock: Create fake envelope with 64-byte header
    // Real implementation will use XChaCha20-Poly1305
    const header = new Uint8Array(64);
    
    // Magic bytes: "SGzk" (0x53, 0x47, 0x7a, 0x6b)
    header[0] = 0x53;
    header[1] = 0x47;
    header[2] = 0x7a;
    header[3] = 0x6b;
    
    // Version (1 byte)
    header[4] = 0x03;
    
    // Epoch ID (4 bytes, big-endian)
    const epochView = new DataView(header.buffer);
    epochView.setUint32(5, epochId, false);
    
    // Shard index (4 bytes, big-endian)
    epochView.setUint32(9, shardIndex, false);
    
    // Nonce (24 bytes) - mock random
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);
    header.set(nonce, 13);
    
    // Reserved (27 bytes) - already zeros
    
    // Combine header + data (mock - no actual encryption)
    const ciphertext = new Uint8Array(64 + data.length);
    ciphertext.set(header);
    ciphertext.set(data, 64);

    // Compute SHA-256 hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', ciphertext);
    const hashArray = new Uint8Array(hashBuffer);
    const sha256 = btoa(String.fromCharCode(...hashArray));

    return { ciphertext, sha256 };
  }

  async decryptShard(
    envelope: Uint8Array,
    _readKey: Uint8Array
  ): Promise<Uint8Array> {
    // Mock: Strip 64-byte header
    // Real implementation will verify header and decrypt with XChaCha20-Poly1305
    if (envelope.length < 64) {
      throw new Error('Invalid envelope: too short');
    }
    
    // Verify magic bytes
    if (
      envelope[0] !== 0x53 ||
      envelope[1] !== 0x47 ||
      envelope[2] !== 0x7a ||
      envelope[3] !== 0x6b
    ) {
      throw new Error('Invalid envelope: bad magic bytes');
    }
    
    return envelope.slice(64);
  }

  async decryptManifest(
    encryptedMeta: Uint8Array,
    _readKey: Uint8Array
  ): Promise<PhotoMeta> {
    // Mock: Parse as JSON directly (no decryption)
    // Real implementation will decrypt with epoch key
    const decoder = new TextDecoder();
    const json = decoder.decode(encryptedMeta);
    
    try {
      return JSON.parse(json) as PhotoMeta;
    } catch {
      throw new Error('Failed to parse manifest metadata');
    }
  }

  async verifyManifest(
    _manifest: Uint8Array,
    _signature: Uint8Array,
    _pubKey: Uint8Array
  ): Promise<boolean> {
    // Mock: Always return true
    // Real implementation will verify Ed25519 signature
    return true;
  }
}

// Create worker instance and expose via Comlink
const worker = new CryptoWorker();
Comlink.expose(worker);
