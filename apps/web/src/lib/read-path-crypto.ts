import type { CryptoWorkerApi, EpochHandleId, LinkTierHandleId } from '../workers/types';

export type EpochReadHandleId = EpochHandleId | bigint;

export class InvalidCryptoHandleError extends Error {
  constructor(handleName: string) {
    super(`${handleName} must be a non-zero crypto handle`);
    this.name = 'InvalidCryptoHandleError';
  }
}

export function assertValidEpochHandle(
  epochHandleId: EpochReadHandleId,
): void {
  if (typeof epochHandleId === 'bigint' && epochHandleId === 0n) {
    throw new InvalidCryptoHandleError('epochHandleId');
  }
  if (typeof epochHandleId === 'string' && epochHandleId.length === 0) {
    throw new InvalidCryptoHandleError('epochHandleId');
  }
}

export function isLinkTierHandleId(
  value: Uint8Array | LinkTierHandleId,
): value is LinkTierHandleId {
  return typeof value === 'string' && value.length > 0;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Expected SHA256 hash must be base64url encoded');
  }

  const padLen = (4 - (value.length % 4)) % 4;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function decodeExpectedSha256(expectedSha256: string): Uint8Array {
  const decoded = decodeBase64Url(expectedSha256);
  if (decoded.length !== 32) {
    throw new Error(
      `Expected SHA256 hash must decode to 32 bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

export async function verifyDownloadedShard(
  crypto: Pick<CryptoWorkerApi, 'verifyShardIntegrity'>,
  envelope: Uint8Array,
  expectedSha256: string,
): Promise<boolean> {
  return crypto.verifyShardIntegrity(
    envelope,
    decodeExpectedSha256(expectedSha256),
  );
}
