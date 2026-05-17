/**
 * Delete Account Confirmation Dialog (v1.0.1 s15 — GDPR Article 17).
 *
 * Two-guard confirmation flow before calling `DELETE /api/v1/users/me`:
 *
 *   1. The user must type their exact username into a text field; the
 *      "Delete forever" button stays disabled until the text matches.
 *      Defends against accidental clicks.
 *   2. In LocalAuth mode, we transparently call `initAuth` + the crypto
 *      worker's `signAuthChallenge` to produce a fresh attestation that
 *      proves the caller still holds the password-derived auth key (and
 *      not just a stolen session cookie). In ProxyAuth mode the
 *      signature is skipped — the upstream proxy already gates each
 *      request.
 *
 * After the server returns 204 we wipe **all** local state on this
 * device (OPFS, IDB, CacheStorage, localStorage, sessionStorage, crypto
 * worker key cache) via `clearAllLocalState`, log the user out, and
 * surface a success toast. Failure paths preserve local state so the
 * user can retry.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getApi, toBase64, fromBase64 } from '../../lib/api';
import { getCryptoClient } from '../../lib/crypto-client';
import { closeDbClient } from '../../lib/db-client';
import { clearAllLocalState } from '../../lib/local-purge-all';
import { initAuth, isLocalAuthMode } from '../../lib/local-auth';
import { session } from '../../lib/session';

export interface DeleteAccountConfirmationDialogProps {
  /** Username of the currently logged-in user; used both as the confirmation target and to sign the fresh-auth challenge. */
  username: string;
  /** Invoked when the user cancels or the deletion succeeds. */
  onClose: () => void;
  /** Optional hook invoked AFTER local state is purged and before logout. Mostly for tests. */
  onDeleted?: () => void;
}

export function DeleteAccountConfirmationDialog({
  username,
  onClose,
  onDeleted,
}: DeleteAccountConfirmationDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMatch = useMemo(
    () => typed.length > 0 && typed === username,
    [typed, username],
  );

  // Reset typed text whenever the dialog is mounted; defends against a
  // stale state if the parent toggles the dialog without unmounting.
  useEffect(() => {
    setTyped('');
    setError(null);
  }, [username]);

  const handleConfirm = async () => {
    if (!isMatch || isDeleting) return;
    setIsDeleting(true);
    setError(null);

    try {
      const api = getApi();
      const requestBody: {
        confirmationText: string;
        challengeId?: string;
        confirmationSignature?: string;
        timestamp?: number;
      } = { confirmationText: typed };

      // LocalAuth mode → produce a fresh challenge+signature pair so
      // the server knows the caller currently controls the auth key.
      // We swallow detection errors and fall through with no signature
      // — the server will then refuse if it's actually in LocalAuth
      // mode, giving us a clear error to surface.
      let localAuth = false;
      try {
        localAuth = await isLocalAuthMode();
      } catch {
        localAuth = false;
      }

      if (localAuth) {
        try {
          const { challengeId, challenge, timestamp } = await initAuth(username);
          const cryptoClient = await getCryptoClient();
          const signature = await cryptoClient.signAuthChallenge(
            fromBase64(challenge),
            username,
            timestamp,
          );
          requestBody.challengeId = challengeId;
          requestBody.confirmationSignature = toBase64(signature);
          requestBody.timestamp = timestamp;
        } catch {
          setError(t('settings.deleteAccount.errorFreshAuth'));
          setIsDeleting(false);
          return;
        }
      }

      await api.deleteCurrentUser(requestBody);

      // Server has erased everything. Wipe local device state next — the
      // user is done with this machine. Failures here are non-fatal; we
      // still log out, since the session cookie is already invalidated.
      try {
        await closeDbClient();
      } catch {
        // ignore — DB may already be closed
      }
      try {
        await clearAllLocalState();
      } catch {
        // ignore — partial purge is still safer than aborting
      }

      onDeleted?.();
      await session.logout();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Map known server-side messages to friendlier strings.
      if (msg.toLowerCase().includes('confirmation')) {
        setError(t('settings.deleteAccount.errorConfirmationMismatch'));
      } else if (msg.toLowerCase().includes('fresh authentication')) {
        setError(t('settings.deleteAccount.errorFreshAuth'));
      } else {
        setError(t('settings.deleteAccount.errorGeneric'));
      }
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={() => !isDeleting && onClose()}
      data-testid="delete-account-dialog"
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
      >
        <div className="dialog-form">
          <h3 className="dialog-title" id="delete-account-title">
            {t('settings.deleteAccount.dialogTitle')}
          </h3>
          <p className="dialog-description">
            {t('settings.deleteAccount.warning')}
          </p>
          <ul className="clear-data-list">
            <li>{t('settings.deleteAccount.listAlbumsDeleted')}</li>
            <li>{t('settings.deleteAccount.listSharesInvalidated')}</li>
            <li>{t('settings.deleteAccount.listMembershipsRemoved')}</li>
            <li>{t('settings.deleteAccount.listAccountRemoved')}</li>
            <li>{t('settings.deleteAccount.listCannotUndo')}</li>
          </ul>
          <label htmlFor="delete-account-confirm" className="setting-label">
            {t('settings.deleteAccount.confirmationLabel', { username })}
          </label>
          <input
            id="delete-account-confirm"
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={isDeleting}
            placeholder={t('settings.deleteAccount.confirmationPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            data-testid="delete-account-confirm-input"
          />
          {error && (
            <div className="settings-error" data-testid="delete-account-error">
              <span className="error-icon">⚠️</span>
              <span>{error}</span>
            </div>
          )}
          <div className="dialog-actions">
            <button
              className="button-secondary"
              onClick={onClose}
              disabled={isDeleting}
              type="button"
              data-testid="delete-account-cancel-button"
            >
              {t('settings.deleteAccount.cancelButton')}
            </button>
            <button
              className="button-danger"
              onClick={handleConfirm}
              disabled={!isMatch || isDeleting}
              type="button"
              data-testid="delete-account-confirm-button"
            >
              {isDeleting
                ? t('settings.deleteAccount.deleting')
                : t('settings.deleteAccount.confirmButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
