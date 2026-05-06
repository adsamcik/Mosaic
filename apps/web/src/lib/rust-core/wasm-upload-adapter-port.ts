import type {
  AlbumSyncInitInput,
  AlbumSyncSnapshot,
  SyncAdapterPort,
  SyncEffect,
  SyncEvent,
  UploadAdapterPort,
  UploadEffect,
  UploadEvent,
  UploadInitInput,
  UploadJobSnapshot,
  WasmAdvanceAlbumSyncBinding,
  WasmAdvanceUploadJobBinding,
  WasmClientCoreSurfaceBinding,
  WasmInitAlbumSyncBinding,
  WasmInitUploadJobBinding,
} from './upload-adapter-port';

const RUST_OK = 0;
const CLIENT_CORE_INVALID_SNAPSHOT = 706;

interface UploadSnapshotJson {
  readonly code: number;
  readonly schemaVersion: number;
  readonly jobId: string;
  readonly albumId: string;
  readonly phase: string;
  readonly shardRefCount: number;
}

interface AlbumSyncSnapshotJson {
  readonly code: number;
  readonly schemaVersion: number;
  readonly albumId: string;
  readonly phase: string;
  readonly rerunRequested: boolean;
}

export interface WasmUploadAdapterBindings {
  readonly init: () => Promise<void>;
  readonly initUploadJob: WasmInitUploadJobBinding;
  readonly advanceUploadJob: WasmAdvanceUploadJobBinding;
  readonly clientCoreStateMachineSnapshot: WasmClientCoreSurfaceBinding;
}

export interface WasmSyncAdapterBindings {
  readonly init: () => Promise<void>;
  readonly initAlbumSync: WasmInitAlbumSyncBinding;
  readonly advanceAlbumSync: WasmAdvanceAlbumSyncBinding;
  readonly clientCoreStateMachineSnapshot: WasmClientCoreSurfaceBinding;
}

export class RustCoreAdapterPortError extends Error {
  constructor(
    readonly operation: string,
    readonly code: number,
    message = `${operation} failed (rust code ${String(code)})`,
  ) {
    super(message);
    this.name = 'RustCoreAdapterPortError';
  }
}

export class WasmUploadAdapterPort implements UploadAdapterPort {
  constructor(private readonly bindings: WasmUploadAdapterBindings) {}

  async initJob(input: UploadInitInput): Promise<UploadJobSnapshot> {
    await this.bindings.init();
    const result = parseUploadSnapshot(
      this.bindings.initUploadJob(
        input.jobId,
        input.albumId,
        input.assetId,
        input.idempotencyKey,
        input.maxRetryCount,
      ),
      'initUploadJob',
    );
    return {
      ...uploadSnapshotDefaults(input),
      schemaVersion: result.schemaVersion,
      jobId: result.jobId,
      albumId: result.albumId,
      phase: result.phase,
      shardRefCount: result.shardRefCount,
    };
  }

  async advanceJob(
    snapshot: UploadJobSnapshot,
    event: UploadEvent,
  ): Promise<UploadJobSnapshot> {
    await this.bindings.init();
    const result = parseUploadSnapshot(
      this.bindings.advanceUploadJob(
        snapshot.jobId,
        snapshot.albumId,
        snapshot.idempotencyKey,
        snapshot.phase,
        snapshot.retryCount,
        snapshot.maxRetryCount,
        snapshot.nextRetryNotBeforeMs,
        snapshot.hasNextRetryNotBeforeMs,
        snapshot.snapshotRevision,
        snapshot.lastEffectId,
        event.kind,
        event.effectId,
        event.tier ?? 0,
        event.shardIndex ?? 0,
        event.shardId ?? '',
        event.sha256 ?? new Uint8Array(),
        event.contentLength ?? 0n,
        event.envelopeVersion ?? 0,
        event.assetId ?? '',
        event.sinceMetadataVersion ?? 0n,
        event.recoveryOutcome ?? '',
        event.nowMs ?? 0n,
        event.baseBackoffMs ?? 0n,
        event.serverRetryAfterMs ?? 0n,
        event.hasServerRetryAfterMs ?? false,
        event.errorCode ?? 0,
        event.targetPhase ?? '',
      ),
      'advanceUploadJob',
    );
    return {
      ...snapshot,
      schemaVersion: result.schemaVersion,
      jobId: result.jobId,
      albumId: result.albumId,
      phase: result.phase,
      shardRefCount: result.shardRefCount,
      lastEffectId: event.effectId,
    };
  }

  getCurrentEffect(_snapshot: UploadJobSnapshot): UploadEffect | null {
    return null;
  }

  async finalizeJob(snapshot: UploadJobSnapshot): Promise<UploadJobSnapshot> {
    await this.bindings.init();
    return snapshot;
  }

  async surfaceSnapshot(): Promise<string> {
    await this.bindings.init();
    return this.bindings.clientCoreStateMachineSnapshot();
  }
}

export class WasmSyncAdapterPort implements SyncAdapterPort {
  constructor(private readonly bindings: WasmSyncAdapterBindings) {}

