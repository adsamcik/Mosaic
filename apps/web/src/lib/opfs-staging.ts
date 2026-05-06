import sodium from 'libsodium-wrappers-sumo';

/** Stable job identifier. Hex-encoded 16-byte UUID matching Rust JobId. */
export type JobId = string;

/** Stable photo identifier. UUID v7 matching the existing PhotoMeta.id semantics. */
export type PhotoId = string;

/** Storage layout root: ALL download staging lives under "/downloads/" in OPFS. */
export const STAGING_ROOT = 'downloads';

/** Per-job dir layout reserved names. */
export interface JobDirLayout {
  readonly snapshotFile: 'snapshot.cbor';
  readonly snapshotTempFile: 'snapshot.cbor.tmp';
  readonly photosDir: 'photos';
}

/** Result of a quota check. */
export interface OpfsQuotaInfo {
  readonly availableBytes: number;
  readonly totalBytes: number;
  /** True when the browser reported a quota; false on browsers that don't. */
  readonly reported: boolean;
}

/** Machine-readable failure codes surfaced by OPFS staging operations. */
export const OpfsStagingErrorCode = Object.freeze({
  Unsupported: 'OPFS_UNSUPPORTED',
  JobNotFound: 'JOB_NOT_FOUND',
  PhotoNotFound: 'PHOTO_NOT_FOUND',
  TornFile: 'TORN_FILE',
  QuotaExceeded: 'QUOTA_EXCEEDED',
  IoError: 'IO_ERROR',
  ChecksumMismatch: 'CHECKSUM_MISMATCH',
});

export type OpfsStagingErrorCode =
  (typeof OpfsStagingErrorCode)[keyof typeof OpfsStagingErrorCode];

/** Typed error class for OPFS-staging failures. */
export class OpfsStagingError extends Error {
  constructor(
    readonly code: OpfsStagingErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OpfsStagingError';
  }
}

const JOB_LAYOUT: JobDirLayout = {
  snapshotFile: 'snapshot.cbor',
  snapshotTempFile: 'snapshot.cbor.tmp',
  photosDir: 'photos',
};

const SNAPSHOT_ENVELOPE_VERSION = 1;
const SNAPSHOT_ENVELOPE_MIN_BYTES = 1;
const SNAPSHOT_BODY_LAST_UPDATED_AT_MS_KEY = 4;
const SNAPSHOT_CHECKSUM_BYTES = 32;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const JOB_ID_PATTERN = /^[0-9a-fA-F]{32}$/u;
const PHOTO_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

let opfsSupportedCache: boolean | null = null;
const photoAccessHandleCache = new Map<string, FileSystemSyncAccessHandle>();

interface SyncAccessFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface WritableFileHandle extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

