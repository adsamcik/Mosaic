import { getCryptoClient } from './crypto-client';
import type { EpochKeyBundle } from './epoch-key-store';
import type { PhotoMeta, TieredShardIds } from '../workers/types';
import type { UploadTask } from './upload/types';
import type { UploadEvent, UploadEffect } from './rust-core/upload-adapter-port';
import { manifestTranscriptInputForFinalize } from './manifest-transcript';
import { purgeLocalAlbum } from './local-purge';
import { ManifestFinalizeResponseSchema } from './api-schemas';

const API_BASE = '/api';
const SHA256_BYTES = 32;
const MANIFEST_FINALIZE_TIMEOUT_MS = 30_000;

export const MANIFEST_INVALID_SIGNATURE = 400;
export const MANIFEST_TRANSCRIPT_MISMATCH = 422;
export const MANIFEST_AUTH_DENIED = 'AUTH_DENIED';
export const MANIFEST_TRANSIENT_SERVER_ERROR = 'TRANSIENT_SERVER_ERROR';
export const MANIFEST_ALBUM_GONE = 'ALBUM_GONE';
export const MANIFEST_MALFORMED_RESPONSE = 'MALFORMED_FINALIZE_RESPONSE';

export interface ManifestFinalizeTieredShard {
  readonly shardId: string;
  readonly tier: number;
  readonly shardIndex: number;
  readonly sha256: string;
  readonly contentLength: number;
  readonly envelopeVersion: number;
}

export interface ManifestFinalizeResponse {
  readonly protocolVersion: number;
  readonly manifestId: string;
  readonly metadataVersion: number;
  readonly createdAt: string;
  readonly tieredShards: readonly ManifestFinalizeTieredShard[];
}

export interface ManifestCreated {
  readonly kind: 'ManifestCreated';
  readonly response: ManifestFinalizeResponse;
}

export interface ManifestAlreadyFinalized {
  readonly kind: 'AlreadyFinalized';
  readonly manifestId: string;
  readonly detail: string;
}

export type ManifestFinalizationResult = ManifestCreated | ManifestAlreadyFinalized;

export interface FinalizeManifestEffect extends UploadEffect {
  readonly kind: 'FinalizeManifest' | 'FinalizeManifestEffect';
  readonly manifestId: string;
  readonly protocolVersion: 1;
  readonly albumId: string;
  readonly assetType: 'Image' | 'Video' | 'LiveImage';
  readonly encryptedMeta: Uint8Array;
  readonly encryptedMetaSidecar?: Uint8Array;
  readonly signature: Uint8Array;
  readonly signerPubkey: Uint8Array;
  readonly tieredShards: readonly ManifestFinalizeTieredShard[];
}

export interface ManifestFinalizationAdapter {
  submit(event: UploadEvent): Promise<unknown>;
}

export interface ExecuteManifestFinalizationOptions {
  readonly jobId: string;
  readonly adapter?: ManifestFinalizationAdapter;
  readonly fetchImpl?: typeof fetch;
}

export class ManifestFinalizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | string,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestFinalizationError';
  }
}

export class ManifestFinalizationTimeoutError extends Error {
  constructor(message = 'Manifest finalization outcome is unknown') {
    super(message);
    this.name = 'ManifestFinalizationTimeoutError';
  }
}

export async function finalizeIdempotencyKey(jobId: string): Promise<string> {
  const crypto = await getCryptoClient();
  return crypto.finalizeIdempotencyKey(jobId);
}

