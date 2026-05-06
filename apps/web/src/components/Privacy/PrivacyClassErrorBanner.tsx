import { useEffect } from 'react';
import { createLogger } from '../../lib/logger';

const log = createLogger('PrivacyClassErrorBanner');
const FORBIDDEN_TAG_MESSAGE =
  'This photo contains an unsupported metadata field. Please remove the tag and re-upload.';

export class ForbiddenTagError extends Error {
  readonly name = 'ForbiddenTagError';
  readonly canonicalFieldName: string;

  constructor(canonicalFieldName: string, message = FORBIDDEN_TAG_MESSAGE) {
    super(message);
    this.canonicalFieldName = canonicalizeFieldName(canonicalFieldName);
  }
}

export interface PrivacyClassErrorBannerProps {
  readonly error: unknown;
  readonly onDismiss?: () => void;
}

export function canonicalizeFieldName(fieldName: string): string {
  return fieldName.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-');
}

export function isForbiddenTagError(error: unknown): error is ForbiddenTagError {
  return (
    error instanceof ForbiddenTagError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name: unknown }).name === 'ForbiddenTagError' &&
      'canonicalFieldName' in error &&
      typeof (error as { canonicalFieldName: unknown }).canonicalFieldName ===
        'string')
  );
}

export function PrivacyClassErrorBanner({
  error,
  onDismiss,
}: PrivacyClassErrorBannerProps) {
  const canonicalFieldName = isForbiddenTagError(error)
    ? canonicalizeFieldName(error.canonicalFieldName)
    : null;

  useEffect(() => {
    if (!canonicalFieldName) return;
    log.warn('Forbidden metadata tag rejected by sidecar decoder', {
      canonicalFieldName,
    });
  }, [canonicalFieldName]);

  if (!canonicalFieldName) {
    return null;
  }

  return (
    <section
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Unsupported metadata field</h2>
          <p className="mt-1 text-sm">{FORBIDDEN_TAG_MESSAGE}</p>
          <p className="mt-2 text-xs opacity-80">
            Support reference: <code>{canonicalFieldName}</code>
          </p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-sm font-medium hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:hover:bg-amber-900"
            aria-label="Dismiss metadata warning"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </section>
  );
}
