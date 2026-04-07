import { useCallback, useRef, useState } from 'react';
import { downloadAlbumAsZip, supportsFileSystemAccess, type AlbumDownloadProgress } from '../lib/album-download-service';
import { createLogger } from '../lib/logger';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('useAlbumDownload');

export interface UseAlbumDownloadResult {
  /** Whether a download is currently in progress */
  isDownloading: boolean;
  /** Current download progress */
  progress: AlbumDownloadProgress | null;
  /** Error from last download attempt */
  error: Error | null;
  /** Start downloading photos as a ZIP */
  startDownload: (albumId: string, albumName: string, photos: PhotoMeta[]) => Promise<void>;
  /** Cancel the current download */
  cancel: () => void;
  /** Whether the browser supports streaming downloads (File System Access API) */
  supportsStreaming: boolean;
}

export function useAlbumDownload(): UseAlbumDownloadResult {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<AlbumDownloadProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const startDownload = useCallback(async (albumId: string, albumName: string, photos: PhotoMeta[]) => {
    if (isDownloading) return;

    setIsDownloading(true);
    setError(null);
    setProgress(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      await downloadAlbumAsZip({
        albumId,
        albumName,
        photos,
        onProgress: setProgress,
        signal: abortController.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info('Download cancelled by user');
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Album download failed:', error);
      setError(error);
    } finally {
      setIsDownloading(false);
      abortControllerRef.current = null;
    }
  }, [isDownloading]);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  return {
    isDownloading,
    progress,
    error,
    startDownload,
    cancel,
    supportsStreaming: typeof window !== 'undefined' && supportsFileSystemAccess(),
  };
}
