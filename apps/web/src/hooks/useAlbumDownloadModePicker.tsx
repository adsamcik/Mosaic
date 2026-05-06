import { useCallback, useState, type JSX } from 'react';
import { DownloadModePicker } from '../components/Download/DownloadModePicker';
import { PersistencePrompt } from '../components/Download/PersistencePrompt';
import { SidecarPairingModal } from '../components/Download/SidecarPairingModal';
import { useStoragePersistence } from './useStoragePersistence';
import type { DownloadOutputMode, PhotoMeta, SidecarPeerHandle, SidecarFallbackKind } from '../workers/types';
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
  /**
   * Allow the beta "Send to my phone" sidecar option. Caller is responsible
   * for gating on `accessTier === FULL` (visitor flows MUST NOT pass this).
   * The picker further requires the `sidecar` feature flag and
   * `RTCPeerConnection` to be present in the runtime.
   */
  readonly allowSidecar?: boolean;
  /**
   * Fallback finalizer if the paired peer drops mid-job. Only meaningful
   * when {@link allowSidecar} is true. Defaults to `'zip'`.
   */
  readonly sidecarFallback?: SidecarFallbackKind;
}

interface PickerSession {
  readonly albumId: string;
  readonly suggestedFileName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  readonly hideKeepOffline: boolean;
  readonly allowSidecar: boolean;
  readonly sidecarFallback: SidecarFallbackKind;
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
  // Active when the user picked 'sidecar' on the picker; mounts the pairing modal.
  const [pairingActive, setPairingActive] = useState(false);

  const prompt = useCallback((args: PromptArgs): Promise<PickerResolution | null> => {
    return new Promise<PickerResolution | null>((resolve) => {
      setSession({
        albumId: args.albumId,
        suggestedFileName: args.suggestedFileName,
        photos: args.photos,
        hideKeepOffline: args.hideKeepOffline ?? false,
        allowSidecar: args.allowSidecar ?? false,
        sidecarFallback: args.sidecarFallback ?? 'zip',
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

  const handleSidecarChosen = useCallback((): void => {
    if (!session) return;
    // Keep the session alive (resolves once pairing succeeds or is cancelled).
    setPairingActive(true);
  }, [session]);

  const handleSidecarPaired = useCallback((peerHandle: SidecarPeerHandle, fallback: SidecarFallbackKind): void => {
    if (!session) return;
    setPairingActive(false);
    session.resolve({
      mode: { kind: 'sidecar', peerHandle, fallback },
      schedule: { kind: 'immediate' },
    });
    setSession(null);
  }, [session]);

  const handleSidecarCancel = useCallback((): void => {
    setPairingActive(false);
    if (!session) return;
    session.resolve(null);
    setSession(null);
  }, [session]);

  const handlePersistenceResolved = useCallback((): void => {
    setPersistencePromptActive(false);
  }, []);

  const pickerElement = (
    <>
      {session && !pairingActive
        ? (
            <DownloadModePicker
              open
              albumId={session.albumId}
              suggestedFileName={session.suggestedFileName}
              photos={session.photos}
              hideKeepOffline={session.hideKeepOffline}
              allowSidecar={session.allowSidecar}
              onSidecarChosen={handleSidecarChosen}
              onConfirm={handleConfirm}
              onClose={handleClose}
            />
          )
        : null}
      {session && pairingActive
        ? (
            <SidecarPairingModal
              open
              fallback={session.sidecarFallback}
              onPaired={handleSidecarPaired}
              onCancel={handleSidecarCancel}
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