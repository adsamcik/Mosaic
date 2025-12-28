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
        {isUploading ? `Uploading... ${progress}%` : '📷 Upload'}
      </button>
    </>
  );
}
