/* tslint:disable */
/* eslint-disable */

/**
 * WASM-bindgen class for account-key handle status results.
 */
export class AccountKeyHandleStatusResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Whether the handle is currently open.
     */
    readonly isOpen: boolean;
}

/**
 * WASM-bindgen class for account unlock results.
 */
export class AccountUnlockResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Opaque Rust-owned account-key handle.
     */
    readonly handle: bigint;
}

/**
 * WASM-bindgen class for auth keypair derivation results.
 */
export class AuthKeypairResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 32-byte Ed25519 LocalAuth public key. Non-secret.
     */
    readonly authPublicKey: Uint8Array;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
}

/**
 * WASM-bindgen class for byte-array results.
 */
export class BytesResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Public bytes or signature bytes.
     */
    readonly bytes: Uint8Array;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
}

/**
 * WASM-bindgen class for new-account creation results.
 */
export class CreateAccountResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Opaque Rust-owned account-key handle for the newly minted L2.
     */
    readonly handle: bigint;
    /**
     * Server-storable wrapped account key. Caller persists this; it is
     * re-supplied at the next login as the input to `unlockAccountKey`.
     */
    readonly wrappedAccountKey: Uint8Array;
}

/**
 * WASM-bindgen class for public crypto/domain golden-vector snapshots.
 */
export class CryptoDomainGoldenVectorSnapshot {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Parsed envelope epoch ID.
     */
    readonly envelopeEpochId: number;
    /**
     * Serialized 64-byte shard envelope header vector.
     */
    readonly envelopeHeader: Uint8Array;
    /**
     * Parsed envelope nonce bytes.
     */
    readonly envelopeNonce: Uint8Array;
    /**
     * Parsed envelope shard index.
     */
    readonly envelopeShardIndex: number;
    /**
     * Parsed envelope tier byte.
     */
    readonly envelopeTier: number;
    /**
     * X25519 recipient public key bytes.
     */
    readonly identityEncryptionPubkey: Uint8Array;
    /**
     * Fixed public identity signing message bytes.
     */
    readonly identityMessage: Uint8Array;
    /**
     * Ed25519 detached identity signature bytes.
     */
    readonly identitySignature: Uint8Array;
    /**
     * Ed25519 identity public key bytes.
     */
    readonly identitySigningPubkey: Uint8Array;
    /**
     * Canonical manifest transcript vector bytes.
     */
    readonly manifestTranscript: Uint8Array;
}

/**
 * WASM-bindgen class for decrypted album content results.
 */
export class DecryptedContentResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Client-local plaintext album content on successful decryption.
     */
    readonly plaintext: Uint8Array;
}

/**
 * WASM-bindgen class for decrypted shard results.
 */
export class DecryptedShardResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Client-local plaintext bytes on successful decryption.
     */
    readonly plaintext: Uint8Array;
}

/**
 * WASM-bindgen class for encrypted album content results.
 */
export class EncryptedContentResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Ciphertext including the trailing 16-byte Poly1305 tag.
     */
    readonly ciphertext: Uint8Array;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * 24-byte XChaCha20 nonce.
     */
    readonly nonce: Uint8Array;
}

/**
 * WASM-bindgen class for encrypted shard results.
 */
export class EncryptedShardResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Full encrypted shard envelope bytes.
     */
    readonly envelopeBytes: Uint8Array;
    /**
     * Base64url SHA-256 digest of the full envelope bytes.
     */
    readonly sha256: string;
}

/**
 * WASM-bindgen class for epoch-key handle results.
 */
export class EpochKeyHandleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Epoch identifier associated with this handle.
     */
    readonly epochId: number;
    /**
     * Opaque Rust-owned epoch-key handle.
     */
    readonly handle: bigint;
    /**
     * Per-epoch Ed25519 manifest signing public key, or an empty array when
     * the handle has no sign keypair attached.
     */
    readonly signPublicKey: Uint8Array;
    /**
     * Wrapped epoch seed bytes returned on creation.
     */
    readonly wrappedEpochSeed: Uint8Array;
}

/**
 * WASM-bindgen class for epoch-key handle status results.
 */
export class EpochKeyHandleStatusResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Whether the handle is currently open.
     */
    readonly isOpen: boolean;
}

/**
 * WASM-bindgen class for header parse results.
 */