interface MovableFileHandle extends FileSystemFileHandle {
  move(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

interface EnumerableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface CborEnvelope {
  readonly body: Uint8Array;
  readonly checksum: Uint8Array;
}

/**
 * Feature-detects Origin Private File System support and caches the outcome.
 * This performs a harmless root-directory probe so callers can avoid starting
 * durable download staging on browsers without OPFS.
 */
export async function isOpfsSupported(): Promise<boolean> {
  if (opfsSupportedCache !== null) {
    return opfsSupportedCache;
  }

  try {
    opfsSupportedCache = typeof navigator !== 'undefined'
      && typeof navigator.storage?.getDirectory === 'function'
      && await navigator.storage.getDirectory().then(() => true, () => false);
    return opfsSupportedCache;
  } catch {
    opfsSupportedCache = false;
    return false;
  }
}

/**
 * Returns the OPFS `/downloads/` staging root, creating it on first use.
 * Every job directory and snapshot managed by this module is scoped beneath
 * this directory.
 */
export async function getStagingRoot(): Promise<FileSystemDirectoryHandle> {
  return withIoErrors(async () => {
    const root = await getOpfsRoot();
    return root.getDirectoryHandle(STAGING_ROOT, { create: true });
  }, 'Unable to open OPFS download staging root');
}

/**
 * Creates the per-job staging directory and its `photos/` child. The operation
 * is idempotent so resume setup can call it repeatedly for the same job.
 */
export async function createJobDir(jobId: JobId): Promise<void> {
  const safeJobId = validateJobId(jobId);
  await withIoErrors(async () => {
    const root = await getStagingRoot();
    const jobDir = await root.getDirectoryHandle(safeJobId, { create: true });
    await jobDir.getDirectoryHandle(JOB_LAYOUT.photosDir, { create: true });
  }, `Unable to create OPFS staging directory for job ${safeJobId}`);
}

/** Checks whether a job staging directory currently exists under `/downloads/`. */
export async function jobExists(jobId: JobId): Promise<boolean> {
  const safeJobId = validateJobId(jobId);
  const root = await getStagingRoot();
  try {
    await root.getDirectoryHandle(safeJobId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists valid job directories beneath `/downloads/` for startup resume discovery
 * and garbage collection. Non-job entries are ignored.
 */
export async function listJobs(): Promise<JobId[]> {
  return withIoErrors(async () => {
    const root = await getStagingRoot();
    const jobs: JobId[] = [];
    if (!hasEntries(root)) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.Unsupported,
        'OPFS directory iteration is not supported by this browser',
      );
    }
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory' && JOB_ID_PATTERN.test(name)) {
        jobs.push(name);
      }
    }
    return jobs.sort();
  }, 'Unable to list OPFS staging jobs');
}

/**
 * Writes a byte chunk into a staged photo at the exact caller-supplied offset.
 * This creates the photo file if needed and uses a synchronous access handle
 * when the browser exposes one, falling back to async writable streams.
 */
export async function writePhotoChunk(
  jobId: JobId,
  photoId: PhotoId,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  const safeJobId = validateJobId(jobId);
  const safePhotoId = validatePhotoId(photoId);
  validateNonNegativeInteger(offset, 'offset');
  await withQuotaMapping(async () => {
    const fileHandle = await getPhotoFileHandle(safeJobId, safePhotoId, true);
    if (fileHandle === null) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.IoError,
        `Unable to create staged photo ${safePhotoId} for job ${safeJobId}`,
      );
    }
    await writeBytesAt(fileHandle, cacheKey(safeJobId, safePhotoId), offset, bytes);
  });
}

/**
 * Returns the current byte length of a staged photo file, or `null` when the
 * file is absent. This intentionally reports only file-system truth; torn-file
 * decisions remain the Rust orchestrator's responsibility.
 */
export async function getPhotoFileLength(jobId: JobId, photoId: PhotoId): Promise<number | null> {
  const safeJobId = validateJobId(jobId);
  const safePhotoId = validatePhotoId(photoId);
  return withIoErrors(async () => {
    const fileHandle = await getPhotoFileHandle(safeJobId, safePhotoId, false);
    if (fileHandle === null) {
      return null;
    }
    const file = await fileHandle.getFile();
    return file.size;
  }, `Unable to read staged photo length for job ${safeJobId}`);
}

/**
 * Truncates a staged photo to a snapshot-authoritative byte length. Resume code
 * uses this when the on-disk file is longer than Rust's persisted claim.
 */
export async function truncatePhotoTo(
  jobId: JobId,
  photoId: PhotoId,
  length: number,
): Promise<void> {
  const safeJobId = validateJobId(jobId);
  const safePhotoId = validatePhotoId(photoId);
  validateNonNegativeInteger(length, 'length');
  await withIoErrors(async () => {
    const fileHandle = await getPhotoFileHandle(safeJobId, safePhotoId, false);
    if (fileHandle === null) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.PhotoNotFound,
        `Photo ${safePhotoId} is not staged for job ${safeJobId}`,
      );
    }
    const cached = photoAccessHandleCache.get(cacheKey(safeJobId, safePhotoId));
    if (cached !== undefined) {
      cached.truncate(length);
      cached.flush();
      return;
    }
    if (hasSyncAccessHandle(fileHandle)) {
      const accessHandle = await fileHandle.createSyncAccessHandle();
      try {
        accessHandle.truncate(length);
        accessHandle.flush();
      } finally {
        accessHandle.close();
      }
      return;
    }
    await truncateWithWritable(fileHandle, length);
  }, `Unable to truncate staged photo for job ${safeJobId}`);
}

/**
 * Opens a streaming reader for a staged photo. The photo bytes are not
 * materialized by this API; consumers can pipe the stream into ZIP or File
 * System Access writers for large downloads.
 */
export async function readPhotoStream(
  jobId: JobId,
  photoId: PhotoId,
): Promise<ReadableStream<Uint8Array>> {
  const safeJobId = validateJobId(jobId);
  const safePhotoId = validatePhotoId(photoId);
  return withIoErrors(async () => {
    const fileHandle = await getPhotoFileHandle(safeJobId, safePhotoId, false);
    if (fileHandle === null) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.PhotoNotFound,
        `Photo ${safePhotoId} is not staged for job ${safeJobId}`,
      );
    }
    return fileHandle.getFile().then((file) => file.stream());
  }, `Unable to read staged photo stream for job ${safeJobId}`);
}

