/**
 * Worker Types Integration Tests
 *
 * Tests that the worker API type definitions are internally consistent
 * and that the type system catches common errors.
 */

import { describe, expect, it } from 'vitest';
import type {
  Bounds,
  CryptoWorkerApi,
  DbWorkerApi,
  DecryptedManifest,
  EncryptedShard,
  GeoPoint,
  GeoWorkerApi,
  PhotoMeta,
} from '../src/workers/types';

describe('PhotoMeta type', () => {
  it('accepts valid photo metadata', () => {
    const photo: PhotoMeta = {
      id: 'photo-123',
      assetId: 'asset-456',
      albumId: 'album-789',
      filename: 'vacation.jpg',
      mimeType: 'image/jpeg',
      width: 4000,
      height: 3000,
      tags: ['vacation', 'beach'],
      createdAt: '2024-06-15T10:00:00Z',
      updatedAt: '2024-06-15T10:00:00Z',
    };

    expect(photo.id).toBe('photo-123');
    expect(photo.tags).toContain('vacation');
  });

  it('allows optional geo coordinates', () => {
    const photoWithGeo: PhotoMeta = {
      id: 'photo-123',
      assetId: 'asset-456',
      albumId: 'album-789',
      filename: 'geotagged.jpg',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      lat: 37.7749,
      lng: -122.4194,
      tags: [],
      createdAt: '2024-06-15T10:00:00Z',
      updatedAt: '2024-06-15T10:00:00Z',
    };

    expect(photoWithGeo.lat).toBe(37.7749);
    expect(photoWithGeo.lng).toBe(-122.4194);
  });

  it('allows optional takenAt', () => {
    const photo: PhotoMeta = {
      id: 'photo-123',
      assetId: 'asset-456',
      albumId: 'album-789',
      filename: 'no-exif.jpg',
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
      takenAt: '2024-01-15T14:30:00Z',
      tags: [],
      createdAt: '2024-06-15T10:00:00Z',
      updatedAt: '2024-06-15T10:00:00Z',
    };

    expect(photo.takenAt).toBe('2024-01-15T14:30:00Z');
  });
});

describe('DecryptedManifest type', () => {
  it('combines manifest record with decrypted metadata', () => {
    const manifest: DecryptedManifest = {
      id: 'manifest-123',
      albumId: 'album-456',
      versionCreated: 42,
      isDeleted: false,
      meta: {
        id: 'photo-789',
        assetId: 'asset-abc',
        albumId: 'album-456',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        width: 1000,
        height: 800,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      shardIds: ['shard-1', 'shard-2'],
    };

    expect(manifest.versionCreated).toBe(42);
    expect(manifest.meta.filename).toBe('test.jpg');
    expect(manifest.shardIds).toHaveLength(2);
  });
});

describe('GeoPoint type', () => {
  it('represents a point on the map', () => {
    const point: GeoPoint = {
      id: 'photo-123',
      lat: 40.7128,
      lng: -74.006,
    };

    expect(point.lat).toBeCloseTo(40.7128);
    expect(point.lng).toBeCloseTo(-74.006);
  });
});

describe('Bounds type', () => {
  it('represents a map bounding box', () => {
    const bounds: Bounds = {
      north: 41.0,
      south: 40.0,
      east: -73.5,
      west: -74.5,
    };

    expect(bounds.north).toBeGreaterThan(bounds.south);
    expect(bounds.east).toBeGreaterThan(bounds.west);
  });
});

describe('EncryptedShard type', () => {
  it('includes ciphertext and hash', () => {
    const shard: EncryptedShard = {
      ciphertext: new Uint8Array([1, 2, 3, 4, 5]),
      sha256: 'abc123def456',
    };

    expect(shard.ciphertext).toBeInstanceOf(Uint8Array);
    expect(shard.sha256).toBe('abc123def456');
  });
});

describe('Worker API interface completeness', () => {
  it('CryptoWorkerApi has required methods', () => {
    // Type-level test: verify the interface shape
    const requiredMethods: (keyof CryptoWorkerApi)[] = [
      'init',
      'clear',
      'getDbSessionKey',
      'encryptShard',
      'decryptShard',
      'decryptManifest',
      'verifyManifest',
      'getIdentityPublicKey',
      'deriveIdentity',
      'openEpochKeyBundle',
      'createEpochKeyBundle',
      'generateEpochKey',
      'signManifest',
      'deriveAuthKey',
    ];

    // This is a compile-time check - if CryptoWorkerApi is missing any method,
    // TypeScript will fail to compile
    expect(requiredMethods).toHaveLength(14);
  });

  it('DbWorkerApi has required methods', () => {
    const requiredMethods: (keyof DbWorkerApi)[] = [
      'init',
      'resetStorage',
      'close',
      'getAlbumVersion',
      'setAlbumVersion',
      'insertManifests',
      'deleteManifest',
      'getPhotos',
      'getPhotoCount',
      'searchPhotos',
      'getPhotosForMap',
      'getPhotoById',
      'clearAlbumPhotos',
    ];

    expect(requiredMethods).toHaveLength(13);
  });

  it('GeoWorkerApi has required methods', () => {
    const requiredMethods: (keyof GeoWorkerApi)[] = [
      'load',
      'getClusters',
      'getLeaves',
    ];

    expect(requiredMethods).toHaveLength(3);
  });
});
