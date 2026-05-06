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

export class ApplyEventResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly newStateCbor: Uint8Array;
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

export class BuildPlanResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly errorDetail: string;
    readonly planCbor: Uint8Array;
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

export class CommitSnapshotResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly checksum: Uint8Array;
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
 * WASM-bindgen class for link-share handle creation results.
 */
export class CreateLinkShareHandleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly encryptedKey: Uint8Array;
    readonly handle: bigint;
    readonly linkId: Uint8Array;
    /**
     * Bearer URL fragment token allowed by the link-share protocol.
     */
    readonly linkUrlToken: Uint8Array;
    readonly nonce: Uint8Array;
    readonly tier: number;
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
 * WASM-bindgen class for stateless seed-based decrypted shard results.
 */
export class DecryptShardResult {
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
 * WASM-bindgen class for image inspection results.
 */
export class ImageInspectResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Camera make extracted from EXIF, or empty when absent.
     */
    readonly cameraMake: string;
    /**
     * Camera model extracted from EXIF, or empty when absent.
     */
    readonly cameraModel: string;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Device timestamp extracted from EXIF, valid when `hasDeviceTimestampMs` is true.
     */
    readonly deviceTimestampMs: bigint;
    /**
     * Compact encoded canonical metadata sidecar fields.
     */
    readonly encodedSidecarFields: Uint8Array;
    /**
     * Stable media format code derived from container bytes (JPEG=1, PNG=2, WebP=3, AVIF=4, HEIC=5).
     */
    readonly format: number;
    readonly gpsAccuracyMeters: number;
    readonly gpsAltitudeMeters: number;
    readonly gpsLatMicrodegrees: number;
    readonly gpsLonMicrodegrees: number;
    /**
     * Whether `deviceTimestampMs` carries an extracted EXIF timestamp.
     */
    readonly hasDeviceTimestampMs: boolean;
    /**
     * Whether GPS fields were extracted from EXIF.
     */
    readonly hasGps: boolean;
    /**
     * Whether `subsecondsMs` carries extracted EXIF subseconds.
     */
    readonly hasSubsecondsMs: boolean;
    /**
     * Display height after orientation normalization.
     */
    readonly height: number;
    /**
     * Trusted MIME type derived from container bytes.
     */
    readonly mimeType: string;
    /**
     * EXIF orientation value normalized by the Rust media parser.
     */
    readonly orientation: number;
    /**
     * EXIF subseconds in milliseconds, valid when `hasSubsecondsMs` is true.
     */
    readonly subsecondsMs: number;
    /**
     * Display width after orientation normalization.
     */
    readonly width: number;
}

/**
 * WASM-bindgen class for imported link-tier handle results.
 */
export class LinkTierHandleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly handle: bigint;
    readonly linkId: Uint8Array;
    readonly tier: number;
}

export class LoadSnapshotResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly schemaVersionLoaded: number;
    readonly snapshotCbor: Uint8Array;
}

/**
 * WASM-bindgen class for one canonical media tier.
 */
export class MediaTierDimensions {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Canonical max height for this tier.
     */
    readonly height: number;
    /**
     * Shard tier protocol byte.
     */
    readonly tier: number;
    /**
     * Canonical max width for this tier.
     */
    readonly width: number;
}

/**
 * WASM-bindgen class for canonical media tier dimensions.
 */
export class MediaTierLayoutResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Canonical original tier dimensions.
     */
    readonly original: MediaTierDimensions;
    /**
     * Canonical preview tier dimensions.
     */
    readonly preview: MediaTierDimensions;
    /**
     * Canonical thumbnail tier dimensions.
     */
    readonly thumbnail: MediaTierDimensions;
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

export class SerializeSnapshotResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly body: Uint8Array;
    readonly checksum: Uint8Array;
    readonly code: number;
}

/**
 * WASM-visible shard tiers pinned to the Mosaic envelope wire protocol.
 */
export enum ShardTier {
    Thumbnail = 1,
    Preview = 2,
    Original = 3,
}

/**
 * WASM-bindgen class for finalized streaming envelope results.
 */
export class StreamingEnvelopeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Full v0x04 streaming envelope bytes: header followed by frames.
     */
    readonly bytes: Uint8Array;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Plaintext byte length of the final frame.
     */
    readonly finalFrameSize: number;
    /**
     * Declared frame count.
     */
    readonly frameCount: number;
    /**
     * Final v0x04 streaming envelope header bytes.
     */
    readonly header: Uint8Array;
}

