import { useCallback, useState, type JSX } from 'react';
import { DownloadModePicker } from '../components/Download/DownloadModePicker';
import { PersistencePrompt } from '../components/Download/PersistencePrompt';
import { useStoragePersistence } from './useStoragePersistence';
import type { DownloadOutputMode, PhotoMeta } from '../workers/types';
import type { DownloadSchedule } from '../lib/download-schedule';

/** Bundle returned by the picker promise. */
export interface PickerResolution {
  readonly mode: DownloadOutputMode;
  readonly schedule: DownloadSchedule;
}

/**
 * Companion hook for {@link useAlbumDownload} / {@link useVisitorAlbumDownload}
 * that owns the imperative mode picker UI flow. Consumers render
 * `pickerElement` somewhere in the tree and call `prompt()` to open the
 * picker; the returned promise resolves with the chosen mode (or `null` when
 * the user cancels).
 *
 * Decoupling the picker from the download hook keeps it testable without
 * touching the DOM and gives consumers explicit control.
 *
 * For `keepOffline` confirmations, `pickerElement` also renders a
 * non-blocking {@link PersistencePrompt} after the picker closes. The
 * prompt asks the browser to promote OPFS storage (via
 * `navigator.storage.persist()`) so cached photos aren't evicted under
 * pressure. The download job is started by the consumer as soon as
 * `prompt()` resolves -- the persistence banner is purely informational
 * and never gates download progress.
 */
export interface UseAlbumDownloadModePickerResult {
  /** Mount this somewhere in the tree (e.g. portal). */
  readonly pickerElement: JSX.Element | null;
  /** Open the picker and resolve with the chosen mode + schedule, or null if cancelled. */
  readonly prompt: (args: PromptArgs) => Promise<PickerResolution | null>;
}

interface PromptArgs {
  readonly albumId: string;
  readonly suggestedFileName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  /**
   * Hide the "Make available offline" option for this prompt. Visitor
   * (share-link) callers must pass `true` because anonymous viewers have
   * no per-account scope key.
   */
  readonly hideKeepOffline?: boolean;
}

interface PickerSession {
  readonly albumId: string;
  readonly suggestedFileName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  readonly hideKeepOffline: boolean;
  readonly resolve: (resolution: PickerResolution | null) => void;
}

export function useAlbumDownloadModePicker(): UseAlbumDownloadModePickerResult {
  const [session, setSession] = useState<PickerSession | null>(null);
  // True only between "user picked keepOffline" and "user resolved the
  // persistence banner". The banner itself decides whether to render based
  // on the hook state (supported, persisted, dismissals) -- this flag is
  // just the single-shot trigger after a keepOffline confirmation.
  // TODO: Surface a "storage not promoted; eviction possible" notice in
  // DownloadTray when request() resolves false. Out of scope here.
  const [persistencePromptActive, setPersistencePromptActive] = useState(false);
  const persistence = useStoragePersistence();

  const prompt = useCallback((args: PromptArgs): Promise<PickerResolution | null> => {
    return new Promise<PickerResolution | null>((resolve) => {
      setSession({
        albumId: args.albumId,
        suggestedFileName: args.suggestedFileName,
        photos: args.photos,
        hideKeepOffline: args.hideKeepOffline ?? false,
        resolve,
      });
    });
  }, []);

  const handleConfirm = useCallback((mode: DownloadOutputMode, schedule: DownloadSchedule): void => {
    if (!session) return;
    // Resolve the picker promise FIRST so the caller can start the job
    // immediately. The persistence banner is rendered below in parallel
    // and never blocks job start.
    session.resolve({ mode, schedule });
    setSession(null);
    if (mode.kind === 'keepOffline') {
      setPersistencePromptActive(true);
    }
  }, [session]);

  const handleClose = useCallback((): void => {
    if (!session) return;
    session.resolve(null);
    setSession(null);
  }, [session]);

  const handlePersistenceResolved = useCallback((): void => {
    setPersistencePromptActive(false);
  }, []);

  const pickerElement = (
    <>
      {session
        ? (
            <DownloadModePicker
              open
              albumId={session.albumId}
              suggestedFileName={session.suggestedFileName}
              photos={session.photos}
              hideKeepOffline={session.hideKeepOffline}
              onConfirm={handleConfirm}
              onClose={handleClose}
            />
          )
        : null}
      <PersistencePrompt
        state={persistence}
        active={persistencePromptActive}
        onResolved={handlePersistenceResolved}
      />
    </>
  );

  return { pickerElement, prompt };
}