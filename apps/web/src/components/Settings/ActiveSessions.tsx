/**
 * Active Sessions Settings Panel (v1.0.x sweep38)
 *
 * Lists active LocalAuth refresh-token sessions for the current user and lets
 * them revoke individual sessions or all-other-than-this devices. Talks to
 * the backend `/auth/sessions` endpoints (see AuthController).
 *
 * Endpoint contracts:
 *   GET    /api/v1/auth/sessions
 *     -> Array<{ id, deviceName, ipAddress, createdAt, lastSeenAt, isCurrent }>
 *   DELETE /api/v1/auth/sessions/{sessionId}
 *   POST   /api/v1/auth/sessions/revoke-others
 *     -> { revokedCount }
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest, ApiError } from '../../lib/api';

export interface ActiveSessionDto {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

interface PendingAction {
  kind: 'one' | 'all';
  sessionId?: string;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatLastSeen(value: string, locale?: string): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

export function ActiveSessions(): ReactElement {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<ActiveSessionDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [revokedCount, setRevokedCount] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<ActiveSessionDto[]>('/auth/sessions');
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Not LocalAuth mode — hide section gracefully.
        setSessions([]);
      } else {
        setError('errorGeneric');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRevokeOne = useCallback(async (sessionId: string) => {
    setBusy(true);
    try {
      await apiRequest(`/auth/sessions/${sessionId}`, { method: 'DELETE' });
      setSessions((prev) => (prev ?? []).filter((s) => s.id !== sessionId));
      setToast('revokeSuccessToast');
    } catch {
      setError('errorGeneric');
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, []);

  const handleRevokeAllOthers = useCallback(async () => {
    setBusy(true);
    try {
      const resp = await apiRequest<{ revokedCount: number }>(
        '/auth/sessions/revoke-others',
        { method: 'POST' }
      );
      const count = resp?.revokedCount ?? 0;
      setSessions((prev) => (prev ?? []).filter((s) => s.isCurrent));
      setRevokedCount(count);
      setToast('revokeAllSuccessToast');
    } catch {
      setError('errorGeneric');
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, []);

  // Hide section entirely if backend says "not local auth" (sessions === [] after a 404).
  if (sessions !== null && sessions.length === 0 && !loading && !error) {
    return <></>;
  }

  const locale = i18n.language;
  const hasOthers = (sessions ?? []).some((s) => !s.isCurrent);

  return (
    <section className="settings-section" data-testid="sessions-section">
      <h2 className="section-title">{t('settings.sessions.title')}</h2>
      <div className="settings-card">
        <p className="setting-description">
          {t('settings.sessions.description')}
        </p>

        {loading && (
          <div className="settings-loading" data-testid="sessions-loading">
            {t('settings.sessions.loading')}
          </div>
        )}

        {error && (
          <div className="settings-error" data-testid="sessions-error">
            <span className="error-icon">⚠️</span>
            <span>{t(`settings.sessions.${error}`)}</span>
          </div>
        )}

        {toast && (
          <div className="settings-toast" data-testid="sessions-toast" role="status">
            {toast === 'revokeAllSuccessToast'
              ? t('settings.sessions.revokeAllSuccessToast', { count: revokedCount })
              : t(`settings.sessions.${toast}`)}
          </div>
        )}

        {sessions && sessions.length > 0 && (
          <>
            <table className="settings-table sessions-table">
              <thead>
                <tr>
                  <th scope="col">{t('settings.sessions.deviceLabel')}</th>
                  <th scope="col">{t('settings.sessions.ipLabel')}</th>
                  <th scope="col">{t('settings.sessions.lastSeenLabel')}</th>
                  <th scope="col" aria-label="actions"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} data-testid={`session-row-${s.id}`}>
                    <td>
                      <span>{s.deviceName || t('settings.sessions.deviceLabel')}</span>
                      {s.isCurrent && (
                        <span
                          className="badge badge-current"
                          data-testid={`session-current-${s.id}`}
                        >
                          {t('settings.sessions.currentLabel')}
                        </span>
                      )}
                    </td>
                    <td>{truncate(s.ipAddress ?? '', 15)}</td>
                    <td>{formatLastSeen(s.lastSeenAt, locale)}</td>
                    <td>
                      {!s.isCurrent && (
                        <button
                          type="button"
                          className="button-danger"
                          disabled={busy}
                          data-testid={`revoke-button-${s.id}`}
                          onClick={() =>
                            setPending({ kind: 'one', sessionId: s.id })
                          }
                        >
                          {t('settings.sessions.revokeButton')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hasOthers && (
              <div className="setting-row">
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy}
                  data-testid="revoke-all-others-button"
                  onClick={() => setPending({ kind: 'all' })}
                >
                  {t('settings.sessions.revokeAllOthersButton')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {pending && (
        <div className="dialog-backdrop" data-testid="sessions-confirm-dialog">
          <div className="dialog" role="dialog" aria-modal="true">
            <h3 className="dialog-title">
              {pending.kind === 'all'
                ? t('settings.sessions.revokeAllConfirmTitle')
                : t('settings.sessions.revokeConfirmTitle')}
            </h3>
            <p className="dialog-description">
              {pending.kind === 'all'
                ? t('settings.sessions.revokeAllConfirmMessage')
                : t('settings.sessions.revokeConfirmMessage')}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setPending(null)}
                disabled={busy}
                data-testid="sessions-cancel-button"
              >
                {t('settings.sessions.cancel')}
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={busy}
                data-testid="sessions-confirm-button"
                onClick={() => {
                  if (pending.kind === 'all') {
                    void handleRevokeAllOthers();
                  } else if (pending.sessionId) {
                    void handleRevokeOne(pending.sessionId);
                  }
                }}
              >
                {t('settings.sessions.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
