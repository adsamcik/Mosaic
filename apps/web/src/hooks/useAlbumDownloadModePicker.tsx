import { useCallback, useState, type JSX } from 'react';
import { DownloadModePicker } from '../components/Download/DownloadModePicker';
import type { DownloadOutputMode, PhotoMeta } from '../workers/types';

/**
 * Companion hook for {@link useAlbumDownload} that owns the imperative mode
 * picker UI flow. Consumers render `pickerElement` somewhere in the tree and
 * call `prompt()` to open the picker; the returned promise resolves with the
 * chosen mode (or `null` when the user cancels).
 *
 * Decoupling the picker from `useAlbumDownload` keeps the download hook
 * testable without touching the DOM and gives consumers explicit control.
 */
export interface UseAlbumDownloadModePickerResult {
  /** Mount this somewhere in the tree (e.g. portal). */
  readonly pickerElement: JSX.Element | null;
  /** Open the picker and resolve with the chosen mode, or null if cancelled. */
  readonly prompt: (args: PromptArgs) => Promise<DownloadOutputMode | null>;
}

interface PromptArgs {
  readonly albumId: string;
  readonly suggestedFileName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
}

interface PickerSession {
  readonly albumId: string;
  readonly suggestedFileName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  readonly resolve: (mode: DownloadOutputMode | null) => void;
}

export function useAlbumDownloadModePicker(): UseAlbumDownloadModePickerResult {
  const [session, setSession] = useState<PickerSession | null>(null);

  const prompt = useCallback((args: PromptArgs): Promise<DownloadOutputMode | null> => {
    return new Promise<DownloadOutputMode | null>((resolve) => {
      setSession({ ...args, resolve });
    });
  }, []);

  const handleConfirm = useCallback((mode: DownloadOutputMode): void => {
    if (!session) return;
    session.resolve(mode);
    setSession(null);
  }, [session]);

  const handleClose = useCallback((): void => {
    if (!session) return;
    session.resolve(null);
    setSession(null);
  }, [session]);

  const pickerElement = session
    ? (
        <DownloadModePicker
          open
          albumId={session.albumId}
          suggestedFileName={session.suggestedFileName}
          photos={session.photos}
          onConfirm={handleConfirm}
          onClose={handleClose}
        />
      )
    : null;

  return { pickerElement, prompt };
}
