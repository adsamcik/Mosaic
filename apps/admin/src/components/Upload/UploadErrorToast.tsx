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
        <span className="upload-error-toast-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </span>
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
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  );
}