/**
 * WASM-bindgen class for streaming encrypted/decrypted frame results.
 */
export class StreamingFrameResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Serialized frame bytes.
     */
    readonly bytes: Uint8Array;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Zero-based frame index assigned by the streaming encryptor.
     */
    readonly frameIndex: number;
}

/**
 * Stateful v0x04 streaming shard decryptor exposed to WASM.
 */
export class StreamingShardDecryptor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypts one serialized streaming frame.
     */
    decryptFrame(_frame: Uint8Array): any;
    /**
     * Returns a `BytesResult` whose `bytes` field is always empty by contract.
     * Future callers should ignore `bytes` and check only `code`. Reason: the
     * finalize step performs final-frame AAD verification only — there is no
     * payload data to return. UniFFI mirror returns `Result<(), MosaicError>` honestly;
     * WASM uses `BytesResult` for cross-API uniformity.
     */
    finalize(): any;
    /**
     * Initializes a streaming decryptor from a v0x04 envelope header.
     */
    constructor(_epoch_handle_id: bigint, _envelope_header: Uint8Array);
}

/**
 * Stateful v0x04 streaming shard encryptor exposed to WASM.
 */
export class StreamingShardEncryptor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Encrypts one plaintext frame.
     */
    encryptFrame(_plaintext: Uint8Array): any;
    /**
     * Finalizes the stream and returns the v0x04 envelope.
     */
    finalize(): any;
    /**
     * Initializes a streaming encryptor for an existing epoch handle.
     */
    constructor(_epoch_handle_id: bigint, _tier: number, _expected_frame_count?: number | null);
}

/**
 * WASM-bindgen class for metadata stripping results.
 */
export class StripResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Number of metadata container segments removed.
     */
    readonly removedMetadataCount: number;
    /**
     * Image or video bytes after metadata stripping.
     */
    readonly strippedBytes: Uint8Array;
}

/**
 * WASM-bindgen class for stateless shard integrity verification results.
 */
export class VerifyShardResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
}

export class VerifySnapshotResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly code: number;
    readonly valid: boolean;
}

/**
 * WASM-bindgen class for video inspection results.
 */
export class VideoInspectResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stable error code. Zero means success.
     */
    readonly code: number;
    /**
     * Trusted video container label derived from bytes.
     */
    readonly container: string;
    /**
     * Video duration in milliseconds.
     */
    readonly durationMs: bigint;
    /**
     * Video frame rate in frames per second, or NaN when unavailable.
     */
    readonly frameRateFps: number;
    /**
     * Video track height in pixels.
     */
    readonly heightPx: number;
    /**
     * Rotation label, or empty string when unavailable.
     */
    readonly orientation: string;
    /**
     * Trusted codec label, or empty string when unavailable.
     */
    readonly videoCodec: string;
    /**
     * Video track width in pixels.
     */
    readonly widthPx: number;
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
export function advanceUploadJob(job_id: string, album_id: string, idempotency_key: string, phase: string, retry_count: number, max_retry_count: number, next_retry_not_before_ms: bigint, has_next_retry_not_before_ms: boolean, snapshot_revision: bigint, last_effect_id: string, event_kind: string, event_effect_id: string, event_tier: number, event_shard_index: number, event_shard_id: string, event_sha256: Uint8Array, event_content_length: bigint, event_envelope_version: number, event_asset_id: string, event_since_metadata_version: bigint, event_recovery_outcome: string, event_now_ms: bigint, event_base_backoff_ms: bigint, event_server_retry_after_ms: bigint, event_has_server_retry_after_ms: boolean, event_error_code: number, event_target_phase: string): string;

/**
 * Builds the canonical LocalAuth challenge transcript through WASM.
 *
 * `timestamp_ms_present == false` omits the timestamp segment.
 */
export function buildAuthChallengeTranscript(username: string, timestamp_ms: bigint, timestamp_ms_present: boolean, challenge: Uint8Array): BytesResult;

/**
 * Builds the canonical v1 share-link URL in Rust so web callers do not
 * duplicate route assembly logic. The fragment token is a bearer token by
 * design and remains after `#k=` so it is never sent to the server.
 */
export function buildShareLinkUrl(base_url: string, album_id: string, link_id: string, link_url_token: string): string;

/**
 * Builds canonical metadata sidecar bytes through WASM.
 */