export class HeaderResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Parsed epoch ID when parsing succeeds.
     */
    readonly epochId: number;
    /**
     * Parsed nonce when parsing succeeds.
     */
    readonly nonce: Uint8Array;
    /**
     * Parsed shard index when parsing succeeds.
     */
    readonly shardIndex: number;
    /**
     * Parsed tier byte when parsing succeeds.
     */
    readonly tier: number;
}

/**
 * WASM-bindgen class for identity handle results.
 */
export class IdentityHandleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * X25519 recipient public key.
     */
    readonly encryptionPubkey: Uint8Array;
    /**
     * Opaque Rust-owned identity handle.
     */
    readonly handle: bigint;
    /**
     * Ed25519 public identity key.
     */
    readonly signingPubkey: Uint8Array;
    /**
     * Wrapped identity seed bytes returned on creation.
     */
    readonly wrappedSeed: Uint8Array;
}

/**
 * WASM-bindgen class for share-link key derivation results.
 */
export class LinkKeysResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * 16-byte server-visible share-link lookup ID.
     */
    readonly linkId: Uint8Array;
    /**
     * 32-byte client-side wrapping key. Callers MUST memzero after use.
     */
    readonly wrappingKey: Uint8Array;
}

/**
 * WASM-bindgen class for opened-bundle results.
 */
export class OpenedBundleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Album identifier the bundle was issued for.
     */
    readonly albumId: string;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Epoch identifier inside the bundle payload.
     */
    readonly epochId: number;
    /**
     * 32-byte epoch seed. Callers MUST memzero after deriving tier/content keys.
     */
    readonly epochSeed: Uint8Array;
    /**
     * 32-byte recipient Ed25519 public key from the payload.
     */
    readonly recipientPubkey: Uint8Array;
    /**
     * 32-byte per-epoch Ed25519 manifest signing public key.
     */
    readonly signPublicKey: Uint8Array;
    /**
     * 32-byte per-epoch Ed25519 manifest signing seed. Callers MUST memzero.
     */
    readonly signSecretSeed: Uint8Array;
    /**
     * Bundle format version recovered from the payload.
     */
    readonly version: number;
}

/**
 * WASM-bindgen class for progress events.
 */
export class ProgressEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Completed operation steps.
     */
    readonly completedSteps: number;
    /**
     * Total operation steps.
     */
    readonly totalSteps: number;
}

/**
 * WASM-bindgen class for progress results.
 */
export class ProgressResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Flattened completed/total pairs for low-friction JS marshalling.
     */
    readonly eventPairs: Uint32Array;
}

/**
 * WASM-bindgen class for sealed bundle results.
 */
export class SealedBundleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Sealed-box ciphertext bytes.
     */
    readonly sealed: Uint8Array;
    /**
     * 32-byte sharer Ed25519 identity public key.
     */
    readonly sharerPubkey: Uint8Array;
    /**
     * 64-byte detached Ed25519 signature over `BUNDLE_SIGN_CONTEXT || sealed`.
     */
    readonly signature: Uint8Array;
}

/**
 * WASM-bindgen class for wrapped tier key results.
 */
export class WrappedTierKeyResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Wrapped tier-key ciphertext including the 16-byte Poly1305 tag.
     */
    readonly encryptedKey: Uint8Array;
    /**
     * 24-byte XChaCha20 nonce used by the wrapping AEAD.
     */
    readonly nonce: Uint8Array;
    /**
     * Shard tier byte the wrapped key grants access to.
     */
    readonly tier: number;
}

/**
 * Returns account-key handle status through WASM.
 */
export function accountKeyHandleIsOpen(handle: bigint): AccountKeyHandleStatusResult;

/**
 * Advances an album sync coordinator through a primitive WASM proof surface.
 */
export function advanceAlbumSync(album_id: string, phase: string, active_cursor: string, pending_cursor: string, rerun_requested: boolean, retry_count: number, max_retry_count: number, next_retry_unix_ms: bigint, last_error_code: number, last_error_stage: string, updated_at_unix_ms: bigint, event_kind: string, fetched_cursor: string, next_cursor: string, applied_count: number, retry_after_unix_ms: bigint, event_error_code: number): string;

/**
 * Advances a client-core upload job through a primitive WASM proof surface.
 */
