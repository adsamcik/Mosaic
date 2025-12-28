import { useEffect } from 'react';
import { useUploadContext } from '../../contexts/UploadContext';

/**
 * Upload Error Toast Component
 * Displays upload errors as a dismissable notification.
 */
export function UploadErrorToast() {
  const { error, clearError } = useUploadContext();

  // Auto-dismiss after 10 seconds
  useEffect(() => {
    if (!error) return;

    const timer = setTimeout(() => {
      clearError();
    }, 10000);

    return () => clearTimeout(timer);
  }, [error, clearError]);

  if (!error) return null;

  return (
    <div 
      className="upload-error-toast" 
      data-testid="upload-error-toast"
      role="alert"
      aria-live="assertive"
    >
      <div className="upload-error-toast-content">
        <span className="upload-error-toast-icon">⚠️</span>
        <div className="upload-error-toast-message">
          <strong>Upload failed</strong>
          <p>{error.message}</p>
        </div>
        <button
          className="upload-error-toast-close"
          onClick={clearError}
          aria-label="Dismiss error"
          data-testid="upload-error-dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
