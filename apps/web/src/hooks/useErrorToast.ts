import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { ApiError } from '../lib/api';
import { toSafeErrorMessage } from '../lib/error-messages';

function getCorrelationId(error: unknown): string | undefined {
  return error instanceof ApiError && error.correlationId
    ? error.correlationId
    : undefined;
}

/**
 * Hook for easy error handling with toast notifications.
 * Provides convenience methods for showing error toasts and wrapping async operations.
 * 
 * @example
 * ```tsx
 * const { showError, withErrorToast } = useErrorToast();
 * 
 * // Show an error directly
 * showError('Something went wrong');
 * 
 * // Wrap an async function to automatically show errors
 * const handleSubmit = withErrorToast(async () => {
 *   await api.saveData(data);
 * }, 'Failed to save data');
 * ```
 */
export function useErrorToast() {
  const { addToast } = useToast();
  const { t } = useTranslation();

  const formatErrorMessage = useCallback(
    (error: unknown, fallback?: string): string => {
      const message =
        typeof error === 'string'
          ? error
          : toSafeErrorMessage(error, fallback);
      const correlationId = getCorrelationId(error);
      if (!correlationId) {
        return message;
      }

      return `${message} (${t('error.referenceId', {
        id: correlationId,
        defaultValue: 'Reference: {{id}}',
      })})`;
    },
    [t],
  );

  /**
   * Show an error toast with a message
   */
  const showError = useCallback(
    (error: unknown, options?: { duration?: number; fallback?: string }) => {
      return addToast({
        message: formatErrorMessage(error, options?.fallback),
        type: 'error',
        duration: options?.duration ?? 8000, // Errors show longer by default
      });
    },
    [addToast, formatErrorMessage],
  );

  /**
   * Show a success toast with a message
   */
  const showSuccess = useCallback(
    (message: string, options?: { duration?: number }) => {
      return addToast({
        message,
        type: 'success',
        duration: options?.duration ?? 4000,
      });
    },
    [addToast]
  );

  /**
   * Show a warning toast with a message
   */
  const showWarning = useCallback(
    (message: string, options?: { duration?: number }) => {
      return addToast({
        message,
        type: 'warning',
        duration: options?.duration ?? 6000,
      });
    },
    [addToast]
  );

  /**
   * Show an info toast with a message
   */
  const showInfo = useCallback(
    (message: string, options?: { duration?: number }) => {
      return addToast({
        message,
        type: 'info',
        duration: options?.duration ?? 5000,
      });
    },
    [addToast]
  );

  /**
   * Wrap an async function to automatically show an error toast on failure.
   * Returns a new function with the same signature that catches errors.
   * 
   * @param fn - The async function to wrap
   * @param errorMessage - Optional custom error message prefix
   */
  const withErrorToast = useCallback(
    <T extends unknown[], R>(
      fn: (...args: T) => Promise<R>,
      errorMessage?: string
    ): ((...args: T) => Promise<R | undefined>) => {
      return async (...args: T): Promise<R | undefined> => {
        try {
          return await fn(...args);
        } catch (err) {
          const message = formatErrorMessage(
            err,
            'An unexpected error occurred',
          );
          showError(errorMessage ? `${errorMessage}: ${message}` : err);
          return undefined;
        }
      };
    },
    [formatErrorMessage, showError],
  );

  return {
    showError,
    showSuccess,
    showWarning,
    showInfo,
    withErrorToast,
  };
}
