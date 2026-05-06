import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useVisitorDownloadDisclosure } from '../../hooks/useVisitorDownloadDisclosure';
import { Dialog } from './Dialog';

/** Props for {@link VisitorDownloadDisclosure}. */
export interface VisitorDownloadDisclosureProps {
  /**
   * Visitor scope key (isitor:<hex16>) the disclosure is gating. The
   * acknowledgement is persisted against this key, so two different share
   * links never share consent.
   */
  readonly scopeKey: string;
  /**
   * Called after the user clicks "I understand". The persisted
   * acknowledgement is written **before** this callback fires, so the
   * caller can re-check the hook synchronously and proceed.
   */
  readonly onAcknowledge: () => void;
  /** Called when the user dismisses the dialog without acknowledging. */
  readonly onCancel: () => void;
}

/**
 * Pre-OPFS storage disclosure shown to anonymous share-link visitors before
 * a download starts. Explains that decrypted photos are temporarily staged
 * in this device's browser storage and that on shared devices anyone using
 * the same browser profile could potentially access the staging area until
 * the download completes.
 *
 * The component renders nothing if the disclosure has already been
 * acknowledged for {@link VisitorDownloadDisclosureProps.scopeKey} — but
 * callers should normally not mount it in that case anyway.
 */
export function VisitorDownloadDisclosure(
  props: VisitorDownloadDisclosureProps,
): JSX.Element | null {
  const { t } = useTranslation();
  const { acknowledged, acknowledge } = useVisitorDownloadDisclosure(props.scopeKey);

  if (acknowledged) return null;

  const handleAcknowledge = (): void => {
    acknowledge();
    props.onAcknowledge();
  };

  return (
    <Dialog
      isOpen
      onClose={props.onCancel}
      title={t('download.visitorDisclosure.title')}
      testId="visitor-download-disclosure"
      closeOnBackdropClick={false}
      footer={
        <>
          <button
            type="button"
            className="button-secondary"
            onClick={props.onCancel}
            data-testid="visitor-download-disclosure-cancel"
          >
            {t('download.visitorDisclosure.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={handleAcknowledge}
            data-testid="visitor-download-disclosure-acknowledge"
          >
            {t('download.visitorDisclosure.acknowledge')}
          </button>
        </>
      }
    >
      <p>{t('download.visitorDisclosure.body1')}</p>
      <p>{t('download.visitorDisclosure.body2')}</p>
      <p>{t('download.visitorDisclosure.body3')}</p>
    </Dialog>
  );
}
