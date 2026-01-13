import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUploadContext } from '../../contexts/UploadContext';

interface UploadButtonProps {
  albumId: string;
}

/**
 * Upload Button Component
 * Triggers file selection dialog with progress indicator
 */
export function UploadButton({ albumId }: UploadButtonProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading, progress } = useUploadContext();

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Upload all selected files
    for (const file of Array.from(files)) {
      await upload(file, albumId);
    }

    // Reset input
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleChange}
        style={{ display: 'none' }}
        data-testid="upload-input"
      />
      <button
        onClick={handleClick}
        disabled={isUploading}
        className={`upload-button ${isUploading ? 'upload-button--uploading' : ''}`}
        data-testid="upload-button"
        aria-busy={isUploading}
      >
        {isUploading ? (
          <span className="upload-button-content">
            <span className="upload-spinner" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
            </span>
            <span>{progress > 0 ? `${progress}%` : t('upload.uploading')}</span>
          </span>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {t('upload.button')}
          </>
        )}
      </button>
    </>
  );
}
