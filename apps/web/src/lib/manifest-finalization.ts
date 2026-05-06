import { getCryptoClient } from './crypto-client';
import type { EpochKeyBundle } from './epoch-key-store';
import type { PhotoMeta, TieredShardIds } from '../workers/types';
import type { UploadTask } from './upload/types';
import type { UploadEvent, UploadEffect } from './rust-core/upload-adapter-port';

const API_BASE = '/api';
const SHARD_TRANSCRIPT_RECORD_BYTES = 53;
const UUID_BYTES = 16;
const SHA256_BYTES = 32;

export const MANIFEST_INVALID_SIGNATURE = 400;
export const MANIFEST_TRANSCRIPT_MISMATCH = 422;

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

export interface ManifestFinalized {
  readonly kind: 'ManifestFinalized';
  readonly response: ManifestFinalizeResponse;
}

export interface ManifestAlreadyFinalized {
  readonly kind: 'AlreadyFinalized';
  readonly manifestId: string;
  readonly detail: string;
}

export type ManifestFinalizationResult = ManifestFinalized | ManifestAlreadyFinalized;

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
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestFinalizationError';
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
  const transcript = await buildManifestTranscriptBytes({
    albumId: task.albumId,
    epochId: task.epochId,
    encryptedMeta: encrypted.envelopeBytes,
    tieredShards: finalizeShards,
  });
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
  const response = await fetchFn(
    `${API_BASE}/manifests/${encodeURIComponent(effect.manifestId)}/finalize`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(toFinalizeRequestBody(effect)),
    },
  );

  if (response.ok) {
    const finalized = await readFinalizeResponse(response, effect);
    await options.adapter?.submit({
      kind: 'ManifestFinalized',
      effectId: effect.effectId,
      assetId: finalized.manifestId,
      sinceMetadataVersion: BigInt(finalized.metadataVersion),
    });
    return { kind: 'ManifestFinalized', response: finalized };
  }

  if (response.status === 409) {
    if (response.headers.get('Idempotency-Replayed') === 'true') {
      const finalized = await readFinalizeResponse(response, effect);
      await options.adapter?.submit({
        kind: 'ManifestFinalized',
        effectId: effect.effectId,
        assetId: finalized.manifestId,
        sinceMetadataVersion: BigInt(finalized.metadataVersion),
      });
      return { kind: 'ManifestFinalized', response: finalized };
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
      kind: 'ManifestFailed',
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

  const body = await response.text().catch(() => '');
  throw new ManifestFinalizationError(
    response.status,
    response.status,
    `Manifest finalization failed with HTTP ${String(response.status)}${body ? `: ${body}` : ''}`,
  );
}

export async function buildManifestTranscriptBytes(input: {
  readonly albumId: string;
  readonly epochId: number;
  readonly encryptedMeta: Uint8Array;
  readonly tieredShards: readonly ManifestFinalizeTieredShard[];
}): Promise<Uint8Array> {
  const albumId = uuidToBytes(input.albumId, UUID_BYTES);
  const encodedShards = encodeTranscriptShards(input.tieredShards);
  const transcript = new Uint8Array(
    albumId.byteLength + 4 + input.encryptedMeta.byteLength + encodedShards.byteLength,
  );
  let offset = 0;
  transcript.set(albumId, offset);
  offset += albumId.byteLength;
  writeU32Le(transcript, offset, input.epochId);
  offset += 4;
  transcript.set(input.encryptedMeta, offset);
  offset += input.encryptedMeta.byteLength;
  transcript.set(encodedShards, offset);
  return transcript;
}

function toFinalizeRequestBody(effect: FinalizeManifestEffect): Record<string, unknown> {
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
    tieredShards: effect.tieredShards,
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
  effect: FinalizeManifestEffect,
): Promise<ManifestFinalizeResponse> {
  const json = await response.json().catch(() => undefined);
  if (isManifestFinalizeResponse(json)) {
    return json;
  }
  return {
    protocolVersion: effect.protocolVersion,
    manifestId: effect.manifestId,
    metadataVersion: 0,
    createdAt: new Date(0).toISOString(),
    tieredShards: effect.tieredShards,
  };
}

function isManifestFinalizeResponse(value: unknown): value is ManifestFinalizeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.protocolVersion === 'number'
    && typeof candidate.manifestId === 'string'
    && typeof candidate.metadataVersion === 'number'
    && typeof candidate.createdAt === 'string'
    && Array.isArray(candidate.tieredShards);
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

function encodeTranscriptShards(shards: readonly ManifestFinalizeTieredShard[]): Uint8Array {
  const output = new Uint8Array(shards.length * SHARD_TRANSCRIPT_RECORD_BYTES);
  let offset = 0;
  for (const shard of shards) {
    const shardId = uuidToBytes(shard.shardId, UUID_BYTES);
    const sha256 = hexToBytes(shard.sha256);
    writeU32Le(output, offset, shard.shardIndex);
    offset += 4;
    output[offset] = shard.tier;
    offset += 1;
    output.set(shardId, offset);
    offset += UUID_BYTES;
    output.set(sha256, offset);
    offset += SHA256_BYTES;
  }
  return output;
}

function writeU32Le(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
  output[offset + 2] = (value >>> 16) & 0xff;
  output[offset + 3] = (value >>> 24) & 0xff;
}

function uuidToBytes(uuid: string, fallbackLength: number): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    return hexToBytes(hex);
  }
  return textFallbackBytes(uuid, fallbackLength);
}

function sha256ToHex(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    return bytesToHex(base64UrlToBytes(trimmed));
  } catch {
    return bytesToHex(textFallbackBytes(trimmed, SHA256_BYTES));
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex length');
  }
  const output = new Uint8Array(hex.length / 2);
  for (let i = 0; i < output.length; i++) {
    output[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return output;
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

function textFallbackBytes(value: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const output = new Uint8Array(length);
  for (let i = 0; i < output.length; i++) {
    output[i] = encoded[i % Math.max(encoded.length, 1)] ?? 0;
  }
  return output;
}
