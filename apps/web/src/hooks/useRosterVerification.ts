/**
 * useRosterVerification — gates album role badges on signed-roster
 * verification (audit `threat-model C-3`, batch C2c-3).
 *
 * Loads the album's signed-roster fields (`memberRosterSignature`,
 * `memberRosterSignerEpochId`, `memberRosterVersion`) from
 * `GET /api/albums/{id}` and verifies them against the live members
 * list using `verifyRosterSignature`. The returned tagged result lets
 * the UI render an "unverified roster" pill (or hide role badges
 * entirely) so a compromised server cannot fabricate admin/editor
 * badges.
 */

import { useEffect, useRef, useState } from 'react';
import { getApi } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import { createLogger } from '../lib/logger';
import {
  verifyRosterSignature,
  type RosterMemberInput,
  type RosterVerificationResult,
} from '../lib/member-roster-verify';

const log = createLogger('useRosterVerification');

export interface UseRosterVerificationResult {
  /** Tagged verification result; `null` while loading. */
  status: RosterVerificationResult | null;
  /** True while the album fetch or signature verify is in flight. */
  isLoading: boolean;
  /** Last fatal load error (e.g. album fetch 4xx). */
  error: Error | null;
}

/**
 * Verifies the owner-signed member roster for an album.
 *
 * The hook re-runs whenever `albumId`, the list of `(userId, role)`
 * pairs, or the `enabled` flag changes. Use `enabled=false` on
 * components where roster verification is not yet meaningful (e.g.
 * the member panel is closed) to avoid the API roundtrip.
 */
export function useRosterVerification(
  albumId: string | null,
  members: ReadonlyArray<RosterMemberInput>,
  enabled = true,
): UseRosterVerificationResult {
  const [status, setStatus] = useState<RosterVerificationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Snapshot the (userId, role) pairs as a stable string so the effect
  // does not re-run on identity-equal arrays with the same contents.
  // The roster transcript is order-invariant (sorted by userId bytes
  // server-side), but the membership data does change with invite /
  // remove flows and we want to re-verify on those changes.
  const membersKey = members
    .map((m) => `${m.userId}:${m.role}`)
    .sort()
    .join('|');
  const lastKey = useRef<string>('');

  useEffect(() => {
    if (!enabled || !albumId) {
      setStatus(null);
      setError(null);
      return;
    }

    const key = `${albumId}::${membersKey}`;
    if (key === lastKey.current && status !== null) {
      return;
    }
    lastKey.current = key;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const album = await getApi().getAlbum(albumId);
        if (cancelled) return;
        const crypto = await getCryptoClient();
        const result = await verifyRosterSignature(album, members, {
          fetchEpochKey: getOrFetchEpochKey,
          verifySignature: (transcript, signature, pubkey) =>
            crypto.verifySignatureWithEpoch(transcript, signature, pubkey),
        });
        if (cancelled) return;
        if (!result.verified) {
          log.warn('Album roster signature did not verify', {
            albumId,
            reason: result.reason,
          });
        }
        setStatus(result);
      } catch (err) {
        if (cancelled) return;
        const wrapped =
          err instanceof Error ? err : new Error(String(err));
        log.error('Album roster verification load failed', wrapped);
        setError(wrapped);
        setStatus(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId, membersKey, enabled]);

  return { status, isLoading, error };
}