  async initSync(input: AlbumSyncInitInput): Promise<AlbumSyncSnapshot> {
    await this.bindings.init();
    const result = parseAlbumSyncSnapshot(
      this.bindings.initAlbumSync(
        input.albumId,
        input.requestId,
        input.startCursor,
        input.nowUnixMs,
        input.maxRetryCount,
      ),
      'initAlbumSync',
    );
    return {
      ...albumSyncSnapshotDefaults(input),
      schemaVersion: result.schemaVersion,
      albumId: result.albumId,
      phase: result.phase,
      rerunRequested: result.rerunRequested,
    };
  }

  async advanceSync(
    snapshot: AlbumSyncSnapshot,
    event: SyncEvent,
  ): Promise<AlbumSyncSnapshot> {
    await this.bindings.init();
    const result = parseAlbumSyncSnapshot(
      this.bindings.advanceAlbumSync(
        snapshot.albumId,
        snapshot.phase,
        snapshot.activeCursor,
        snapshot.pendingCursor,
        snapshot.rerunRequested,
        snapshot.retryCount,
        snapshot.maxRetryCount,
        snapshot.nextRetryUnixMs,
        snapshot.lastErrorCode,
        snapshot.lastErrorStage,
        snapshot.updatedAtUnixMs,
        event.kind,
        event.fetchedCursor ?? '',
        event.nextCursor ?? '',
        event.appliedCount ?? 0,
        event.retryAfterUnixMs ?? 0n,
        event.errorCode ?? 0,
      ),
      'advanceAlbumSync',
    );
    return {
      ...snapshot,
      schemaVersion: result.schemaVersion,
      albumId: result.albumId,
      phase: result.phase,
      rerunRequested: result.rerunRequested,
    };
  }

  getCurrentEffect(_snapshot: AlbumSyncSnapshot): SyncEffect | null {
    return null;
  }

  async surfaceSnapshot(): Promise<string> {
    await this.bindings.init();
    return this.bindings.clientCoreStateMachineSnapshot();
  }
}

function uploadSnapshotDefaults(input: UploadInitInput): UploadJobSnapshot {
  return {
    schemaVersion: 1,
    jobId: input.jobId,
    albumId: input.albumId,
    phase: 'Queued',
    shardRefCount: 0,
    idempotencyKey: input.idempotencyKey,
    retryCount: 0,
    maxRetryCount: input.maxRetryCount,
    nextRetryNotBeforeMs: 0n,
    hasNextRetryNotBeforeMs: false,
    snapshotRevision: 0n,
    lastEffectId: '',
  };
}

function albumSyncSnapshotDefaults(input: AlbumSyncInitInput): AlbumSyncSnapshot {
  return {
    schemaVersion: 1,
    albumId: input.albumId,
    phase: 'Idle',
    activeCursor: input.startCursor,
    pendingCursor: '',
    rerunRequested: false,
    retryCount: 0,
    maxRetryCount: input.maxRetryCount,
    nextRetryUnixMs: 0n,
    lastErrorCode: 0,
    lastErrorStage: '',
    updatedAtUnixMs: input.nowUnixMs,
  };
}

function parseUploadSnapshot(raw: string, operation: string): UploadSnapshotJson {
  const parsed = parseJsonObject(raw, operation);
  if (!isUploadSnapshotJson(parsed)) {
    throw new RustCoreAdapterPortError(
      operation,
      CLIENT_CORE_INVALID_SNAPSHOT,
      `${operation} returned an invalid upload snapshot shape`,
    );
  }
  throwIfRustError(operation, parsed.code);
  return parsed;
}

function parseAlbumSyncSnapshot(
  raw: string,
  operation: string,
): AlbumSyncSnapshotJson {
  const parsed = parseJsonObject(raw, operation);
  if (!isAlbumSyncSnapshotJson(parsed)) {
    throw new RustCoreAdapterPortError(
      operation,
      CLIENT_CORE_INVALID_SNAPSHOT,
      `${operation} returned an invalid album sync snapshot shape`,
    );
  }
  throwIfRustError(operation, parsed.code);
  return parsed;
}

function parseJsonObject(raw: string, operation: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    throw new RustCoreAdapterPortError(
      operation,
      CLIENT_CORE_INVALID_SNAPSHOT,
      `${operation} returned malformed JSON`,
    );
  }
  throw new RustCoreAdapterPortError(
    operation,
    CLIENT_CORE_INVALID_SNAPSHOT,
    `${operation} returned a non-object JSON payload`,
  );
}

function throwIfRustError(operation: string, code: number): void {
  if (code !== RUST_OK) {
    throw new RustCoreAdapterPortError(operation, code);
  }
}

function isUploadSnapshotJson(value: unknown): value is UploadSnapshotJson {
  const candidate = value as Partial<UploadSnapshotJson>;
  return (
    typeof candidate.code === 'number' &&
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.jobId === 'string' &&
    typeof candidate.albumId === 'string' &&
    typeof candidate.phase === 'string' &&
    typeof candidate.shardRefCount === 'number'
  );
}

function isAlbumSyncSnapshotJson(value: unknown): value is AlbumSyncSnapshotJson {
  const candidate = value as Partial<AlbumSyncSnapshotJson>;
  return (
    typeof candidate.code === 'number' &&
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.albumId === 'string' &&
    typeof candidate.phase === 'string' &&
    typeof candidate.rerunRequested === 'boolean'
  );
}
