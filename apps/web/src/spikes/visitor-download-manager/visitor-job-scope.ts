/**
 * Throwaway spike helper for the visitor download-manager investigation.
 *
 * This is intentionally not imported by production code. It demonstrates the
 * proposed split between a random coordinator jobId and a stable visitor scope
 * derived from the share-link context.
 */
export interface VisitorDownloadContext {
  readonly linkId: string;
  readonly albumId: string;
}

export interface VisitorDownloadScope {
  /** Opaque owner key for filtering jobs; never a raw share-link id. */
  readonly ownerKey: string;
  /** Optional scoped BroadcastChannel topic to avoid cross-link wakeups. */
  readonly channelName: string;
  /** localStorage key for the pre-OPFS disclosure acknowledgement. */
  readonly disclosureStorageKey: string;
  /** Suggested visitor GC window for inactive staging bytes. */
  readonly gcMaxAgeMs: number;
}

export const VISITOR_STAGING_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function deriveVisitorDownloadScope(context: VisitorDownloadContext): VisitorDownloadScope {
  const linkId = requireNonEmpty(context.linkId, 'linkId');
  const albumId = requireNonEmpty(context.albumId, 'albumId');
  const linkHash = fnv1aHex(`link:${linkId}`);
  const ownerHash = fnv1aHex(`visitor:${linkId}:album:${albumId}`);

  return {
    ownerKey: `visitor:${ownerHash}`,
    channelName: `mosaic-download-jobs:${linkHash}`,
    disclosureStorageKey: `mosaic.download.visitorDisclosure.${ownerHash}`,
    gcMaxAgeMs: VISITOR_STAGING_GC_MAX_AGE_MS,
  };
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required for visitor download scoping`);
  }
  return trimmed;
}

/** Non-cryptographic placeholder hash for spike-only deterministic examples. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