/**
 * Atomically commits Rust snapshot bytes for a job. The persisted file is the
 * Rust envelope `{0: version, 1: body, 2: checksum}` encoded as CBOR, where the
 * checksum is BLAKE2b-256 over `body`. OPFS `move()` is required so older
 * browsers without atomic rename surface an IO error instead of falling back to
 * a non-atomic rewrite.
 */
export async function writeSnapshot(
  jobId: JobId,
  bytes: Uint8Array,
  checksum: Uint8Array,
): Promise<void> {
  const safeJobId = validateJobId(jobId);
  if (checksum.byteLength !== SNAPSHOT_CHECKSUM_BYTES) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.ChecksumMismatch,
      `Snapshot checksum must be ${SNAPSHOT_CHECKSUM_BYTES} bytes`,
    );
  }
  await verifyChecksum(bytes, checksum);
  await withQuotaMapping(async () => {
    await createJobDir(safeJobId);
    const jobDir = await getJobDir(safeJobId, false);
    const tempHandle = await jobDir.getFileHandle(JOB_LAYOUT.snapshotTempFile, { create: true });
    await rewriteFile(tempHandle, encodeSnapshotEnvelope(bytes, checksum));
    if (!hasMove(tempHandle)) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.IoError,
        'OPFS file move() is required for atomic snapshot commit',
      );
    }
    await tempHandle.move(jobDir, JOB_LAYOUT.snapshotFile);
  });
}

/**
 * Reads and verifies the committed Rust snapshot envelope for a job. Temporary
 * snapshot files are ignored so a crash during commit cannot shadow the most
 * recent complete snapshot.
 */
export async function readSnapshot(
  jobId: JobId,
): Promise<{ body: Uint8Array; checksum: Uint8Array } | null> {
  const safeJobId = validateJobId(jobId);
  return withIoErrors(async () => {
    const jobDir = await getJobDir(safeJobId, false);
    const snapshotHandle = await getFileIfExists(jobDir, JOB_LAYOUT.snapshotFile);
    if (snapshotHandle === null) {
      return null;
    }
    const envelopeBytes = await readFileBytes(snapshotHandle);
    if (envelopeBytes.byteLength < SNAPSHOT_ENVELOPE_MIN_BYTES) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.ChecksumMismatch,
        'Snapshot envelope is too small to be valid',
      );
    }
    const envelope = decodeSnapshotEnvelope(envelopeBytes);
    await verifyChecksum(envelope.body, envelope.checksum);
    return envelope;
  }, `Unable to read snapshot for job ${safeJobId}`);
}

/**
 * Removes an entire job staging directory, including snapshots and photos. The
 * operation is tolerant of already-missing jobs so cancellation cleanup can be
 * retried safely.
 */
export async function purgeJob(jobId: JobId): Promise<void> {
  const safeJobId = validateJobId(jobId);
  await withIoErrors(async () => {
    closeCachedHandlesForJob(safeJobId);
    const root = await getStagingRoot();
    try {
      await root.removeEntry(safeJobId, { recursive: true });
    } catch {
      // Idempotent purge: missing job directories are already purged.
    }
  }, `Unable to purge OPFS staging directory for job ${safeJobId}`);
}

/**
 * Garbage-collects stale download staging jobs using `last_updated_at_ms` from
 * the verified Rust snapshot body. Corrupt snapshots are preserved for twice the
 * normal age window and then purged to avoid leaking storage forever.
 */