export async function finalizeManifestForUpload(
  task: UploadTask,
  shardIds: readonly string[],
  epochKey: EpochKeyBundle,
  tieredShards?: TieredShardIds,
  options: Omit<ExecuteManifestFinalizationOptions, 'jobId'> = {},
): Promise<ManifestFinalizationResult> {
  const crypto = await getCryptoClient();
  const now = new Date().toISOString();
  const vm = task.videoMetadata;
  const mimeType =
    task.detectedMimeType || task.file.type || 'application/octet-stream';

  const photoMeta: PhotoMeta = {
    id: task.id,
    assetId: task.id,
    albumId: task.albumId,
    filename: task.file.name,
    mimeType,
    width: vm?.width ?? task.originalWidth ?? 0,
    height: vm?.height ?? task.originalHeight ?? 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    shardIds: [...shardIds],
    shardHashes: [...task.completedShards]
      .sort((a, b) => (a.tier ?? 3) - (b.tier ?? 3) || a.index - b.index)
      .map((shard) => shard.sha256),
    epochId: task.epochId,
    ...(vm?.thumbnail
      ? { thumbnail: vm.thumbnail }
      : task.thumbnailBase64
        ? { thumbnail: task.thumbnailBase64 }
        : {}),
    ...(vm?.thumbWidth ?? task.thumbWidth
      ? { thumbWidth: vm?.thumbWidth ?? task.thumbWidth }
      : {}),
    ...(vm?.thumbHeight ?? task.thumbHeight
      ? { thumbHeight: vm?.thumbHeight ?? task.thumbHeight }
      : {}),
    ...(vm?.thumbhash ?? task.thumbhash
      ? { thumbhash: vm?.thumbhash ?? task.thumbhash }
      : {}),
    ...(tieredShards && {
      thumbnailShardId: tieredShards.thumbnail.shardId,
      thumbnailShardHash: tieredShards.thumbnail.sha256,
      previewShardId: tieredShards.preview.shardId,
      previewShardHash: tieredShards.preview.sha256,
      originalShardIds: tieredShards.original.map((s) => s.shardId),
      originalShardHashes: tieredShards.original.map((s) => s.sha256),
    }),
    ...(vm && {
      isVideo: vm.isVideo,
      duration: vm.duration,
      ...(vm.videoCodec ? { videoCodec: vm.videoCodec } : {}),
    }),
  };

  const plaintextJson = new TextEncoder().encode(JSON.stringify(photoMeta));
  const encrypted = await crypto.encryptManifestWithEpoch(
    epochKey.epochHandleId,
    plaintextJson,
  );
  const finalizeShards = toFinalizeTieredShards(task);
  const transcript = await crypto.manifestTranscriptBytes(manifestTranscriptInputForFinalize({
    albumId: task.albumId,
    epochId: task.epochId,
    encryptedMeta: encrypted.envelopeBytes,
    tieredShards: finalizeShards,
  }));
  const signature = await crypto.signManifestWithEpoch(
    epochKey.epochHandleId,
    transcript,
  );

  const effect: FinalizeManifestEffect = {
    kind: 'FinalizeManifest',
    effectId: task.id,
    manifestId: task.id,
    protocolVersion: 1,
    albumId: task.albumId,
    assetType: vm ? 'Video' : 'Image',
    encryptedMeta: encrypted.envelopeBytes,
    signature,
    signerPubkey: epochKey.signPublicKey,
    tieredShards: finalizeShards,
  };

  return executeManifestFinalizationEffect(effect, {
    ...options,
    jobId: uploadJobIdForTask(task),
  });
}

export async function executeManifestFinalizationEffect(
  effect: FinalizeManifestEffect,
  options: ExecuteManifestFinalizationOptions,
): Promise<ManifestFinalizationResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const idempotencyKey = await finalizeIdempotencyKey(options.jobId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MANIFEST_FINALIZE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(
      `${API_BASE}/manifests/${encodeURIComponent(effect.manifestId)}/finalize`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(toFinalizeRequestBody(effect)),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (isManifestOutcomeUnknownError(error)) {
      await options.adapter?.submit({
        kind: 'ManifestOutcomeUnknown',
        effectId: effect.effectId,
      });
      throw new ManifestFinalizationTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.ok) {
    const finalized = await readFinalizeResponseOrSubmitMalformed(response, effect, options.adapter);
    await options.adapter?.submit({
      kind: 'ManifestCreated',
      effectId: effect.effectId,
      assetId: finalized.manifestId,
      sinceMetadataVersion: BigInt(finalized.metadataVersion),
    });
    return { kind: 'ManifestCreated', response: finalized };
  }

  if (response.status === 409) {
    if (response.headers.get('Idempotency-Replayed') === 'true') {
      const finalized = await readFinalizeResponseOrSubmitMalformed(response, effect, options.adapter);
      await options.adapter?.submit({
        kind: 'ManifestCreated',
        effectId: effect.effectId,
        assetId: finalized.manifestId,
        sinceMetadataVersion: BigInt(finalized.metadataVersion),
      });
      return { kind: 'ManifestCreated', response: finalized };
    }

    const errorBody = await response.json().catch(() => ({}));
    return {
      kind: 'AlreadyFinalized',
      manifestId: manifestFinalizeErrorManifestId(errorBody),
      detail: manifestFinalizeErrorDetail(errorBody),
    };
  }

  if (response.status === 400 || response.status === 422) {
    const errorCode = response.status === 400
      ? MANIFEST_INVALID_SIGNATURE
      : MANIFEST_TRANSCRIPT_MISMATCH;
    await options.adapter?.submit({
      kind: 'NonRetryableFailure',
      effectId: effect.effectId,
      errorCode,
      targetPhase: 'Failed',
    });
    throw new ManifestFinalizationError(
      response.status,
      errorCode,
      response.status === 400
        ? 'Manifest finalization failed: invalid signature'
        : 'Manifest finalization failed: manifest transcript mismatch',
    );
  }

  if (response.status === 401 || response.status === 403) {
    const detail = await manifestFinalizeErrorDetailFromResponse(response);
    await options.adapter?.submit({
      kind: 'NonRetryableFailure',
      effectId: effect.effectId,
      errorCode: response.status,
      targetPhase: 'Failed',
    });
    throw new ManifestFinalizationError(
      response.status,
      response.status,
      `Manifest finalization failed: authorization denied${detail ? `: ${detail}` : ''}`,
    );
  }

  if (response.status === 410) {
    const detail = await manifestFinalizeErrorDetailFromResponse(response);
    await options.adapter?.submit({
      kind: 'NonRetryableFailure',
      effectId: effect.effectId,
      errorCode: response.status,
      targetPhase: 'Failed',
    });
    await purgeLocalAlbum({ albumId: effect.albumId, reason: 'album-410' });
    throw new ManifestFinalizationError(
      response.status,
      MANIFEST_ALBUM_GONE,
      `Manifest finalization failed: album is gone${detail ? `: ${detail}` : ''}`,
    );
  }

  if ([500, 502, 503, 504].includes(response.status)) {
    const detail = await manifestFinalizeErrorDetailFromResponse(response);
    await options.adapter?.submit({
      kind: 'RetryableFailure',
      effectId: effect.effectId,
      errorCode: response.status,
      targetPhase: 'Failed',
    });
    throw new ManifestFinalizationError(
      response.status,
      response.status,
      `Manifest finalization failed with transient server error ${String(response.status)}${detail ? `: ${detail}` : ''}`,
    );
  }

  const body = await response.text().catch(() => '');
  throw new ManifestFinalizationError(
    response.status,
    response.status,
    `Manifest finalization failed with HTTP ${String(response.status)}${body ? `: ${body}` : ''}`,
  );
}

function isManifestOutcomeUnknownError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

async function manifestFinalizeErrorDetailFromResponse(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body) {
    return '';
  }
  try {
    return manifestFinalizeErrorDetail(JSON.parse(body) as Record<string, unknown>);
  } catch {
    return body;
  }
}