export function canonicalMetadataSidecarBytes(album_id: Uint8Array, photo_id: Uint8Array, epoch_id: number, encoded_fields: Uint8Array): BytesResult;

/**
 * Returns the canonical media tier dimensions through WASM.
 */
export function canonicalTierLayout(): MediaTierLayoutResult;

/**
 * Builds canonical video metadata sidecar bytes through WASM.
 */
export function canonicalVideoSidecarBytes(album_id: Uint8Array, photo_id: Uint8Array, epoch_id: number, input_bytes: Uint8Array): BytesResult;

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
 * Closes a share-link handle through WASM.
 */
export function closeLinkShareHandle(handle: bigint): number;

/**
 * Closes a link-tier handle through WASM.
 */
export function closeLinkTierHandle(handle: bigint): number;

/**
 * Consumes a session L0 handle and returns one short-lived AES-GCM import buffer.
 *
 * WebCrypto cannot import a Rust-owned handle directly, so the web boundary
 * immediately imports these 32 bytes with `extractable = false` and zeroizes
 * the returned `Uint8Array`. The Rust handle is removed and the registry copy
 * is zeroized before this function returns, limiting raw L0 exposure to the
 * WebCrypto import handoff.
 */
export function consumeMasterKeyHandleForAesGcm(handle: bigint): Uint8Array;

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
 * Creates a share-link handle and first wrapped tier through WASM.
 */
export function createLinkShareHandle(album_id: string, epoch_handle: bigint, tier_byte: number): CreateLinkShareHandleResult;

/**
 * Returns deterministic public crypto/domain golden vectors through WASM.
 */
export function cryptoDomainGoldenVectorSnapshot(): CryptoDomainGoldenVectorSnapshot;

/**
 * Decrypts album content with an epoch handle through WASM.
 */
export function decryptAlbumContent(epoch_handle: bigint, nonce: Uint8Array, ciphertext: Uint8Array): DecryptedContentResult;

/**
 * Decrypts a v0x03/v0x04 envelope using the epoch-handle dispatcher surface.
 */
export function decryptEnvelope(epoch_handle_id: bigint, envelope: Uint8Array): any;

/**
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 */
export function decryptShardWithEpochHandle(handle: bigint, envelope_bytes: Uint8Array): DecryptedShardResult;

/**
 * Decrypts a legacy raw-key shard envelope with an epoch-key handle through WASM.
 */
export function decryptShardWithLegacyRawKeyHandle(handle: bigint, envelope_bytes: Uint8Array): DecryptedShardResult;

/**
 * Decrypts a shard using a link-tier handle through WASM.
 */
export function decryptShardWithLinkTierHandle(link_tier_handle: bigint, envelope_bytes: Uint8Array): DecryptedShardResult;

/**
 * Stateless seed-based shard decrypt through WASM.
 */
export function decryptShardWithSeedV1(envelope: Uint8Array, key: Uint8Array): DecryptShardResult;

/**
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 *
 * The shard tier is read from the envelope header by the client core.
 */
export function decryptShardWithTier(handle: bigint, envelope_bytes: Uint8Array): BytesResult;

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
 * Derives the session L0 master key and stores it behind an opaque handle.
 */
export function deriveMasterKeyFromPassword(password: Uint8Array, salt: Uint8Array, ops_limit: number, mem_limit_kib: number): bigint;

/**
 * Derives the 16-byte deterministic session Argon2id salt.
 */
export function deriveSessionSaltFromUsername(domain: string, username: string): Uint8Array;

/**
 * Applies a download state-machine event through WASM.
 */
export function downloadApplyEventV1(state_cbor: Uint8Array, event_cbor: Uint8Array): ApplyEventResult;

/**
 * Builds a canonical download plan through WASM.
 */
export function downloadBuildPlanV1(input_cbor: Uint8Array): BuildPlanResult;

/**
 * Commits a canonical download snapshot through WASM.
 */
export function downloadCommitSnapshotV1(snapshot_cbor: Uint8Array): CommitSnapshotResult;

/**
 * Initializes a canonical download snapshot through WASM.
 */
export function downloadInitSnapshotV1(input_cbor: Uint8Array): SerializeSnapshotResult;

/**
 * Loads and canonicalizes a checksum-protected download snapshot through WASM.
 */
export function downloadLoadSnapshotV1(snapshot_cbor: Uint8Array, checksum: Uint8Array): LoadSnapshotResult;

/**
 * Verifies a download snapshot checksum through WASM.
 */