export function advanceUploadJob(job_id: string, album_id: string, asset_id: string, epoch_id: number, phase: string, active_tier: number, active_shard_index: number, retry_count: number, max_retry_count: number, next_retry_unix_ms: bigint, last_error_code: number, last_error_stage: string, sync_confirmed: boolean, updated_at_unix_ms: bigint, event_kind: string, event_epoch_id: number, event_tier: number, event_shard_index: number, event_shard_id: string, event_sha256: string, event_manifest_id: string, event_manifest_version: bigint, observed_asset_id: string, retry_after_unix_ms: bigint, event_error_code: number): string;

/**
 * Builds the canonical LocalAuth challenge transcript through WASM.
 *
 * `timestamp_ms_present == false` omits the timestamp segment.
 */
export function buildAuthChallengeTranscript(username: string, timestamp_ms: bigint, timestamp_ms_present: boolean, challenge: Uint8Array): BytesResult;

/**
 * Builds canonical metadata sidecar bytes through WASM.
 */
export function canonicalMetadataSidecarBytes(album_id: Uint8Array, photo_id: Uint8Array, epoch_id: number, encoded_fields: Uint8Array): BytesResult;

/**
 * Returns the client-core state machine surface through WASM.
 */
export function clientCoreStateMachineSnapshot(): string;

/**
 * Closes an account-key handle through WASM.
 */
export function closeAccountKeyHandle(handle: bigint): number;

/**
 * Closes an epoch-key handle through WASM.
 */
export function closeEpochKeyHandle(handle: bigint): number;

/**
 * Closes an identity handle through WASM.
 */
export function closeIdentityHandle(handle: bigint): number;

/**
 * Creates a fresh account-key handle through the generated WASM binding
 * surface. Returns the opaque handle plus the wrapped account key the
 * caller must persist on the server for future logins.
 */
export function createAccount(password: Uint8Array, user_salt: Uint8Array, account_salt: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): CreateAccountResult;

/**
 * Creates a new epoch-key handle through WASM.
 */
export function createEpochKeyHandle(account_key_handle: bigint, epoch_id: number): EpochKeyHandleResult;

/**
 * Creates a new identity handle through the generated WASM binding surface.
 */
export function createIdentityHandle(account_key_handle: bigint): IdentityHandleResult;

/**
 * Returns deterministic public crypto/domain golden vectors through WASM.
 */
export function cryptoDomainGoldenVectorSnapshot(): CryptoDomainGoldenVectorSnapshot;

/**
 * Decrypts album content with an epoch handle through WASM.
 */
export function decryptAlbumContent(epoch_handle: bigint, nonce: Uint8Array, ciphertext: Uint8Array): DecryptedContentResult;

/**
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 */
export function decryptShardWithEpochHandle(handle: bigint, envelope_bytes: Uint8Array): DecryptedShardResult;

/**
 * Derives the LocalAuth Ed25519 keypair from an account-key handle through WASM.
 */
export function deriveAuthKeypairFromAccount(account_handle: bigint): AuthKeypairResult;

/**
 * Derives the password-rooted LocalAuth Ed25519 keypair through WASM.
 *
 * Used by the worker's `deriveAuthKey()` pre-auth slot to mint an auth
 * keypair before the account handle is opened. Only the 32-byte public
 * key crosses the WASM boundary.
 */
export function deriveAuthKeypairFromPassword(password: Uint8Array, user_salt: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): AuthKeypairResult;

/**
 * Derives the content key from an epoch handle through WASM.
 */
export function deriveContentKeyFromEpoch(epoch_handle: bigint): BytesResult;

/**
 * Derives the OPFS-snapshot DB session key from the L2 account key
 * referenced by `account_handle` through WASM. Caller MUST memzero the
 * returned bytes after use.
 */
export function deriveDbSessionKeyFromAccount(account_handle: bigint): BytesResult;

/**
 * Derives the (link_id, wrapping_key) pair from a share-link secret through WASM.
 */
export function deriveLinkKeys(link_secret: Uint8Array): LinkKeysResult;

/**
 * Encrypts album content with an epoch handle through WASM.
 */
export function encryptAlbumContent(epoch_handle: bigint, plaintext: Uint8Array): EncryptedContentResult;

/**
 * Encrypts metadata sidecar bytes with an epoch handle through WASM.
 */
