/**
 * Download tray scope context.
 *
 * The download tray is a single global view that may be presented to either
 * an authenticated user or a share-link visitor. To avoid leaking download
 * jobs across identities, every visible job is filtered by a scope key
 * derived from the *current* viewer's identity.
 *
 * - Authenticated path: the {@link useDownloadScopeKey} hook computes
 *   `auth:<hex>` from the current account id.
 * - Visitor path: SharedGallery wraps its subtree in this provider so the
 *   hook returns the precomputed `visitor:<hex>` instead of falling back to
 *   the auth derivation.
 *
 * Only the prefix portion of the scope key is safe to log; the hex tail is
 * an opaque pseudonymous handle (see `apps/web/src/lib/scope-key.ts`).
 */
import { createContext, type ReactNode } from 'react';

export const DownloadScopeContext = createContext<string | null>(null);

export interface DownloadScopeProviderProps {
  /** Visitor scope key (`visitor:<32-hex>`) or `null` to opt out. */
  readonly scopeKey: string | null;
  readonly children: ReactNode;
}

export function DownloadScopeProvider({
  scopeKey,
  children,
}: DownloadScopeProviderProps): ReactNode {
  return (
    <DownloadScopeContext.Provider value={scopeKey}>
      {children}
    </DownloadScopeContext.Provider>
  );
}