export function downloadVerifySnapshotV1(snapshot_cbor: Uint8Array, checksum: Uint8Array): VerifySnapshotResult;

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
 * Encrypts shard bytes with an epoch-key handle and typed shard tier through WASM.
 */
export function encryptShardWithTier(handle: bigint, plaintext: Uint8Array, shard_index: number, tier: ShardTier): EncryptedShardResult;

/**
 * Returns epoch-key handle status through WASM.
 */
export function epochKeyHandleIsOpen(handle: bigint): EpochKeyHandleStatusResult;

/**
 * Returns the ADR-022 canonical manifest-finalize idempotency key through WASM.
 */
export function finalizeIdempotencyKey(job_id: string): string;

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
 * Returns an identity handle's X25519 public key through WASM.
 */
export function identityEncryptionPubkey(handle: bigint): BytesResult;

/**
 * Returns an identity handle's Ed25519 public key through WASM.
 */
export function identitySigningPubkey(handle: bigint): BytesResult;

/**
 * Imports a URL fragment seed into a share-link handle through WASM.
 */
export function importLinkShareHandle(link_url_token: Uint8Array): LinkTierHandleResult;

/**
 * Imports a wrapped tier key into a link-tier handle through WASM.
 */
export function importLinkTierHandle(link_url_token: Uint8Array, nonce: Uint8Array, encrypted_key: Uint8Array, album_id: string, tier_byte: number): LinkTierHandleResult;

/**
 * Initializes an album sync coordinator through a primitive WASM proof surface.
 */
export function initAlbumSync(album_id: string, request_id: string, start_cursor: string, now_unix_ms: bigint, max_retry_count: number): string;

/**
 * Initializes a client-core upload job through a primitive WASM proof surface.
 */
export function initUploadJob(job_id: string, album_id: string, asset_id: string, idempotency_key: string, max_retry_count: number): string;

/**
 * Inspects image container metadata through the shared Rust media parser.
 */
export function inspectImage(input_bytes: Uint8Array): ImageInspectResult;

/**
 * Inspects video container metadata through the shared Rust media parser.
 */
export function inspectVideoContainer(input_bytes: Uint8Array): VideoInspectResult;

/**
 * Lists all protocol-supported shard tiers in ascending wire-byte order.
 */
export function listShardTiers(): any[];

/**
 * Builds canonical manifest transcript bytes through WASM.
 *
 * `encoded_shards` is a repeated sequence of
 * `chunk_index:u32le | tier:u8 | shard_id:16 bytes | sha256:32 bytes`.
 */
export function manifestTranscriptBytes(album_id: Uint8Array, epoch_id: number, encrypted_meta: Uint8Array, encoded_shards: Uint8Array): BytesResult;

/**
 * Mints a link-tier handle from a raw 32-byte tier key through WASM.
 */
export function mintLinkTierHandleFromRawKey(raw_key: Uint8Array): LinkTierHandleResult;

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
 * Atomically seals an epoch key bundle for `recipient_pubkey` using a
 * Rust-owned epoch handle through WASM. Bundle payload bytes never cross
 * the FFI boundary.
 */
export function sealBundleWithEpochHandle(identity_handle: bigint, epoch_handle: bigint, recipient_pubkey: Uint8Array, album_id: string): SealedBundleResult;

/**
 * Returns the protocol byte pinned for a WASM shard tier.
 */
export function shardTierByte(tier: ShardTier): number;

/**
 * Parses a protocol byte into a typed WASM shard tier.
 */
export function shardTierFromByte(byte: number): ShardTier;

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
 * Strips AVIF metadata through the shared Rust media parser.
 */
export function stripAvifMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Strips HEIC/HEIF metadata through the shared Rust media parser.
 */
export function stripHeicMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Strips JPEG metadata through the shared Rust media parser.
 */
export function stripJpegMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Strips PNG metadata through the shared Rust media parser.
 */
export function stripPngMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Strips video container metadata through the shared Rust media parser.
 */
export function stripVideoMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Strips WebP metadata through the shared Rust media parser.
 */
export function stripWebpMetadata(input_bytes: Uint8Array): StripResult;

/**
 * Unwraps an account key through the generated WASM binding surface.
 */
export function unlockAccountKey(password: Uint8Array, user_salt: Uint8Array, account_salt: Uint8Array, wrapped_account_key: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): AccountUnlockResult;

/**
 * Unwraps `wrapped` with the L2 account key referenced by `account_handle`
 * through WASM.
 */
