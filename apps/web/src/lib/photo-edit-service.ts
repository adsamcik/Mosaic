import { getApi, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';
import { getDbClient } from './db-client';
import { fetchAndUnwrapEpochKeys } from './epoch-key-service';
import { getCurrentEpochKey } from './epoch-key-store';
import { createLogger } from './logger';
import { manifestTranscriptInputForPhotoMeta } from './manifest-transcript';
import type { EpochHandleId, PhotoMeta } from '../workers/types';

const log = createLogger('PhotoEditService');
const MANIFEST_SEQUENCE_STALE_RETRY_LIMIT = 1;

function isManifestSequenceStaleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    readonly status?: unknown;
    readonly problem?: unknown;
  };
  if (
    record.status !== 409 ||
    typeof record.problem !== 'object' ||
    record.problem === null
  ) {
    return false;
  }
  return (
    (record.problem as { readonly code?: unknown }).code ===
    'MANIFEST_SEQUENCE_STALE'
  );
}

export type RotationDelta = 90 | -90 | 180;

async function persistMetadataUpdate(
  photoId: string,
  newMeta: PhotoMeta,
): Promise<number> {
  await fetchAndUnwrapEpochKeys(newMeta.albumId);
  const bundle = getCurrentEpochKey(newMeta.albumId);
  if (bundle == null) {
    throw new Error(
      `cannot update manifest: no current epoch key cached for album ${newMeta.albumId}`,
    );
  }

  newMeta.epochId = bundle.epochId;
  const crypto = await getCryptoClient();
  const epochHandleId = bundle.epochHandleId as EpochHandleId;
  const plaintextJson = new TextEncoder().encode(JSON.stringify(newMeta));
  const encrypted = await crypto.encryptManifestWithEpoch(
    epochHandleId,
    plaintextJson,
  );
  const signerPubkey = bundle.signPublicKey;
  const api = getApi();
  const operationId = globalThis.crypto.randomUUID();

  for (
    let staleRetry = 0;
    staleRetry <= MANIFEST_SEQUENCE_STALE_RETRY_LIMIT;
    staleRetry += 1
  ) {
    const reservation = await api.reserveManifestSequence({
      albumId: newMeta.albumId,
      signerPubkey: toBase64(signerPubkey),
      targetManifestId: photoId,
      operationId,
      operationKind: 'MetadataUpdate',
    });
    const transcriptInput = {
      ...manifestTranscriptInputForPhotoMeta(newMeta, encrypted.envelopeBytes),
      manifestSeq: reservation.manifestSeq,
    };
    const transcript = await crypto.manifestTranscriptBytes(transcriptInput);
    const signature = await crypto.signManifestWithEpoch(
      epochHandleId,
      transcript,
    );

    try {
      const result = await api.updateManifestMetadata(photoId, {
        encryptedMeta: toBase64(encrypted.envelopeBytes),
        signature: toBase64(signature),
        signerPubkey: toBase64(signerPubkey),
        manifestSeq: reservation.manifestSeq,
        sequenceReservationId: reservation.reservationId,
      });
      return result.versionCreated;
    } catch (error) {
      if (
        !isManifestSequenceStaleError(error) ||
        staleRetry === MANIFEST_SEQUENCE_STALE_RETRY_LIMIT
      ) {
        throw error;
      }
    }
  }

  throw new Error(
    'Manifest metadata sequence retry loop exhausted unexpectedly',
  );
}

export async function rotatePhoto(
  photo: PhotoMeta,
  deltaDegrees: RotationDelta,
): Promise<PhotoMeta> {
  const currentRotation = photo.rotation ?? 0;
  const newRotation = (((currentRotation + deltaDegrees) % 360) + 360) % 360;

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
    const versionCreated = await persistMetadataUpdate(photo.id, newMeta);

    const db = await getDbClient();
    await db.updatePhotoRotation(photo.id, newRotation, versionCreated);

    log.info('Photo rotated', {
      photoId: photo.id,
      currentRotation,
      newRotation,
    });

    return newMeta;
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
    const versionCreated = await persistMetadataUpdate(photo.id, newMeta);

    const db = await getDbClient();
    await db.updatePhotoDescription(photo.id, normalized, versionCreated);

    log.info('Description updated', {
      photoId: photo.id,
      previousLength: (photo.description ?? '').length,
      newLength: (normalized ?? '').length,
    });

    return newMeta;
  } catch (error) {
    log.error('Failed to update description', error, {
      photoId: photo.id,
      previousLength: (photo.description ?? '').length,
      newLength: (normalized ?? '').length,
    });
    throw error;
  }
}