export async function gcStaleJobs(opts: {
  nowMs: number;
  maxAgeMs: number;
  preserveJobIds?: ReadonlySet<JobId>;
}): Promise<{ purged: JobId[]; preserved: JobId[] }> {
  validateNonNegativeInteger(opts.nowMs, 'nowMs');
  validateNonNegativeInteger(opts.maxAgeMs, 'maxAgeMs');
  const purged: JobId[] = [];
  const preserved: JobId[] = [];
  const jobs = await listJobs();
  for (const jobId of jobs) {
    if (opts.preserveJobIds?.has(jobId) === true) {
      preserved.push(jobId);
      continue;
    }

    try {
      const snapshot = await readSnapshot(jobId);
      if (snapshot === null) {
        preserved.push(jobId);
        continue;
      }
      const lastUpdatedAtMs = readLastUpdatedAtMs(snapshot.body);
      if (opts.nowMs - lastUpdatedAtMs > opts.maxAgeMs) {
        await purgeJob(jobId);
        purged.push(jobId);
      } else {
        preserved.push(jobId);
      }
    } catch {
      const modifiedAtMs = await getSnapshotLastModifiedMs(jobId);
      if (opts.nowMs - modifiedAtMs > opts.maxAgeMs * 2) {
        await purgeJob(jobId);
        purged.push(jobId);
      } else {
        preserved.push(jobId);
      }
    }
  }
  return { purged, preserved };
}

/**
 * Returns normalized storage quota information. Browsers that omit `estimate()`
 * report zero capacity with `reported=false` rather than throwing.
 */
export async function quotaInfo(): Promise<OpfsQuotaInfo> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
    return { availableBytes: 0, totalBytes: 0, reported: false };
  }
  const estimate = await navigator.storage.estimate();
  if (typeof estimate.quota !== 'number') {
    return { availableBytes: 0, totalBytes: 0, reported: false };
  }
  const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
  return {
    availableBytes: Math.max(0, estimate.quota - usage),
    totalBytes: estimate.quota,
    reported: true,
  };
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.Unsupported,
      'Origin Private File System is not supported by this browser',
    );
  }
  return navigator.storage.getDirectory();
}

async function getJobDir(jobId: JobId, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await getStagingRoot();
  try {
    return await root.getDirectoryHandle(jobId, { create });
  } catch (cause) {
    if (create) {
      throw cause;
    }
    throw new OpfsStagingError(
      OpfsStagingErrorCode.JobNotFound,
      `Job ${jobId} is not staged`,
      cause,
    );
  }
}

async function getPhotosDir(jobId: JobId, create: boolean): Promise<FileSystemDirectoryHandle> {
  const jobDir = await getJobDir(jobId, create);
  try {
    return await jobDir.getDirectoryHandle(JOB_LAYOUT.photosDir, { create });
  } catch (cause) {
    if (create) {
      throw cause;
    }
    throw new OpfsStagingError(
      OpfsStagingErrorCode.JobNotFound,
      `Job ${jobId} has no photos staging directory`,
      cause,
    );
  }
}

async function getPhotoFileHandle(
  jobId: JobId,
  photoId: PhotoId,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  const photosDir = await getPhotosDir(jobId, create);
  try {
    return await photosDir.getFileHandle(photoId, { create });
  } catch {
    if (create) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.IoError,
        `Unable to create staged photo ${photoId} for job ${jobId}`,
      );
    }
    return null;
  }
}

async function getFileIfExists(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch {
    return null;
  }
}

async function writeBytesAt(
  fileHandle: FileSystemFileHandle,
  key: string,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  const cached = photoAccessHandleCache.get(key);
  if (cached !== undefined) {
    cached.write(bytes, { at: offset });
    cached.flush();
    return;
  }

  if (hasSyncAccessHandle(fileHandle)) {
    const accessHandle = await fileHandle.createSyncAccessHandle();
    photoAccessHandleCache.set(key, accessHandle);
    accessHandle.write(bytes, { at: offset });
    accessHandle.flush();
    return;
  }

  await writeWithWritable(fileHandle, offset, bytes);
}

async function rewriteFile(fileHandle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  if (!hasWritable(fileHandle)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.Unsupported,
      'OPFS writable streams are not supported by this browser',
    );
  }
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  await writable.write(copyToArrayBuffer(bytes));
  await writable.close();
}

async function readFileBytes(fileHandle: FileSystemFileHandle): Promise<Uint8Array> {
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function hasSyncAccessHandle(handle: FileSystemFileHandle): handle is SyncAccessFileHandle {
  return 'createSyncAccessHandle' in handle;
}

function hasWritable(handle: FileSystemFileHandle): handle is WritableFileHandle {
  return 'createWritable' in handle;
}

function hasMove(handle: FileSystemFileHandle): handle is MovableFileHandle {
  return 'move' in handle;
}

function hasEntries(handle: FileSystemDirectoryHandle): handle is EnumerableDirectoryHandle {
  return 'entries' in handle;
}

async function writeWithWritable(
  fileHandle: FileSystemFileHandle,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  if (!hasWritable(fileHandle)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.Unsupported,
      'OPFS writable streams are not supported by this browser',
    );
  }
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.write({ type: 'write', position: offset, data: copyToArrayBuffer(bytes) });
  await writable.close();
}

