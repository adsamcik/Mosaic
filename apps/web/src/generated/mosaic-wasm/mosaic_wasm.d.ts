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
 * Returns account-key handle status through WASM.
 */
export function accountKeyHandleIsOpen(handle: bigint): AccountKeyHandleStatusResult;

/**
 * Builds canonical metadata sidecar bytes through WASM.
 */
export function canonicalMetadataSidecarBytes(album_id: Uint8Array, photo_id: Uint8Array, epoch_id: number, encoded_fields: Uint8Array): BytesResult;

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
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 */
export function decryptShardWithEpochHandle(handle: bigint, envelope_bytes: Uint8Array): DecryptedShardResult;

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
 * Returns an identity handle's X25519 public key through WASM.
 */
export function identityEncryptionPubkey(handle: bigint): BytesResult;

/**
 * Returns an identity handle's Ed25519 public key through WASM.
 */
export function identitySigningPubkey(handle: bigint): BytesResult;

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
 * Signs manifest transcript bytes through WASM.
 */
export function signManifestWithIdentity(handle: bigint, transcript_bytes: Uint8Array): BytesResult;

/**
 * Unwraps an account key through the generated WASM binding surface.
 */
export function unlockAccountKey(password: Uint8Array, user_salt: Uint8Array, account_salt: Uint8Array, wrapped_account_key: Uint8Array, kdf_memory_kib: number, kdf_iterations: number, kdf_parallelism: number): AccountUnlockResult;

/**
 * Verifies manifest transcript bytes through WASM.
 */
export function verifyManifestWithIdentity(transcript_bytes: Uint8Array, signature: Uint8Array, public_key: Uint8Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_accountkeyhandlestatusresult_free: (a: number, b: number) => void;
    readonly __wbg_accountunlockresult_free: (a: number, b: number) => void;
    readonly __wbg_bytesresult_free: (a: number, b: number) => void;
    readonly __wbg_cryptodomaingoldenvectorsnapshot_free: (a: number, b: number) => void;
    readonly __wbg_encryptedshardresult_free: (a: number, b: number) => void;
    readonly __wbg_epochkeyhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_headerresult_free: (a: number, b: number) => void;
    readonly __wbg_identityhandleresult_free: (a: number, b: number) => void;
    readonly __wbg_progressevent_free: (a: number, b: number) => void;
    readonly __wbg_progressresult_free: (a: number, b: number) => void;
    readonly accountKeyHandleIsOpen: (a: bigint) => number;
    readonly accountkeyhandlestatusresult_code: (a: number) => number;
    readonly accountkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly accountunlockresult_code: (a: number) => number;
    readonly accountunlockresult_handle: (a: number) => bigint;
    readonly bytesresult_bytes: (a: number, b: number) => void;
    readonly bytesresult_code: (a: number) => number;
    readonly canonicalMetadataSidecarBytes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly closeAccountKeyHandle: (a: bigint) => number;
    readonly closeEpochKeyHandle: (a: bigint) => number;
    readonly closeIdentityHandle: (a: bigint) => number;
    readonly createEpochKeyHandle: (a: bigint, b: number) => number;
    readonly createIdentityHandle: (a: bigint) => number;
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
    readonly decryptShardWithEpochHandle: (a: bigint, b: number, c: number) => number;
    readonly encryptMetadataSidecarWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly encryptShardWithEpochHandle: (a: bigint, b: number, c: number, d: number, e: number) => number;
    readonly encryptedshardresult_code: (a: number) => number;
    readonly encryptedshardresult_envelopeBytes: (a: number, b: number) => void;
    readonly encryptedshardresult_sha256: (a: number, b: number) => void;
    readonly epochKeyHandleIsOpen: (a: bigint) => number;
    readonly epochkeyhandleresult_code: (a: number) => number;
    readonly epochkeyhandleresult_epochId: (a: number) => number;
    readonly epochkeyhandleresult_handle: (a: number) => bigint;
    readonly epochkeyhandleresult_wrappedEpochSeed: (a: number, b: number) => void;
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
    readonly openEpochKeyHandle: (a: number, b: number, c: bigint, d: number) => number;
    readonly openIdentityHandle: (a: number, b: number, c: bigint) => number;
    readonly parseEnvelopeHeader: (a: number, b: number) => number;
    readonly progressProbe: (a: number, b: bigint) => number;
    readonly progressevent_completedSteps: (a: number) => number;
    readonly progressevent_totalSteps: (a: number) => number;
    readonly progressresult_code: (a: number) => number;
    readonly progressresult_eventPairs: (a: number, b: number) => void;
    readonly signManifestWithIdentity: (a: bigint, b: number, c: number) => number;
    readonly unlockAccountKey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly verifyManifestWithIdentity: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbg_epochkeyhandlestatusresult_free: (a: number, b: number) => void;
    readonly __wbg_decryptedshardresult_free: (a: number, b: number) => void;
    readonly epochkeyhandlestatusresult_isOpen: (a: number) => number;
    readonly epochkeyhandlestatusresult_code: (a: number) => number;
    readonly decryptedshardresult_code: (a: number) => number;
    readonly decryptedshardresult_plaintext: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
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