export function encryptMetadataSidecarWithEpochHandle(handle: bigint, album_id: Uint8Array, photo_id: Uint8Array, epoch_id: number, encoded_fields: Uint8Array, shard_index: number): EncryptedShardResult;

/**
 * Encrypts shard bytes with an epoch-key handle through WASM.
 */
export function encryptShardWithEpochHandle(handle: bigint, plaintext: Uint8Array, shard_index: number, tier_byte: number): EncryptedShardResult;

/**
 * Returns epoch-key handle status through WASM.
 */
export function epochKeyHandleIsOpen(handle: bigint): EpochKeyHandleStatusResult;

/**
 * Generates a fresh share-link secret through WASM.
 */
export function generateLinkSecret(): BytesResult;

/**
 * Returns the LocalAuth Ed25519 public key for an account-key handle through WASM.
 */
export function getAuthPublicKeyFromAccount(account_handle: bigint): BytesResult;

/**
 * Returns the LocalAuth Ed25519 public key derived from `password` +
 * `user_salt` through WASM.
 */
export function getAuthPublicKeyFromPassword(password: Uint8Array, user_salt: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): BytesResult;

/**
 * Returns a tier key for an epoch handle through WASM.
 */
export function getTierKeyFromEpoch(epoch_handle: bigint, tier_byte: number): BytesResult;

/**
 * Returns an identity handle's X25519 public key through WASM.
 */
export function identityEncryptionPubkey(handle: bigint): BytesResult;

/**
 * Returns an identity handle's Ed25519 public key through WASM.
 */
export function identitySigningPubkey(handle: bigint): BytesResult;

/**
 * Imports an epoch handle from cleartext bundle payload bytes through WASM.
 * Both the epoch seed and the manifest signing seed are zeroized inside
 * Rust on every path.
 */
export function importEpochKeyHandleFromBundle(account_key_handle: bigint, epoch_id: number, epoch_seed: Uint8Array, sign_secret_seed: Uint8Array, sign_public: Uint8Array): EpochKeyHandleResult;

/**
 * Initializes an album sync coordinator through a primitive WASM proof surface.
 */
export function initAlbumSync(album_id: string, request_id: string, start_cursor: string, now_unix_ms: bigint, max_retry_count: number): string;

/**
 * Initializes a client-core upload job through a primitive WASM proof surface.
 */
export function initUploadJob(job_id: string, album_id: string, asset_id: string, epoch_id: number, now_unix_ms: bigint, max_retry_count: number): string;

/**
 * Opens an epoch-key handle through WASM.
 */
export function openEpochKeyHandle(wrapped_epoch_seed: Uint8Array, account_key_handle: bigint, epoch_id: number): EpochKeyHandleResult;

/**
 * Opens an identity handle through the generated WASM binding surface.
 */
export function openIdentityHandle(wrapped_identity_seed: Uint8Array, account_key_handle: bigint): IdentityHandleResult;

/**
 * Parses a shard envelope header through the generated WASM binding surface.
 */
export function parseEnvelopeHeader(bytes: Uint8Array): HeaderResult;

/**
 * Runs the progress probe through the generated WASM binding surface.
 */
export function progressProbe(total_steps: number, cancel_after: bigint): ProgressResult;

/**
 * Seals and signs an epoch key bundle through WASM.
 */
export function sealAndSignBundle(identity_handle: bigint, recipient_pubkey: Uint8Array, album_id: string, epoch_id: number, epoch_seed: Uint8Array, sign_secret: Uint8Array, sign_public: Uint8Array): SealedBundleResult;

/**
 * Atomically seals an epoch key bundle for `recipient_pubkey` using a
 * Rust-owned epoch handle through WASM. Bundle payload bytes never cross
 * the FFI boundary.
 */
export function sealBundleWithEpochHandle(identity_handle: bigint, epoch_handle: bigint, recipient_pubkey: Uint8Array, album_id: string): SealedBundleResult;

/**
 * Signs a LocalAuth challenge transcript with an account-key handle through WASM.
 */
export function signAuthChallengeWithAccount(account_handle: bigint, challenge_bytes: Uint8Array): BytesResult;

/**
 * Signs a LocalAuth challenge transcript with the password-rooted auth
 * keypair through WASM.
 */
export function signAuthChallengeWithPassword(password: Uint8Array, user_salt: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number, transcript_bytes: Uint8Array): BytesResult;

