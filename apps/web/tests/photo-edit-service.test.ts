/**
 * Tests for photo-edit-service.ts.
 * Verifies encrypted manifest metadata updates for display-only rotation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

const mocks = vi.hoisted(() => {
  const envelopeBytes = new Uint8Array([1, 2, 3, 4]);
  const signature = new Uint8Array([5, 6, 7, 8]);
  const signerPubkey = new Uint8Array([9, 10, 11, 12]);
  const epochHandleId = 'epoch-handle-photo-edit';

  return {
    envelopeBytes,
    signature,
    signerPubkey,
    epochHandleId,
    encryptManifestWithEpoch: vi.fn(async () => ({
      envelopeBytes,
      sha256: 'manifest-hash',
    })),
    signManifestWithEpoch: vi.fn(async () => signature),
    updateManifestMetadata: vi.fn(async () => ({
      id: 'photo-1',
      versionCreated: 42,
    })),
    updatePhotoRotation: vi.fn(async () => undefined),
    updatePhotoDescription: vi.fn(async () => undefined),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => ({
    updateManifestMetadata: mocks.updateManifestMetadata,
  })),
  toBase64: vi.fn((arr: Uint8Array) => Buffer.from(arr).toString('base64')),
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      encryptManifestWithEpoch: mocks.encryptManifestWithEpoch,
      signManifestWithEpoch: mocks.signManifestWithEpoch,
    }),
  ),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn(() =>
    Promise.resolve({
      epochId: 7,
      epochHandleId: mocks.epochHandleId,
      signPublicKey: mocks.signerPubkey,
      // Slice 3 placeholder fields kept until Slice 4-7 retire all callers.
      epochSeed: new Uint8Array(0),
      signKeypair: {
        publicKey: mocks.signerPubkey,
        secretKey: new Uint8Array(0),
      },
    }),
  ),
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() =>
    Promise.resolve({
      updatePhotoRotation: mocks.updatePhotoRotation,
      updatePhotoDescription: mocks.updatePhotoDescription,
    }),
  ),
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: mocks.debug,
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
    startTimer: vi.fn(() => ({ end: vi.fn(), elapsed: vi.fn(() => 0) })),
    child: vi.fn(),
    scope: 'PhotoEditService',
  })),
}));

import { rotatePhoto, updatePhotoDescription } from '../src/lib/photo-edit-service';

function makePhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'image.jpg',
    mimeType: 'image/jpeg',
    width: 4000,
    height: 3000,
    takenAt: '2024-01-01T10:00:00.000Z',
    lat: 50.0755,
    lng: 14.4378,
    tags: ['trip', 'prague'],
    createdAt: '2024-01-01T10:01:00.000Z',
    updatedAt: '2024-01-01T10:02:00.000Z',
    shardIds: ['shard-thumb', 'shard-preview', 'shard-original'],
    shardHashes: ['hash-thumb', 'hash-preview', 'hash-original'],
    epochId: 7,
    thumbnail: 'thumb-base64',
    thumbWidth: 300,
    thumbHeight: 225,
    description: 'Original description',
    thumbhash: 'thumbhash',
    thumbnailShardId: 'thumb-shard',
    thumbnailShardHash: 'thumb-hash',
    previewShardId: 'preview-shard',
    previewShardHash: 'preview-hash',
    originalShardIds: ['original-shard'],
    originalShardHashes: ['original-hash'],
    ...overrides,
  };
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function decodePhotoMetaFromCall(
  call: readonly unknown[],
): PhotoMeta {
  const plaintext = call[1] as Uint8Array;
  return JSON.parse(new TextDecoder().decode(plaintext)) as PhotoMeta;
}

function containsHandleId(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(mocks.epochHandleId);
  }
  if (Array.isArray(value)) {
    return value.some(containsHandleId);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsHandleId);
  }
  return false;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsString(item, needle));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsString(item, needle));
  }
  return false;
}

describe('photo-edit-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManifestMetadata.mockResolvedValue({ id: 'photo-1', versionCreated: 42 });
  });

  describe('rotatePhoto', () => {
    it.each([
      ['no rotation plus 90', makePhoto(), 90, 90],
      ['90 plus 90', makePhoto({ rotation: 90 }), 90, 180],
      ['270 plus 90 wraps to 0', makePhoto({ rotation: 270 }), 90, 0],
      ['0 minus 90 wraps to 270', makePhoto({ rotation: 0 }), -90, 270],
      ['90 plus 180', makePhoto({ rotation: 90 }), 180, 270],
    ] as const)('computes rotation for %s', async (_name, photo, delta, expected) => {
      const result = await rotatePhoto(photo, delta);

      expect(result.rotation).toBe(expected);
      expect(mocks.updatePhotoRotation).toHaveBeenCalledWith(
        photo.id,
        expected,
        42,
      );
    });

    it('routes rotation through the epoch handle (Slice 4 contract)', async () => {
      const photo = makePhoto({ rotation: 0 });

      await rotatePhoto(photo, 90);

      expect(mocks.encryptManifestWithEpoch).toHaveBeenCalledTimes(1);
      const [encryptHandle] = mocks.encryptManifestWithEpoch.mock.calls[0]!;
      expect(encryptHandle).toBe(mocks.epochHandleId);

      expect(mocks.signManifestWithEpoch).toHaveBeenCalledTimes(1);
      const [signHandle, signedBytes] =
        mocks.signManifestWithEpoch.mock.calls[0]!;
      expect(signHandle).toBe(mocks.epochHandleId);
      expect(signedBytes).toEqual(mocks.envelopeBytes);
    });

    it('preserves photo identity fields and only changes rotation and updatedAt in encrypted metadata', async () => {
      const photo = makePhoto({ rotation: 90 });

      await rotatePhoto(photo, 180);

      expect(mocks.encryptManifestWithEpoch).toHaveBeenCalledTimes(1);
      const encryptedMeta = decodePhotoMetaFromCall(
        mocks.encryptManifestWithEpoch.mock.calls[0]!,
      );
      expect(encryptedMeta).toMatchObject({
        id: photo.id,
        assetId: photo.assetId,
        albumId: photo.albumId,
        filename: photo.filename,
        mimeType: photo.mimeType,
        width: photo.width,
        height: photo.height,
        takenAt: photo.takenAt,
        epochId: photo.epochId,
      });
      expect(encryptedMeta.shardIds).toEqual(photo.shardIds);
      expect(encryptedMeta.shardHashes).toEqual(photo.shardHashes);
      expect(encryptedMeta.originalShardIds).toEqual(photo.originalShardIds);

      const { rotation: _inputRotation, updatedAt: _inputUpdatedAt, ...inputRest } = photo;
      const { rotation: outputRotation, updatedAt: outputUpdatedAt, ...outputRest } = encryptedMeta;
      expect(outputRest).toEqual(inputRest);
      expect(outputRotation).toBe(270);
      expect(outputUpdatedAt).not.toBe(photo.updatedAt);
      expect(Date.parse(outputUpdatedAt)).not.toBeNaN();
    });

    it('updates manifest metadata through the API with base64 encoded encrypted bytes', async () => {
      const photo = makePhoto({ rotation: 270 });

      await rotatePhoto(photo, 90);

      expect(mocks.updateManifestMetadata).toHaveBeenCalledTimes(1);
      const [manifestId, request] = mocks.updateManifestMetadata.mock.calls[0]!;
      expect(manifestId).toBe(photo.id);
      expect(fromBase64(request.encryptedMeta)).toEqual(mocks.envelopeBytes);
      expect(fromBase64(request.signature)).toEqual(mocks.signature);
      expect(fromBase64(request.signerPubkey)).toEqual(mocks.signerPubkey);
    });

    it('updates local DB rotation after a successful API update', async () => {
      const photo = makePhoto({ rotation: 0 });

      await rotatePhoto(photo, 90);

      expect(mocks.updatePhotoRotation).toHaveBeenCalledTimes(1);
      expect(mocks.updatePhotoRotation).toHaveBeenCalledWith(photo.id, 90, 42);
    });

    it('does not update local DB when API update fails and bubbles the rejection', async () => {
      const error = new Error('server rejected update');
      mocks.updateManifestMetadata.mockRejectedValueOnce(error);
      const photo = makePhoto({ rotation: 90 });

      await expect(rotatePhoto(photo, 90)).rejects.toBe(error);

      expect(mocks.updatePhotoRotation).not.toHaveBeenCalled();
    });

    it('returns metadata with the new rotation and updated timestamp', async () => {
      const photo = makePhoto({ rotation: 90 });

      const result = await rotatePhoto(photo, 90);
      const encryptedMeta = decodePhotoMetaFromCall(
        mocks.encryptManifestWithEpoch.mock.calls[0]!,
      );

      expect(result).toEqual({
        ...photo,
        rotation: 180,
        updatedAt: encryptedMeta.updatedAt,
      });
      expect(result.updatedAt).not.toBe(photo.updatedAt);
    });

    it('does not log key material, encrypted metadata, or epoch handle ids', async () => {
      const photo = makePhoto({ rotation: 90 });

      await rotatePhoto(photo, 90);

      const loggerCalls = [
        ...mocks.debug.mock.calls,
        ...mocks.info.mock.calls,
        ...mocks.warn.mock.calls,
        ...mocks.error.mock.calls,
      ];
      const serializedCalls = JSON.stringify(loggerCalls);

      expect(serializedCalls).not.toContain('epochSeed');
      expect(serializedCalls).not.toContain('encryptedMeta');
      expect(serializedCalls).not.toContain('signerPubkey');
      expect(serializedCalls).not.toContain('signature');
      expect(loggerCalls.some(containsHandleId)).toBe(false);
    });
  });

  describe('updatePhotoDescription', () => {
    it('updates null description to a trimmed value', async () => {
      const photo = makePhoto({ description: undefined });

      const result = await updatePhotoDescription(photo, '  Hello  ');

      expect(mocks.updateManifestMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.updatePhotoDescription).toHaveBeenCalledWith(photo.id, 'Hello', 42);
      expect(result.description).toBe('Hello');
    });

    it('trims empty description to null and returns absent description', async () => {
      const photo = makePhoto({ description: 'Hello' });

      const result = await updatePhotoDescription(photo, '   ');

      expect(mocks.updateManifestMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.updatePhotoDescription).toHaveBeenCalledWith(photo.id, null, 42);
      expect(result.description).toBeUndefined();
    });

    it('short-circuits when the description is unchanged', async () => {
      const photo = makePhoto({ description: 'Hello' });

      const result = await updatePhotoDescription(photo, 'Hello');

      expect(result).toBe(photo);
      expect(mocks.updateManifestMetadata).not.toHaveBeenCalled();
      expect(mocks.updatePhotoDescription).not.toHaveBeenCalled();
    });

    it('short-circuits whitespace-only input when no description exists', async () => {
      const photo = makePhoto({ description: undefined });

      const result = await updatePhotoDescription(photo, '   ');

      expect(result).toBe(photo);
      expect(mocks.updateManifestMetadata).not.toHaveBeenCalled();
      expect(mocks.updatePhotoDescription).not.toHaveBeenCalled();
    });

    it('rejects descriptions over 2000 characters before doing work', async () => {
      const photo = makePhoto();
      const longDescription = 'a'.repeat(2001);

      await expect(updatePhotoDescription(photo, longDescription)).rejects.toThrow(
        'Description too long (max 2000 characters)',
      );

      expect(mocks.encryptManifestWithEpoch).not.toHaveBeenCalled();
      expect(mocks.updateManifestMetadata).not.toHaveBeenCalled();
      expect(mocks.updatePhotoDescription).not.toHaveBeenCalled();
    });

    it('does not update local DB when API update fails and bubbles the rejection', async () => {
      const error = new Error('server rejected update');
      mocks.updateManifestMetadata.mockRejectedValueOnce(error);
      const photo = makePhoto({ description: undefined });

      await expect(updatePhotoDescription(photo, 'Hello')).rejects.toBe(error);

      expect(mocks.updatePhotoDescription).not.toHaveBeenCalled();
    });

    it('does not log description text', async () => {
      const secretDescription = 'Sensitive picnic location';
      const photo = makePhoto({ description: 'Previous text' });

      await updatePhotoDescription(photo, secretDescription);

      const loggerCalls = [
        ...mocks.debug.mock.calls,
        ...mocks.info.mock.calls,
        ...mocks.warn.mock.calls,
        ...mocks.error.mock.calls,
      ];

      expect(loggerCalls.some((call) => containsString(call, secretDescription))).toBe(false);
    });

    it('preserves photo identity fields and only changes description and updatedAt in encrypted metadata', async () => {
      const photo = makePhoto({ description: 'Before', rotation: 90 });

      await updatePhotoDescription(photo, 'After');

      expect(mocks.encryptManifestWithEpoch).toHaveBeenCalledTimes(1);
      const encryptedMeta = decodePhotoMetaFromCall(
        mocks.encryptManifestWithEpoch.mock.calls[0]!,
      );
      expect(encryptedMeta).toMatchObject({
        id: photo.id,
        shardIds: photo.shardIds,
        epochId: photo.epochId,
        albumId: photo.albumId,
        takenAt: photo.takenAt,
        filename: photo.filename,
        mimeType: photo.mimeType,
        rotation: photo.rotation,
        description: 'After',
      });

      const { description: _inputDescription, updatedAt: _inputUpdatedAt, ...inputRest } = photo;
      const { description: outputDescription, updatedAt: outputUpdatedAt, ...outputRest } = encryptedMeta;
      expect(outputRest).toEqual(inputRest);
      expect(outputDescription).toBe('After');
      expect(outputUpdatedAt).not.toBe(photo.updatedAt);
      expect(Date.parse(outputUpdatedAt)).not.toBeNaN();
    });
  });
});
