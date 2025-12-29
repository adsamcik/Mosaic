import { useRef } from 'react';
import { useUploadContext } from '../../contexts/UploadContext';

interface UploadButtonProps {
  albumId: string;
}

/**
 * Upload Button Component
 * Triggers file selection dialog
 */
export function UploadButton({ albumId }: UploadButtonProps) {
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
        className="upload-button"
        data-testid="upload-button"
        aria-busy={isUploading}
      >
        {isUploading ? (
          `Uploading... ${progress}%`
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload
          </>
        )}
      </button>
    </>
  );
}