/**
 * Signs manifest transcript bytes with the per-epoch manifest signing key
 * attached to an epoch handle through WASM.
 */
export function signManifestWithEpochHandle(handle: bigint, transcript_bytes: Uint8Array): BytesResult;

/**
 * Signs manifest transcript bytes through WASM.
 */
export function signManifestWithIdentity(handle: bigint, transcript_bytes: Uint8Array): BytesResult;

/**
 * Unwraps an account key through the generated WASM binding surface.
 */
export function unlockAccountKey(password: Uint8Array, user_salt: Uint8Array, account_salt: Uint8Array, wrapped_account_key: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): AccountUnlockResult;

/**
 * Unwraps a wrapped key with a 32-byte wrapper key through WASM.
 */
export function unwrapKey(wrapped: Uint8Array, wrapper_key: Uint8Array): BytesResult;

/**
 * Unwraps a tier key from a share-link record through WASM.
 */
export function unwrapTierKeyFromLink(nonce: Uint8Array, encrypted_key: Uint8Array, tier_byte: number, wrapping_key: Uint8Array): BytesResult;

/**
 * Unwraps `wrapped` with the L2 account key referenced by `account_handle`
 * through WASM.
 */
export function unwrapWithAccountHandle(account_handle: bigint, wrapped: Uint8Array): BytesResult;

/**
 * Verifies and opens a sealed epoch key bundle through WASM.
 */
export function verifyAndOpenBundle(identity_handle: bigint, sealed: Uint8Array, signature: Uint8Array, sharer_pubkey: Uint8Array, expected_album_id: string, expected_min_epoch: number, allow_legacy_empty: boolean): OpenedBundleResult;

/**
 * Verifies manifest transcript bytes with a per-epoch manifest signing
 * public key through WASM.
 */
export function verifyManifestWithEpoch(transcript_bytes: Uint8Array, signature: Uint8Array, public_key: Uint8Array): number;

/**
 * Verifies manifest transcript bytes through WASM.
 */
export function verifyManifestWithIdentity(transcript_bytes: Uint8Array, signature: Uint8Array, public_key: Uint8Array): number;

/**
 * Wraps a key with a 32-byte wrapper key through WASM.
 */
export function wrapKey(key_bytes: Uint8Array, wrapper_key: Uint8Array): BytesResult;

/**
 * Wraps a tier key for share-link distribution through WASM.
 */
export function wrapTierKeyForLink(epoch_handle: bigint, tier_byte: number, wrapping_key: Uint8Array): WrappedTierKeyResult;

/**
 * Wraps `plaintext` with the L2 account key referenced by `account_handle`
 * through WASM. The L2 bytes never cross the JS boundary.
 */
