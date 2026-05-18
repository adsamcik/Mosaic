/**
 * Change Password Form (v1.0.x sweep38, Item 3)
 *
 * Renders a three-field password change form within Settings → Security.
 * Validates locally (min length 12, confirm match, must differ from
 * current) and dispatches to `rotatePassword()` which posts to the
 * backend rotation endpoint. On success shows a toast and resets the
 * form; on failure surfaces an inline error.
 */

import {
  useCallback,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  estimatePasswordStrength,
  PasswordRotationError,
  rotatePassword,
  type PasswordStrength,
} from '../../lib/password-rotation';

interface FormState {
  current: string;
  next: string;
  confirm: string;
}

const EMPTY: FormState = { current: '', next: '', confirm: '' };

function strengthLabelKey(s: PasswordStrength): string {
  switch (s) {
    case 'weak':
      return 'settings.password.strengthWeak';
    case 'ok':
      return 'settings.password.strengthOk';
    case 'strong':
      return 'settings.password.strengthStrong';
  }
}

export function ChangePasswordForm(): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const strength = useMemo(
    () => estimatePasswordStrength(state.next),
    [state.next],
  );

  const onChange = useCallback(
    (field: keyof FormState) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setErrorKey(null);
        setSuccess(false);
        setState((prev) => ({ ...prev, [field]: value }));
      },
    [],
  );

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErrorKey(null);
      setSuccess(false);

      if (state.next.length < 12) {
        setErrorKey('settings.password.tooShortError');
        return;
      }
      if (state.next !== state.confirm) {
        setErrorKey('settings.password.mismatchError');
        return;
      }
      if (state.next === state.current) {
        setErrorKey('settings.password.sameAsCurrentError');
        return;
      }

      setSubmitting(true);
      try {
        await rotatePassword({
          currentPassword: state.current,
          newPassword: state.next,
        });
        setSuccess(true);
        setState(EMPTY);
      } catch (err) {
        if (err instanceof PasswordRotationError) {
          if (err.reason === 'bad-current') {
            setErrorKey('settings.password.errorBadCurrent');
          } else if (err.reason === 'too-short') {
            setErrorKey('settings.password.tooShortError');
          } else {
            setErrorKey('settings.password.errorGeneric');
          }
        } else {
          setErrorKey('settings.password.errorGeneric');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [state],
  );

  return (
    <section
      className="settings-section"
      data-testid="change-password-section"
    >
      <h2 className="section-title">{t('settings.password.title')}</h2>
      <div className="settings-card">
        <p className="setting-description">
          {t('settings.password.description')}
        </p>

        {errorKey && (
          <div
            className="settings-error"
            data-testid="change-password-error"
            role="alert"
          >
            <span className="error-icon">⚠️</span>
            <span>{t(errorKey)}</span>
          </div>
        )}

        {success && (
          <div
            className="settings-toast"
            data-testid="change-password-success"
            role="status"
          >
            {t('settings.password.successToast')}
          </div>
        )}

        <form
          className="change-password-form"
          onSubmit={onSubmit}
          data-testid="change-password-form"
          noValidate
        >
          <label className="setting-row">
            <span className="setting-label">
              {t('settings.password.currentLabel')}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={state.current}
              onChange={onChange('current')}
              required
              data-testid="change-password-current"
              disabled={submitting}
            />
          </label>

          <label className="setting-row">
            <span className="setting-label">
              {t('settings.password.newLabel')}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={state.next}
              onChange={onChange('next')}
              required
              minLength={12}
              data-testid="change-password-new"
              disabled={submitting}
            />
          </label>

          {state.next.length > 0 && (
            <div
              className={`password-strength password-strength-${strength}`}
              data-testid="change-password-strength"
            >
              <span className="setting-description">
                {t('settings.password.strengthLabel')}:{' '}
                {t(strengthLabelKey(strength))}
              </span>
            </div>
          )}

          <label className="setting-row">
            <span className="setting-label">
              {t('settings.password.confirmLabel')}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={state.confirm}
              onChange={onChange('confirm')}
              required
              minLength={12}
              data-testid="change-password-confirm"
              disabled={submitting}
            />
          </label>

          <div className="setting-row">
            <button
              type="submit"
              className="button-primary"
              data-testid="change-password-submit"
              disabled={
                submitting ||
                state.current.length === 0 ||
                state.next.length < 12 ||
                state.confirm.length < 12
              }
            >
              {submitting
                ? t('settings.password.submitting')
                : t('settings.password.changeButton')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
