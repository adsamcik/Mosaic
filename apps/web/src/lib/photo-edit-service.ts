import { getApi, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';
import { getDbClient } from './db-client';
import { getOrFetchEpochKey } from './epoch-key-service';
import { createLogger } from './logger';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('PhotoEditService');

export type RotationDelta = 90 | -90 | 180;

export async function rotatePhoto(
  photo: PhotoMeta,
  deltaDegrees: RotationDelta,
): Promise<PhotoMeta> {
  const currentRotation = photo.rotation ?? 0;
  const newRotation =
    ((currentRotation + deltaDegrees) % 360 + 360) % 360;

  log.info('Rotating photo', {
    photoId: photo.id,
    currentRotation,
    newRotation,
  });

  const newMeta: PhotoMeta = {
    ...photo,
    rotation: newRotation,
    updatedAt: new Date().toISOString(),
  };

  try {
    const bundle = await getOrFetchEpochKey(photo.albumId, photo.epochId);
    const crypto = await getCryptoClient();
    const encrypted = await crypto.encryptManifest(
      newMeta,
      bundle.epochSeed,
      photo.epochId,
    );
    const signature = await crypto.signManifest(
      encrypted.ciphertext,
      bundle.signKeypair.secretKey,
    );
    const signerPubkey = bundle.signKeypair.publicKey;

    const api = getApi();
    const result = await api.updateManifestMetadata(photo.id, {
      encryptedMeta: toBase64(encrypted.ciphertext),
      signature: toBase64(signature),
      signerPubkey: toBase64(signerPubkey),
    });

    const db = await getDbClient();
    await db.updatePhotoRotation(photo.id, newRotation, result.versionCreated);

    log.info('Photo rotated', {
      photoId: photo.id,
      currentRotation,
      newRotation,
    });

    return {
      ...photo,
      rotation: newRotation,
      updatedAt: newMeta.updatedAt,
    };
  } catch (error) {
    log.error('Failed to rotate photo', error, {
      photoId: photo.id,
      currentRotation,
      newRotation,
    });
    throw error;
  }
}

export async function updatePhotoDescription(
  photo: PhotoMeta,
  description: string | null,
): Promise<PhotoMeta> {
  const trimmed = (description ?? '').trim();
  if (trimmed.length > 2000) {
    throw new Error('Description too long (max 2000 characters)');
  }

  const normalized = trimmed.length === 0 ? null : trimmed;
  const currentDescription = photo.description ?? null;

  if (normalized === currentDescription) {
    log.debug('Description update skipped', {
      photoId: photo.id,
      previousLength: (photo.description ?? '').length,
      newLength: (normalized ?? '').length,
    });
    return photo;
  }

  log.info('Updating description', {
    photoId: photo.id,
    previousLength: (photo.description ?? '').length,
    newLength: (normalized ?? '').length,
  });

  const newMeta: PhotoMeta = {
    ...photo,
    updatedAt: new Date().toISOString(),
  };
  if (normalized === null) {
    delete newMeta.description;
  } else {
    newMeta.description = normalized;
  }

  try {
    const bundle = await getOrFetchEpochKey(photo.albumId, photo.epochId);
    const crypto = await getCryptoClient();
    const encrypted = await crypto.encryptManifest(
      newMeta,
      bundle.epochSeed,
      photo.epochId,
    );
    const signature = await crypto.signManifest(
      encrypted.ciphertext,
      bundle.signKeypair.secretKey,
    );
    const signerPubkey = bundle.signKeypair.publicKey;

    const api = getApi();
    const result = await api.updateManifestMetadata(photo.id, {
      encryptedMeta: toBase64(encrypted.ciphertext),
      signature: toBase64(signature),
      signerPubkey: toBase64(signerPubkey),
    });

    const db = await getDbClient();
    await db.updatePhotoDescription(photo.id, normalized, result.versionCreated);

    log.info('Description updated', {
      photoId: photo.id,
      previousLength: (photo.description ?? '').length,
      newLength: (normalized ?? '').length,
    });

    const updatedPhoto: PhotoMeta = {
      ...photo,
      updatedAt: newMeta.updatedAt,
    };
    if (normalized === null) {
      delete updatedPhoto.description;
    } else {
      updatedPhoto.description = normalized;
    }
    return updatedPhoto;
  } catch (error) {
    log.error('Failed to update description', error, {
      photoId: photo.id,
      previousLength: (photo.description ?? '').length,
      newLength: (normalized ?? '').length,
    });
    throw error;
  }
}
