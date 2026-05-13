import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

interface SectionErrorFallbackProps {
  error: Error;
  section: string;
  onReset: () => void;
}

/**
 * Error fallback for route-level ErrorBoundaries.
 * Shows which section crashed while keeping navigation functional.
 */
export function SectionErrorFallback({
  error,
  section,
  onReset,
}: SectionErrorFallbackProps) {
  const { t } = useTranslation();
  const supportRef = extractSupportReference(error);

  logger.error(`Section "${section}" crashed`, {
    error: { name: error.name, message: error.message, stack: error.stack },
  });

  return (
    <div className="section-error-fallback" style={styles.container}>
      <div style={styles.content}>
        <h2 style={styles.heading}>{t('error.somethingWentWrong')}</h2>
        <p style={styles.message}>
          {t('error.sectionCrashed', { section: t(`error.section${section}`) })}
        </p>
        {supportRef && (
          <p
            style={styles.reference}
            data-testid="section-error-support-reference"
          >
            {t('error.supportReference', { ref: supportRef })}
          </p>
        )}
        <div style={styles.actions}>
          <button onClick={onReset} style={styles.button}>
            {t('common.tryAgain')}
          </button>
        </div>
        {import.meta.env.DEV && (
          <details style={styles.details}>
            <summary style={styles.summary}>
              {t('error.technicalDetails')}
            </summary>
            <pre style={styles.pre}>
              {error.name}: {error.message}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function extractSupportReference(error: Error): string | null {
  const candidate = (error as { correlationId?: unknown }).correlationId;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return null;
  }
  return candidate.length > 8 ? candidate.slice(0, 8) : candidate;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    minHeight: '300px',
    color: 'var(--text-primary, #ffffff)',
  },
  content: {
    maxWidth: '500px',
    textAlign: 'center',
  },
  heading: {
    fontSize: '1.25rem',
    fontWeight: 600,
    marginBottom: '0.75rem',
    color: 'var(--text-primary, #ffffff)',
  },
  message: {
    fontSize: '0.95rem',
    marginBottom: '1.25rem',
    color: 'var(--text-secondary, #999999)',
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'center',
    marginBottom: '1rem',
  },
  button: {
    padding: '0.6rem 1.25rem',
    fontSize: '0.95rem',
    fontWeight: 500,
    backgroundColor: 'var(--accent-primary, #3b82f6)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.5rem',
    cursor: 'pointer',
  },
  details: {
    textAlign: 'left',
    marginTop: '1rem',
  },
  summary: {
    cursor: 'pointer',
    color: 'var(--text-secondary, #999999)',
  },
  reference: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.75rem',
    color: 'var(--text-secondary, #999999)',
    marginTop: '-0.5rem',
    marginBottom: '1rem',
    userSelect: 'all',
  },
  pre: {
    marginTop: '0.5rem',
    padding: '1rem',
    backgroundColor: 'var(--surface-secondary, #2a2a2a)',
    borderRadius: '0.5rem',
    overflow: 'auto',
    fontSize: '0.75rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
};