export function wrapWithAccountHandle(account_handle: bigint, plaintext: Uint8Array): BytesResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_accountkeyhandlestatusresult_free: (a: number, b: number) => void;
    readonly __wbg_accountunlockresult_free: (a: number, b: number) => void;
    readonly __wbg_authkeypairresult_free: (a: number, b: number) => void;
    readonly __wbg_createaccountresult_free: (a: number, b: number) => void;
    readonly __wbg_cryptodomaingoldenvectorsnapshot_free: (a: number, b: number) => void;
    readonly __wbg_encryptedcontentresult_free: (a: number, b: number) => void;
    readonly __wbg_encryptedshardresult_free: (a: number, b: number) => void;
    readonly __wbg_epochkeyhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_headerresult_free: (a: number, b: number) => void;
    readonly __wbg_identityhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_openedbundleresult_free: (a: number, b: number) => void;
    readonly __wbg_progressevent_free: (a: number, b: number) => void;
    readonly __wbg_progressresult_free: (a: number, b: number) => void;
    readonly __wbg_sealedbundleresult_free: (a: number, b: number) => void;
    readonly accountKeyHandleIsOpen: (a: bigint) => number;
    readonly accountkeyhandlestatusresult_code: (a: number) => number;
    readonly accountkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly accountunlockresult_code: (a: number) => number;
    readonly accountunlockresult_handle: (a: number) => bigint;
    readonly advanceAlbumSync: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: bigint, n: number, o: number, p: number, q: bigint, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: bigint, z: number) => void;
    readonly advanceUploadJob: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: bigint, p: number, q: number, r: number, s: number, t: bigint, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: bigint, g1: number, h1: number, i1: bigint, j1: number) => void;
    readonly authkeypairresult_authPublicKey: (a: number, b: number) => void;
    readonly authkeypairresult_code: (a: number) => number;
    readonly buildAuthChallengeTranscript: (a: number, b: number, c: bigint, d: number, e: number, f: number) => number;
    readonly canonicalMetadataSidecarBytes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly clientCoreStateMachineSnapshot: (a: number) => void;
    readonly closeAccountKeyHandle: (a: bigint) => number;
    readonly closeEpochKeyHandle: (a: bigint) => number;
    readonly closeIdentityHandle: (a: bigint) => number;
    readonly createAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly createEpochKeyHandle: (a: bigint, b: number) => number;
    readonly createIdentityHandle: (a: bigint) => number;
    readonly createaccountresult_code: (a: number) => number;
    readonly createaccountresult_handle: (a: number) => bigint;
    readonly createaccountresult_wrappedAccountKey: (a: number, b: number) => void;
    readonly cryptoDomainGoldenVectorSnapshot: () => number;
    readonly cryptodomaingoldenvectorsnapshot_code: (a: number) => number;
    readonly cryptodomaingoldenvectorsnapshot_envelopeEpochId: (a: number) => number;
    readonly cryptodomaingoldenvectorsnapshot_envelopeHeader: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_envelopeNonce: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_envelopeShardIndex: (a: number) => number;
    readonly cryptodomaingoldenvectorsnapshot_envelopeTier: (a: number) => number;
    readonly cryptodomaingoldenvectorsnapshot_identityEncryptionPubkey: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_identityMessage: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_identitySignature: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_identitySigningPubkey: (a: number, b: number) => void;
    readonly cryptodomaingoldenvectorsnapshot_manifestTranscript: (a: number, b: number) => void;
    readonly decryptAlbumContent: (a: bigint, b: number, c: number, d: number, e: number) => number;
    readonly decryptShardWithEpochHandle: (a: bigint, b: number, c: number) => number;
    readonly deriveAuthKeypairFromAccount: (a: bigint) => number;
    readonly deriveAuthKeypairFromPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly deriveContentKeyFromEpoch: (a: bigint) => number;
    readonly deriveDbSessionKeyFromAccount: (a: bigint) => number;
    readonly deriveLinkKeys: (a: number, b: number) => number;
    readonly encryptAlbumContent: (a: bigint, b: number, c: number) => number;
    readonly encryptMetadataSidecarWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly encryptShardWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number) => number;
    readonly encryptedcontentresult_ciphertext: (a: number, b: number) => void;
    readonly encryptedcontentresult_code: (a: number) => number;
    readonly encryptedcontentresult_nonce: (a: number, b: number) => void;
    readonly encryptedshardresult_code: (a: number) => number;
    readonly encryptedshardresult_envelopeBytes: (a: number, b: number) => void;
    readonly encryptedshardresult_sha256: (a: number, b: number) => void;
    readonly epochKeyHandleIsOpen: (a: bigint) => number;
    readonly epochkeyhandleresult_code: (a: number) => number;
    readonly epochkeyhandleresult_epochId: (a: number) => number;
    readonly epochkeyhandleresult_handle: (a: number) => bigint;
    readonly epochkeyhandleresult_signPublicKey: (a: number, b: number) => void;
    readonly epochkeyhandleresult_wrappedEpochSeed: (a: number, b: number) => void;
    readonly generateLinkSecret: () => number;
    readonly getAuthPublicKeyFromAccount: (a: bigint) => number;
    readonly getAuthPublicKeyFromPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly getTierKeyFromEpoch: (a: bigint, b: number) => number;
    readonly headerresult_code: (a: number) => number;
    readonly headerresult_epochId: (a: number) => number;
    readonly headerresult_nonce: (a: number, b: number) => void;
    readonly headerresult_shardIndex: (a: number) => number;
    readonly headerresult_tier: (a: number) => number;
    readonly identityEncryptionPubkey: (a: bigint) => number;
    readonly identitySigningPubkey: (a: bigint) => number;
    readonly identityhandleresult_code: (a: number) => number;
    readonly identityhandleresult_encryptionPubkey: (a: number, b: number) => void;
    readonly identityhandleresult_handle: (a: number) => bigint;
    readonly identityhandleresult_signingPubkey: (a: number, b: number) => void;
    readonly identityhandleresult_wrappedSeed: (a: number, b: number) => void;
    readonly importEpochKeyHandleFromBundle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly initAlbumSync: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number) => void;
    readonly initUploadJob: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number) => void;
    readonly openEpochKeyHandle: (a: number, b: number, c: bigint, d: number) => number;
    readonly openIdentityHandle: (a: number, b: number, c: bigint) => number;
    readonly openedbundleresult_albumId: (a: number, b: number) => void;
    readonly openedbundleresult_code: (a: number) => number;
    readonly openedbundleresult_epochId: (a: number) => number;
    readonly openedbundleresult_epochSeed: (a: number, b: number) => void;
    readonly openedbundleresult_recipientPubkey: (a: number, b: number) => void;
    readonly openedbundleresult_signPublicKey: (a: number, b: number) => void;
    readonly openedbundleresult_signSecretSeed: (a: number, b: number) => void;
    readonly openedbundleresult_version: (a: number) => number;
    readonly parseEnvelopeHeader: (a: number, b: number) => number;
    readonly progressProbe: (a: number, b: bigint) => number;
    readonly progressevent_completedSteps: (a: number) => number;
    readonly progressevent_totalSteps: (a: number) => number;
    readonly progressresult_code: (a: number) => number;
    readonly progressresult_eventPairs: (a: number, b: number) => void;
    readonly sealAndSignBundle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
    readonly sealBundleWithEpochHandle: (a: bigint, b: bigint, c: number, d: number, e: number, f: number) => number;
    readonly sealedbundleresult_code: (a: number) => number;
    readonly sealedbundleresult_sealed: (a: number, b: number) => void;
    readonly sealedbundleresult_sharerPubkey: (a: number, b: number) => void;
    readonly sealedbundleresult_signature: (a: number, b: number) => void;
    readonly signAuthChallengeWithAccount: (a: bigint, b: number, c: number) => number;
    readonly signAuthChallengeWithPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly signManifestWithEpochHandle: (a: bigint, b: number, c: number) => number;
    readonly signManifestWithIdentity: (a: bigint, b: number, c: number) => number;
    readonly unlockAccountKey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly unwrapKey: (a: number, b: number, c: number, d: number) => number;
    readonly unwrapTierKeyFromLink: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly unwrapWithAccountHandle: (a: bigint, b: number, c: number) => number;
    readonly verifyAndOpenBundle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly verifyManifestWithEpoch: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly verifyManifestWithIdentity: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly wrapKey: (a: number, b: number, c: number, d: number) => number;
    readonly wrapTierKeyForLink: (a: bigint, b: number, c: number, d: number) => number;
    readonly wrapWithAccountHandle: (a: bigint, b: number, c: number) => number;
    readonly wrappedtierkeyresult_tier: (a: number) => number;
    readonly __wbg_epochkeyhandlestatusresult_free: (a: number, b: number) => void;
    readonly __wbg_linkkeysresult_free: (a: number, b: number) => void;
    readonly __wbg_decryptedshardresult_free: (a: number, b: number) => void;
    readonly __wbg_bytesresult_free: (a: number, b: number) => void;
    readonly __wbg_decryptedcontentresult_free: (a: number, b: number) => void;
    readonly __wbg_wrappedtierkeyresult_free: (a: number, b: number) => void;
    readonly epochkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly epochkeyhandlestatusresult_code: (a: number) => number;
    readonly wrappedtierkeyresult_code: (a: number) => number;
    readonly linkkeysresult_linkId: (a: number, b: number) => void;
    readonly wrappedtierkeyresult_encryptedKey: (a: number, b: number) => void;
    readonly decryptedshardresult_plaintext: (a: number, b: number) => void;
    readonly bytesresult_code: (a: number) => number;
    readonly bytesresult_bytes: (a: number, b: number) => void;
    readonly decryptedshardresult_code: (a: number) => number;
    readonly decryptedcontentresult_plaintext: (a: number, b: number) => void;
    readonly decryptedcontentresult_code: (a: number) => number;
    readonly wrappedtierkeyresult_nonce: (a: number, b: number) => void;
    readonly linkkeysresult_code: (a: number) => number;
    readonly linkkeysresult_wrappingKey: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