export function unwrapWithAccountHandle(account_handle: bigint, wrapped: Uint8Array): BytesResult;

/**
 * Verifies and imports a sealed epoch key bundle through WASM.
 */
export function verifyAndImportEpochBundle(identity_handle: bigint, sealed: Uint8Array, signature: Uint8Array, sharer_pubkey: Uint8Array, expected_album_id: string, expected_min_epoch: number, allow_legacy_empty: boolean): EpochKeyHandleResult;

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
 * Verifies shard ciphertext SHA-256 through WASM.
 */
export function verifyShardIntegritySha256(envelope_bytes: Uint8Array, expected_sha256: Uint8Array): boolean;

/**
 * Stateless shard integrity verification through WASM.
 */
export function verifyShardIntegrityV1(envelope: Uint8Array, expected_hash: Uint8Array): VerifyShardResult;

/**
 * Wraps an epoch tier for an existing share-link handle through WASM.
 */
export function wrapLinkTierHandle(link_share_handle: bigint, epoch_handle: bigint, tier_byte: number): WrappedTierKeyResult;

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
    readonly __wbg_applyeventresult_free: (a: number, b: number) => void;
    readonly __wbg_buildplanresult_free: (a: number, b: number) => void;
    readonly __wbg_createaccountresult_free: (a: number, b: number) => void;
    readonly __wbg_createlinksharehandleresult_free: (a: number, b: number) => void;
    readonly __wbg_cryptodomaingoldenvectorsnapshot_free: (a: number, b: number) => void;
    readonly __wbg_decryptshardresult_free: (a: number, b: number) => void;
    readonly __wbg_epochkeyhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_headerresult_free: (a: number, b: number) => void;
    readonly __wbg_identityhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_imageinspectresult_free: (a: number, b: number) => void;
    readonly __wbg_loadsnapshotresult_free: (a: number, b: number) => void;
    readonly __wbg_mediatierdimensions_free: (a: number, b: number) => void;
    readonly __wbg_mediatierlayoutresult_free: (a: number, b: number) => void;
    readonly __wbg_progressevent_free: (a: number, b: number) => void;
    readonly __wbg_progressresult_free: (a: number, b: number) => void;
    readonly __wbg_sealedbundleresult_free: (a: number, b: number) => void;
    readonly __wbg_streamingenveloperesult_free: (a: number, b: number) => void;
    readonly __wbg_streamingsharddecryptor_free: (a: number, b: number) => void;
    readonly __wbg_streamingshardencryptor_free: (a: number, b: number) => void;
    readonly __wbg_verifyshardresult_free: (a: number, b: number) => void;
    readonly __wbg_verifysnapshotresult_free: (a: number, b: number) => void;
    readonly __wbg_videoinspectresult_free: (a: number, b: number) => void;
    readonly accountKeyHandleIsOpen: (a: bigint) => number;
    readonly accountkeyhandlestatusresult_code: (a: number) => number;
    readonly accountkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly accountunlockresult_code: (a: number) => number;
    readonly accountunlockresult_handle: (a: number) => bigint;
    readonly advanceAlbumSync: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: bigint, n: number, o: number, p: number, q: bigint, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: bigint, z: number) => void;
    readonly advanceUploadJob: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: bigint, m: number, n: bigint, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: bigint, b1: number, c1: number, d1: number, e1: bigint, f1: number, g1: number, h1: bigint, i1: bigint, j1: bigint, k1: number, l1: number, m1: number, n1: number) => void;
    readonly applyeventresult_code: (a: number) => number;
    readonly applyeventresult_newStateCbor: (a: number, b: number) => void;
    readonly authkeypairresult_code: (a: number) => number;
    readonly buildAuthChallengeTranscript: (a: number, b: number, c: bigint, d: number, e: number, f: number) => number;
    readonly buildShareLinkUrl: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly buildplanresult_code: (a: number) => number;
    readonly buildplanresult_errorDetail: (a: number, b: number) => void;
    readonly buildplanresult_planCbor: (a: number, b: number) => void;
    readonly canonicalMetadataSidecarBytes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly canonicalTierLayout: () => number;
    readonly canonicalVideoSidecarBytes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly clientCoreStateMachineSnapshot: (a: number) => void;
    readonly closeAccountKeyHandle: (a: bigint) => number;
    readonly closeEpochKeyHandle: (a: bigint) => number;
    readonly closeIdentityHandle: (a: bigint) => number;
    readonly closeLinkShareHandle: (a: bigint) => number;
    readonly closeLinkTierHandle: (a: bigint) => number;
    readonly consumeMasterKeyHandleForAesGcm: (a: number, b: bigint) => void;
    readonly createAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly createEpochKeyHandle: (a: bigint, b: number) => number;
    readonly createIdentityHandle: (a: bigint) => number;
    readonly createLinkShareHandle: (a: number, b: number, c: bigint, d: number) => number;
    readonly createaccountresult_code: (a: number) => number;
    readonly createaccountresult_handle: (a: number) => bigint;
    readonly createaccountresult_wrappedAccountKey: (a: number, b: number) => void;
    readonly createlinksharehandleresult_code: (a: number) => number;
    readonly createlinksharehandleresult_encryptedKey: (a: number, b: number) => void;
    readonly createlinksharehandleresult_handle: (a: number) => bigint;
    readonly createlinksharehandleresult_linkId: (a: number, b: number) => void;
    readonly createlinksharehandleresult_linkUrlToken: (a: number, b: number) => void;
    readonly createlinksharehandleresult_nonce: (a: number, b: number) => void;
    readonly createlinksharehandleresult_tier: (a: number) => number;
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
    readonly decryptEnvelope: (a: bigint, b: number, c: number) => number;
    readonly decryptShardWithEpochHandle: (a: bigint, b: number, c: number) => number;
    readonly decryptShardWithLegacyRawKeyHandle: (a: bigint, b: number, c: number) => number;
    readonly decryptShardWithLinkTierHandle: (a: bigint, b: number, c: number) => number;
    readonly decryptShardWithSeedV1: (a: number, b: number, c: number, d: number) => number;
    readonly decryptShardWithTier: (a: bigint, b: number, c: number) => number;
    readonly decryptshardresult_code: (a: number) => number;
    readonly decryptshardresult_plaintext: (a: number, b: number) => void;
    readonly deriveAuthKeypairFromAccount: (a: bigint) => number;
    readonly deriveAuthKeypairFromPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly deriveMasterKeyFromPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly deriveSessionSaltFromUsername: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly downloadApplyEventV1: (a: number, b: number, c: number, d: number) => number;
    readonly downloadBuildPlanV1: (a: number, b: number) => number;
    readonly downloadCommitSnapshotV1: (a: number, b: number) => number;
    readonly downloadInitSnapshotV1: (a: number, b: number) => number;
    readonly downloadLoadSnapshotV1: (a: number, b: number, c: number, d: number) => number;
    readonly downloadVerifySnapshotV1: (a: number, b: number, c: number, d: number) => number;
    readonly encryptAlbumContent: (a: bigint, b: number, c: number) => number;
    readonly encryptMetadataSidecarWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly encryptShardWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number) => number;
    readonly encryptShardWithTier: (a: bigint, b: number, c: number, d: number, e: number) => number;
    readonly encryptedcontentresult_ciphertext: (a: number, b: number) => void;
    readonly encryptedcontentresult_code: (a: number) => number;
    readonly epochKeyHandleIsOpen: (a: bigint) => number;
    readonly epochkeyhandleresult_code: (a: number) => number;
    readonly epochkeyhandleresult_epochId: (a: number) => number;
    readonly epochkeyhandleresult_handle: (a: number) => bigint;
    readonly epochkeyhandleresult_signPublicKey: (a: number, b: number) => void;
    readonly epochkeyhandleresult_wrappedEpochSeed: (a: number, b: number) => void;
    readonly finalizeIdempotencyKey: (a: number, b: number, c: number) => void;
    readonly getAuthPublicKeyFromAccount: (a: bigint) => number;
    readonly getAuthPublicKeyFromPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
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
    readonly imageinspectresult_cameraMake: (a: number, b: number) => void;
    readonly imageinspectresult_cameraModel: (a: number, b: number) => void;
    readonly imageinspectresult_code: (a: number) => number;
    readonly imageinspectresult_deviceTimestampMs: (a: number) => bigint;
    readonly imageinspectresult_encodedSidecarFields: (a: number, b: number) => void;
    readonly imageinspectresult_format: (a: number) => number;
    readonly imageinspectresult_gpsAccuracyMeters: (a: number) => number;
    readonly imageinspectresult_gpsAltitudeMeters: (a: number) => number;
    readonly imageinspectresult_gpsLatMicrodegrees: (a: number) => number;
    readonly imageinspectresult_gpsLonMicrodegrees: (a: number) => number;
    readonly imageinspectresult_hasDeviceTimestampMs: (a: number) => number;
    readonly imageinspectresult_hasGps: (a: number) => number;
    readonly imageinspectresult_hasSubsecondsMs: (a: number) => number;
    readonly imageinspectresult_height: (a: number) => number;
    readonly imageinspectresult_mimeType: (a: number, b: number) => void;
    readonly imageinspectresult_orientation: (a: number) => number;
    readonly imageinspectresult_subsecondsMs: (a: number) => number;
    readonly imageinspectresult_width: (a: number) => number;
    readonly importLinkShareHandle: (a: number, b: number) => number;
    readonly importLinkTierHandle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly initAlbumSync: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number) => void;
    readonly initUploadJob: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly inspectImage: (a: number, b: number) => number;
    readonly inspectVideoContainer: (a: number, b: number) => number;
    readonly linktierhandleresult_tier: (a: number) => number;
    readonly listShardTiers: (a: number) => void;
    readonly loadsnapshotresult_code: (a: number) => number;
    readonly loadsnapshotresult_schemaVersionLoaded: (a: number) => number;
    readonly loadsnapshotresult_snapshotCbor: (a: number, b: number) => void;
    readonly manifestTranscriptBytes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly mediatierdimensions_height: (a: number) => number;
    readonly mediatierdimensions_tier: (a: number) => number;
    readonly mediatierdimensions_width: (a: number) => number;
    readonly mediatierlayoutresult_code: (a: number) => number;
    readonly mediatierlayoutresult_original: (a: number) => number;
    readonly mediatierlayoutresult_preview: (a: number) => number;
    readonly mediatierlayoutresult_thumbnail: (a: number) => number;
    readonly mintLinkTierHandleFromRawKey: (a: number, b: number) => number;
    readonly openEpochKeyHandle: (a: number, b: number, c: bigint, d: number) => number;
    readonly openIdentityHandle: (a: number, b: number, c: bigint) => number;
    readonly parseEnvelopeHeader: (a: number, b: number) => number;
    readonly progressProbe: (a: number, b: bigint) => number;
    readonly progressevent_completedSteps: (a: number) => number;
    readonly progressevent_totalSteps: (a: number) => number;
    readonly progressresult_code: (a: number) => number;
    readonly progressresult_eventPairs: (a: number, b: number) => void;
    readonly sealBundleWithEpochHandle: (a: bigint, b: bigint, c: number, d: number, e: number, f: number) => number;
    readonly sealedbundleresult_code: (a: number) => number;
    readonly sealedbundleresult_sealed: (a: number, b: number) => void;
    readonly sealedbundleresult_sharerPubkey: (a: number, b: number) => void;
    readonly sealedbundleresult_signature: (a: number, b: number) => void;
    readonly shardTierByte: (a: number) => number;
    readonly shardTierFromByte: (a: number, b: number) => void;
    readonly signAuthChallengeWithAccount: (a: bigint, b: number, c: number) => number;
    readonly signAuthChallengeWithPassword: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly signManifestWithEpochHandle: (a: bigint, b: number, c: number) => number;
    readonly signManifestWithIdentity: (a: bigint, b: number, c: number) => number;
    readonly streamingenveloperesult_bytes: (a: number, b: number) => void;
    readonly streamingenveloperesult_code: (a: number) => number;
    readonly streamingenveloperesult_finalFrameSize: (a: number) => number;
    readonly streamingenveloperesult_frameCount: (a: number) => number;
    readonly streamingenveloperesult_header: (a: number, b: number) => void;
    readonly streamingframeresult_code: (a: number) => number;
    readonly streamingsharddecryptor_decryptFrame: (a: number, b: number, c: number) => number;
    readonly streamingsharddecryptor_finalize: (a: number) => number;
    readonly streamingsharddecryptor_new: (a: bigint, b: number, c: number) => number;
    readonly streamingshardencryptor_encryptFrame: (a: number, b: number, c: number) => number;
    readonly streamingshardencryptor_finalize: (a: number) => number;
    readonly streamingshardencryptor_new: (a: bigint, b: number, c: number) => number;
    readonly stripAvifMetadata: (a: number, b: number) => number;
    readonly stripHeicMetadata: (a: number, b: number) => number;
    readonly stripJpegMetadata: (a: number, b: number) => number;
    readonly stripPngMetadata: (a: number, b: number) => number;
    readonly stripVideoMetadata: (a: number, b: number) => number;
    readonly stripWebpMetadata: (a: number, b: number) => number;
    readonly unlockAccountKey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly unwrapWithAccountHandle: (a: bigint, b: number, c: number) => number;
    readonly verifyAndImportEpochBundle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly verifyManifestWithEpoch: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly verifyManifestWithIdentity: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly verifyShardIntegritySha256: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly verifyShardIntegrityV1: (a: number, b: number, c: number, d: number) => number;
    readonly verifyshardresult_code: (a: number) => number;
    readonly verifysnapshotresult_valid: (a: number) => number;
    readonly videoinspectresult_code: (a: number) => number;
    readonly videoinspectresult_container: (a: number, b: number) => void;
    readonly videoinspectresult_durationMs: (a: number) => bigint;
    readonly videoinspectresult_frameRateFps: (a: number) => number;
    readonly videoinspectresult_heightPx: (a: number) => number;
    readonly videoinspectresult_orientation: (a: number, b: number) => void;
    readonly videoinspectresult_videoCodec: (a: number, b: number) => void;
    readonly videoinspectresult_widthPx: (a: number) => number;
    readonly wrapLinkTierHandle: (a: bigint, b: bigint, c: number) => number;
    readonly wrapWithAccountHandle: (a: bigint, b: number, c: number) => number;
    readonly wrappedtierkeyresult_tier: (a: number) => number;
    readonly __wbg_linktierhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_epochkeyhandlestatusresult_free: (a: number, b: number) => void;
    readonly __wbg_serializesnapshotresult_free: (a: number, b: number) => void;
    readonly __wbg_encryptedcontentresult_free: (a: number, b: number) => void;
    readonly __wbg_wrappedtierkeyresult_free: (a: number, b: number) => void;
    readonly __wbg_decryptedshardresult_free: (a: number, b: number) => void;
    readonly __wbg_bytesresult_free: (a: number, b: number) => void;
    readonly __wbg_authkeypairresult_free: (a: number, b: number) => void;
    readonly __wbg_commitsnapshotresult_free: (a: number, b: number) => void;
    readonly __wbg_decryptedcontentresult_free: (a: number, b: number) => void;
    readonly __wbg_encryptedshardresult_free: (a: number, b: number) => void;
    readonly __wbg_stripresult_free: (a: number, b: number) => void;
    readonly __wbg_streamingframeresult_free: (a: number, b: number) => void;
    readonly verifysnapshotresult_code: (a: number) => number;
    readonly epochkeyhandlestatusresult_code: (a: number) => number;
    readonly epochkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly serializesnapshotresult_body: (a: number, b: number) => void;
    readonly serializesnapshotresult_code: (a: number) => number;
    readonly wrappedtierkeyresult_encryptedKey: (a: number, b: number) => void;
    readonly encryptedcontentresult_nonce: (a: number, b: number) => void;
    readonly wrappedtierkeyresult_nonce: (a: number, b: number) => void;
    readonly wrappedtierkeyresult_code: (a: number) => number;
    readonly serializesnapshotresult_checksum: (a: number, b: number) => void;
    readonly decryptedshardresult_code: (a: number) => number;
    readonly decryptedshardresult_plaintext: (a: number, b: number) => void;
    readonly bytesresult_bytes: (a: number, b: number) => void;
    readonly authkeypairresult_authPublicKey: (a: number, b: number) => void;
    readonly decryptedcontentresult_code: (a: number) => number;
    readonly commitsnapshotresult_checksum: (a: number, b: number) => void;
    readonly commitsnapshotresult_code: (a: number) => number;
    readonly linktierhandleresult_linkId: (a: number, b: number) => void;
    readonly linktierhandleresult_code: (a: number) => number;
    readonly linktierhandleresult_handle: (a: number) => bigint;
    readonly decryptedcontentresult_plaintext: (a: number, b: number) => void;
    readonly bytesresult_code: (a: number) => number;
    readonly encryptedshardresult_code: (a: number) => number;
    readonly encryptedshardresult_sha256: (a: number, b: number) => void;
    readonly encryptedshardresult_envelopeBytes: (a: number, b: number) => void;
    readonly stripresult_code: (a: number) => number;
    readonly stripresult_removedMetadataCount: (a: number) => number;
    readonly stripresult_strippedBytes: (a: number, b: number) => void;
    readonly streamingframeresult_bytes: (a: number, b: number) => void;
    readonly streamingframeresult_frameIndex: (a: number) => number;
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