async function truncateWithWritable(fileHandle: FileSystemFileHandle, length: number): Promise<void> {
  if (!hasWritable(fileHandle)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.Unsupported,
      'OPFS writable streams are not supported by this browser',
    );
  }
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.truncate(length);
  await writable.close();
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function validateJobId(jobId: JobId): JobId {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.IoError,
      'Invalid download job id; expected a 32-character hex string',
    );
  }
  return jobId;
}

function validatePhotoId(photoId: PhotoId): PhotoId {
  if (!PHOTO_ID_PATTERN.test(photoId)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.IoError,
      'Invalid photo id; expected a UUID string',
    );
  }
  return photoId;
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.IoError,
      `${name} must be a non-negative safe integer`,
    );
  }
}

function cacheKey(jobId: JobId, photoId: PhotoId): string {
  return `${jobId}/${photoId}`;
}

function closeCachedHandlesForJob(jobId: JobId): void {
  const prefix = `${jobId}/`;
  for (const [key, handle] of photoAccessHandleCache) {
    if (key.startsWith(prefix)) {
      handle.close();
      photoAccessHandleCache.delete(key);
    }
  }
}

async function withIoErrors<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof OpfsStagingError) {
      throw cause;
    }
    throw new OpfsStagingError(OpfsStagingErrorCode.IoError, message, cause);
  }
}

async function withQuotaMapping(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof OpfsStagingError) {
      throw cause;
    }
    if (isDomExceptionName(cause, 'QuotaExceededError')) {
      throw new OpfsStagingError(
        OpfsStagingErrorCode.QuotaExceeded,
        'OPFS quota exceeded while writing download staging data',
        cause,
      );
    }
    throw new OpfsStagingError(
      OpfsStagingErrorCode.IoError,
      'Unable to write OPFS download staging data',
      cause,
    );
  }
}

function isDomExceptionName(value: unknown, name: string): boolean {
  return value instanceof DOMException && value.name === name;
}

async function verifyChecksum(body: Uint8Array, checksum: Uint8Array): Promise<void> {
  await sodium.ready;
  const actual = sodium.crypto_generichash(SNAPSHOT_CHECKSUM_BYTES, body);
  if (!constantTimeEqual(actual, checksum)) {
    throw new OpfsStagingError(
      OpfsStagingErrorCode.ChecksumMismatch,
      'Snapshot BLAKE2b-256 checksum does not match its body',
    );
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function encodeSnapshotEnvelope(body: Uint8Array, checksum: Uint8Array): Uint8Array {
  const chunks = [
    encodeMapHeader(3),
    encodeUnsigned(0),
    encodeUnsigned(SNAPSHOT_ENVELOPE_VERSION),
    encodeUnsigned(1),
    encodeBytes(body),
    encodeUnsigned(2),
    encodeBytes(checksum),
  ];
  return concatBytes(chunks);
}

function encodeMapHeader(length: number): Uint8Array {
  return encodeTypeAndLength(5, length);
}

function encodeUnsigned(value: number): Uint8Array {
  return encodeTypeAndLength(0, value);
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeTypeAndLength(2, bytes.byteLength), bytes]);
}

