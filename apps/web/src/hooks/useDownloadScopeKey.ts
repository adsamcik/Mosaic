/**
 * `useDownloadScopeKey` — current download-tray scope key.
 *
 * Resolution order:
 *   1. {@link DownloadScopeContext} — if set (e.g. by SharedGallery for the
 *      visitor path), its value is returned verbatim. Wins over auth state
 *      so a logged-in user browsing a share link sees the visitor scope.
 *   2. Authenticated fallback — `auth:<blake2b128(accountId || domainTag)>`
 *      derived via {@link deriveAuthScopeKey}.
 *   3. `null` — neither identity available, tray must be empty.
 *
 * The auth derivation is async (libsodium init), so it is computed in an
 * effect and cached in component state. Returning `null` while the auth
 * derivation is in flight is intentional: it prevents jobs from briefly
 * leaking into the wrong scope on first render.
 *
 * **ZK-safety:** never log the returned value. Use the `:` prefix only.
 */
import { useContext, useEffect, useState } from 'react';
import { DownloadScopeContext } from '../contexts/DownloadScopeContext';
import { deriveAuthScopeKey, ensureScopeKeySodiumReady } from '../lib/scope-key';
import { session } from '../lib/session';

export function useDownloadScopeKey(): string | null {
  const visitorScope = useContext(DownloadScopeContext);
  const [authScope, setAuthScope] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(
    session.currentUser?.id ?? null,
  );

  useEffect(() => {
    setAccountId(session.currentUser?.id ?? null);
    return session.subscribe(() => {
      setAccountId(session.currentUser?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (visitorScope !== null) return;
    if (accountId === null) {
      setAuthScope(null);
      return;
    }
    let cancelled = false;
    void ensureScopeKeySodiumReady().then(() => {
      if (cancelled) return;
      setAuthScope(deriveAuthScopeKey(accountId));
    });
    return () => {
      cancelled = true;
    };
  }, [visitorScope, accountId]);

  if (visitorScope !== null) return visitorScope;
  return authScope;
}