import { useCallback } from 'react';
import { useToast } from '../contexts/ToastContext';

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

  /**
   * Show an error toast with a message
   */
  const showError = useCallback(
    (message: string, options?: { duration?: number }) => {
      return addToast({
        message,
        type: 'error',
        duration: options?.duration ?? 8000, // Errors show longer by default
      });
    },
    [addToast]
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
          const message =
            err instanceof Error ? err.message : 'An unexpected error occurred';
          showError(errorMessage ? `${errorMessage}: ${message}` : message);
          return undefined;
        }
      };
    },
    [showError]
  );

  return {
    showError,
    showSuccess,
    showWarning,
    showInfo,
    withErrorToast,
  };
}
