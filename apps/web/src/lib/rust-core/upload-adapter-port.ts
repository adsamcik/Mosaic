export type AlbumId = string;
export type UploadJobId = string;
export type AssetId = string;
export type IdempotencyKey = string;

export type UploadPhase =
  | 'Queued'
  | 'AwaitingPreparedMedia'
  | 'AwaitingEpochHandle'
  | 'EncryptingShard'
  | 'CreatingShardUpload'
  | 'UploadingShard'
  | 'CreatingManifest'
  | 'ManifestCommitUnknown'
  | 'AwaitingSyncConfirmation'
  | 'RetryWaiting'
  | 'Confirmed'
  | 'Cancelled'
  | 'Failed'
  | (string & {});

export type SyncPhase =
  | 'Idle'
  | 'FetchingPage'
  | 'ApplyingPage'
  | 'RetryWaiting'
  | 'Completed'
  | 'Cancelled'
  | 'Failed'
  | (string & {});

export type UploadEventKind =
  | 'StartRequested'
  | 'Start'
  | 'MediaPrepared'
  | 'PreparedMedia'
  | 'EpochHandleAcquired'
  | 'EpochHandleReady'
  | 'ShardEncrypted'
  | 'ShardUploadCreated'
  | 'ShardUploaded'
  | 'ManifestCreated'
  | 'ManifestOutcomeUnknown'
  | 'ManifestRecoveryResolved'
  | 'SyncConfirmed'
  | 'EffectAck'
  | 'RetryableFailure'
  | 'RetryTimerElapsed'
  | 'CancelRequested'
  | 'AlbumDeleted'
  | 'NonRetryableFailure'
  | 'IdempotencyExpired'
  | (string & {});

export type SyncEventKind =
  | 'SyncRequested'
  | 'StartRequested'
  | 'Start'
  | 'PageFetched'
  | 'PageApplied'
  | 'RetryableFailure'
  | 'RetryTimerElapsed'
  | 'CancelRequested'
  | 'NonRetryableFailure'
  | (string & {});

export interface UploadInitInput {
  readonly jobId: UploadJobId;
  readonly albumId: AlbumId;
  readonly assetId: AssetId;
  readonly idempotencyKey: IdempotencyKey;
  readonly maxRetryCount: number;
}

export interface UploadJobSnapshot {
  readonly schemaVersion: number;
  readonly jobId: UploadJobId;
  readonly albumId: AlbumId;
  readonly phase: UploadPhase;
  readonly shardRefCount: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly retryCount: number;
  readonly maxRetryCount: number;
  readonly nextRetryNotBeforeMs: bigint;
  readonly hasNextRetryNotBeforeMs: boolean;
  readonly snapshotRevision: bigint;
  readonly lastEffectId: string;
}

export interface UploadEvent {
  readonly kind: UploadEventKind;
  readonly effectId: string;
  readonly tier?: number;
  readonly shardIndex?: number;
  readonly shardId?: string;
  readonly sha256?: Uint8Array;
  readonly contentLength?: bigint;
  readonly envelopeVersion?: number;
  readonly assetId?: AssetId;
  readonly sinceMetadataVersion?: bigint;
  readonly recoveryOutcome?: string;
  readonly nowMs?: bigint;
  readonly baseBackoffMs?: bigint;
  readonly serverRetryAfterMs?: bigint;
  readonly hasServerRetryAfterMs?: boolean;
  readonly errorCode?: number;
  readonly targetPhase?: UploadPhase;
}

export interface UploadEffect {
  readonly kind: string;
  readonly effectId: string;
}

export interface AlbumSyncInitInput {
  readonly albumId: AlbumId;
  readonly requestId: string;
  readonly startCursor: string;
  readonly nowUnixMs: bigint;
  readonly maxRetryCount: number;
}

export interface AlbumSyncSnapshot {
  readonly schemaVersion: number;
  readonly albumId: AlbumId;
  readonly phase: SyncPhase;
  readonly activeCursor: string;
  readonly pendingCursor: string;
  readonly rerunRequested: boolean;
  readonly retryCount: number;
  readonly maxRetryCount: number;
  readonly nextRetryUnixMs: bigint;
  readonly lastErrorCode: number;
  readonly lastErrorStage: string;
  readonly updatedAtUnixMs: bigint;
}

export interface SyncEvent {
  readonly kind: SyncEventKind;
  readonly fetchedCursor?: string;
  readonly nextCursor?: string;
  readonly appliedCount?: number;
  readonly retryAfterUnixMs?: bigint;
  readonly errorCode?: number;
}

export interface SyncEffect {
  readonly kind: string;
  readonly cursor: string;
}

export interface UploadAdapterPort {
  initJob(input: UploadInitInput): Promise<UploadJobSnapshot>;
  advanceJob(
    snapshot: UploadJobSnapshot,
    event: UploadEvent,
  ): Promise<UploadJobSnapshot>;
  getCurrentEffect(snapshot: UploadJobSnapshot): UploadEffect | null;
  finalizeJob(snapshot: UploadJobSnapshot): Promise<UploadJobSnapshot>;
}

export interface SyncAdapterPort {
  initSync(input: AlbumSyncInitInput): Promise<AlbumSyncSnapshot>;
  advanceSync(
    snapshot: AlbumSyncSnapshot,
    event: SyncEvent,
  ): Promise<AlbumSyncSnapshot>;
  getCurrentEffect(snapshot: AlbumSyncSnapshot): SyncEffect | null;
}

export type WasmInitUploadJobBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').initUploadJob;
export type WasmAdvanceUploadJobBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').advanceUploadJob;
export type WasmInitAlbumSyncBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').initAlbumSync;
export type WasmAdvanceAlbumSyncBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').advanceAlbumSync;
export type WasmClientCoreSurfaceBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').clientCoreStateMachineSnapshot;
export type WasmManifestTranscriptBytesBinding =
  typeof import('../../generated/mosaic-wasm/mosaic_wasm.js').manifestTranscriptBytes;