function encodeTypeAndLength(majorType: number, length: number): Uint8Array {
  if (length < 24) {
    return Uint8Array.of((majorType << 5) | length);
  }
  if (length <= 0xff) {
    return Uint8Array.of((majorType << 5) | 24, length);
  }
  if (length <= 0xffff) {
    return Uint8Array.of((majorType << 5) | 25, length >> 8, length & 0xff);
  }
  return Uint8Array.of(
    (majorType << 5) | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  );
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeSnapshotEnvelope(bytes: Uint8Array): CborEnvelope {
  const reader = new CborReader(bytes);
  const mapLength = reader.readMapLength();
  let version: number | null = null;
  let body: Uint8Array | null = null;
  let checksum: Uint8Array | null = null;
  for (let i = 0; i < mapLength; i += 1) {
    const key = reader.readUnsignedNumber();
    if (key === 0) {
      version = reader.readUnsignedNumber();
    } else if (key === 1) {
      body = reader.readBytes();
    } else if (key === 2) {
      checksum = reader.readBytes();
    } else {
      reader.skipValue();
    }
  }
  if (!reader.done()) {
    throw checksumMismatch('Snapshot envelope has trailing bytes');
  }
  if (version !== SNAPSHOT_ENVELOPE_VERSION || body === null || checksum === null) {
    throw checksumMismatch('Snapshot envelope is missing required fields');
  }
  if (checksum.byteLength !== SNAPSHOT_CHECKSUM_BYTES || body.byteLength > MAX_SNAPSHOT_BYTES) {
    throw checksumMismatch('Snapshot envelope has invalid field sizes');
  }
  return { body, checksum };
}

function readLastUpdatedAtMs(body: Uint8Array): number {
  const reader = new CborReader(body);
  const mapLength = reader.readMapLength();
  for (let i = 0; i < mapLength; i += 1) {
    const key = reader.readUnsignedNumber();
    if (key === SNAPSHOT_BODY_LAST_UPDATED_AT_MS_KEY) {
      return reader.readUnsignedNumber();
    }
    reader.skipValue();
  }
  throw checksumMismatch('Snapshot body is missing last_updated_at_ms');
}

async function getSnapshotLastModifiedMs(jobId: JobId): Promise<number> {
  try {
    const jobDir = await getJobDir(jobId, false);
    const snapshot = await getFileIfExists(jobDir, JOB_LAYOUT.snapshotFile);
    if (snapshot === null) {
      return Number.POSITIVE_INFINITY;
    }
    const file = await snapshot.getFile();
    return file.lastModified;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function checksumMismatch(message: string): OpfsStagingError {
  return new OpfsStagingError(OpfsStagingErrorCode.ChecksumMismatch, message);
}

class CborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  readMapLength(): number {
    const header = this.readHeader();
    if (header.majorType !== 5) {
      throw checksumMismatch('Expected CBOR map');
    }
    return header.length;
  }

  readUnsignedNumber(): number {
    const header = this.readHeader();
    if (header.majorType !== 0) {
      throw checksumMismatch('Expected CBOR unsigned integer');
    }
    return header.length;
  }

  readBytes(): Uint8Array {
    const header = this.readHeader();
    if (header.majorType !== 2) {
      throw checksumMismatch('Expected CBOR byte string');
    }
    const start = this.offset;
    const end = start + header.length;
    if (end > this.bytes.byteLength) {
      throw checksumMismatch('CBOR byte string exceeds input length');
    }
    this.offset = end;
    return this.bytes.slice(start, end);
  }

  skipValue(): void {
    const header = this.readHeader();
    if (header.majorType === 0 || header.majorType === 1 || header.majorType === 7) {
      return;
    }
    if (header.majorType === 2 || header.majorType === 3) {
      this.offset += header.length;
      if (this.offset > this.bytes.byteLength) {
        throw checksumMismatch('CBOR scalar exceeds input length');
      }
      return;
    }
    if (header.majorType === 4) {
      for (let i = 0; i < header.length; i += 1) {
        this.skipValue();
      }
      return;
    }
    if (header.majorType === 5) {
      for (let i = 0; i < header.length; i += 1) {
        this.skipValue();
        this.skipValue();
      }
      return;
    }
    if (header.majorType === 6) {
      this.skipValue();
      return;
    }
    throw checksumMismatch('Unsupported CBOR value');
  }

  private readHeader(): { readonly majorType: number; readonly length: number } {
    const first = this.readByte();
    const majorType = first >> 5;
    const additional = first & 0x1f;
    if (additional < 24) {
      return { majorType, length: additional };
    }
    if (additional === 24) {
      return { majorType, length: this.readByte() };
    }
    if (additional === 25) {
      return { majorType, length: this.readByte() * 0x100 + this.readByte() };
    }
    if (additional === 26) {
      return { majorType, length: this.readUint32() };
    }
    if (additional === 27) {
      return { majorType, length: this.readUint64() };
    }
    throw checksumMismatch('Unsupported CBOR length encoding');
  }

  private readUint32(): number {
    return (
      this.readByte() * 0x1000000
      + this.readByte() * 0x10000
      + this.readByte() * 0x100
      + this.readByte()
    );
  }

  private readUint64(): number {
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      value = (value << 8n) | BigInt(this.readByte());
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw checksumMismatch('CBOR integer exceeds JavaScript safe integer range');
    }
    return Number(value);
  }

  private readByte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw checksumMismatch('Unexpected end of CBOR input');
    }
    this.offset += 1;
    return value;
  }
}