function toFinalizeRequestBody(effect: FinalizeManifestEffect): Record<string, unknown> {
  validateUuidString(effect.albumId);
  return {
    protocolVersion: effect.protocolVersion,
    albumId: effect.albumId,
    assetType: effect.assetType,
    encryptedMeta: bytesToBase64(effect.encryptedMeta),
    encryptedMetaSidecar: effect.encryptedMetaSidecar === undefined
      ? null
      : bytesToBase64(effect.encryptedMetaSidecar),
    signature: bytesToBase64(effect.signature),
    signerPubkey: bytesToBase64(effect.signerPubkey),
    shardIds: [],
    tieredShards: effect.tieredShards.map((shard) => ({
      ...shard,
      shardId: validateUuidString(shard.shardId),
      sha256: sha256ToHex(shard.sha256),
    })),
  };
}

function toFinalizeTieredShards(task: UploadTask): ManifestFinalizeTieredShard[] {
  return [...task.completedShards]
    .map((shard): ManifestFinalizeTieredShard => ({
      shardId: shard.shardId,
      tier: shard.tier ?? 3,
      shardIndex: shard.index,
      sha256: sha256ToHex(shard.sha256),
      contentLength: shard.contentLength ?? task.file.size,
      envelopeVersion: shard.envelopeVersion ?? 3,
    }))
    .sort((a, b) => a.tier - b.tier || a.shardIndex - b.shardIndex);
}

function uploadJobIdForTask(task: UploadTask): string {
  const taskWithJobId = task as UploadTask & { readonly uploadJobId?: unknown };
  return typeof taskWithJobId.uploadJobId === 'string' && taskWithJobId.uploadJobId.length > 0
    ? taskWithJobId.uploadJobId
    : task.id;
}

async function readFinalizeResponse(
  response: Response,
): Promise<ManifestFinalizeResponse> {
  const json = await response.json().catch(() => undefined);
  const parsed = ManifestFinalizeResponseSchema.safeParse(json);
  if (parsed.success) {
    return parsed.data;
  }
  throw new ManifestFinalizationError(
    response.status,
    MANIFEST_MALFORMED_RESPONSE,
    'Manifest finalization failed: malformed finalize response',
  );
}

async function readFinalizeResponseOrSubmitMalformed(
  response: Response,
  effect: FinalizeManifestEffect,
  adapter: ManifestFinalizationAdapter | undefined,
): Promise<ManifestFinalizeResponse> {
  try {
    return await readFinalizeResponse(response);
  } catch (error) {
    if (error instanceof ManifestFinalizationError && error.code === MANIFEST_MALFORMED_RESPONSE) {
      await adapter?.submit({
        kind: 'NonRetryableFailure',
        effectId: effect.effectId,
        errorCode: 0,
        targetPhase: 'Failed',
      });
    }
    throw error;
  }
}

function manifestFinalizeErrorManifestId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const candidate = value as Record<string, unknown>;
  return typeof candidate.manifestId === 'string' ? candidate.manifestId : '';
}

function manifestFinalizeErrorDetail(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'manifest already finalized';
  const candidate = value as Record<string, unknown>;
  return typeof candidate.detail === 'string' ? candidate.detail : 'manifest already finalized';
}

function validateUuidString(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error('Malformed UUID: expected 32 hexadecimal UUID bytes');
  }
  return uuid;
}

function sha256ToHex(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    return bytesToHex(base64UrlToBytes(trimmed));
  } catch {
    throw new Error('Malformed SHA-256: expected 64 hex characters or base64url-encoded 32 bytes');
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    output[i] = binary.charCodeAt(i);
  }
  if (output.byteLength !== SHA256_BYTES) {
    throw new Error('Invalid SHA-256 length');
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
