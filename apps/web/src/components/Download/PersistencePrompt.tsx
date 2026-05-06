import { useTranslation } from 'react-i18next';
import { type JSX } from 'react';
import type { StoragePersistenceState } from '../../hooks/useStoragePersistence';

/** Props for {@link PersistencePrompt}. */
export interface PersistencePromptProps {
  /** Hook state passed in (so the parent can share a single instance). */
  readonly state: StoragePersistenceState;
  /**
   * Whether the parent flow is in a state where the prompt is relevant
   * (typically: user just selected `keepOffline`). When `false` the prompt
   * never renders, regardless of state.
   */
  readonly active: boolean;
  /**
   * Optional callback fired after the user resolves the prompt (Allow,
   * Not now, or Don't ask again). The parent can use this to dismount the
   * banner. Job lifecycle is independent: the prompt never blocks a download.
   */
  readonly onResolved?: (outcome: PersistencePromptOutcome) => void;
}

export type PersistencePromptOutcome = 'allowed' | 'denied' | 'dismissed' | 'dismissedForever';

/**
 * Non-blocking informational banner shown after the user picks the
 * "Keep offline" download mode. Asks the browser to promote OPFS storage so
 * decrypted photos aren't evicted under storage pressure.
 *
 * The component is purely presentational: visibility logic is owned here
 * (so the picker hook stays small) but never blocks the download job. The
 * caller is expected to have already started the job before mounting this.
 */
export function PersistencePrompt(props: PersistencePromptProps): JSX.Element | null {
  const { t } = useTranslation();
  const { state, active } = props;

  const shouldShow =
    active &&
    state.supported &&
    state.persisted === false &&
    !state.dismissedThisSession &&
    !state.dismissedForever;

  if (!shouldShow) return null;

  const handleAllow = async (): Promise<void> => {
    const granted = await state.request();
    props.onResolved?.(granted ? 'allowed' : 'denied');
  };

  const handleDismiss = (): void => {
    state.dismiss();
    props.onResolved?.('dismissed');
  };

  const handleDismissForever = (): void => {
    state.dismissForever();
    props.onResolved?.('dismissedForever');
  };

  return (
    <div
      className="persistence-prompt"
      role="dialog"
      aria-modal="false"
      aria-labelledby="persistence-prompt-title"
      data-testid="persistence-prompt"
    >
      <h3 id="persistence-prompt-title" className="persistence-prompt-title">
        {t('download.persistencePrompt.title')}
      </h3>
      <p className="persistence-prompt-body">
        {t('download.persistencePrompt.body')}
      </p>
      <div className="persistence-prompt-actions">
        <button
          type="button"
          className="persistence-prompt-button persistence-prompt-button--primary"
          onClick={(): void => { void handleAllow(); }}
          data-testid="persistence-prompt-allow"
        >
          {t('download.persistencePrompt.allow')}
        </button>
        <button
          type="button"
          className="persistence-prompt-button"
          onClick={handleDismiss}
          data-testid="persistence-prompt-dismiss"
        >
          {t('download.persistencePrompt.notNow')}
        </button>
      </div>
      <button
        type="button"
        className="persistence-prompt-link"
        onClick={handleDismissForever}
        data-testid="persistence-prompt-never"
      >
        {t('download.persistencePrompt.neverAsk')}
      </button>
    </div>
  );
}