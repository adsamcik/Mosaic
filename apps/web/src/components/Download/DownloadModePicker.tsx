import { useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { DownloadOutputMode, PerFileStrategy } from '../../workers/types';
import type { PhotoMeta } from '../../workers/types';
import { BLOB_ANCHOR_PHOTO_LIMIT, detectPerFileStrategy, supportsStreamingSave } from '../../lib/save-target';

const LAST_MODE_STORAGE_KEY = 'mosaic.download.lastMode';

/** Discriminator for the mode picker's three radio options. */
type PickerKind = 'zip' | 'keepOffline' | 'perFile';

/** Props for {@link DownloadModePicker}. */
export interface DownloadModePickerProps {
  /** When true, the picker is mounted and visible. */
  readonly open: boolean;
  /** Album id (for telemetry / analytics scoping; not displayed). */
  readonly albumId: string;
  /** Suggested base archive filename (without `.zip`). */
  readonly suggestedFileName: string;
  /** Photos to download; used for the size-estimate row. */
  readonly photos: ReadonlyArray<PhotoMeta>;
  /** Called when the user dismisses the picker without picking. */
  readonly onClose: () => void;
  /** Called with the chosen mode when the user clicks "Start download". */
  readonly onConfirm: (mode: DownloadOutputMode) => void | Promise<void>;
  /**
   * Hide the "Make available offline" option. Used by visitor (share-link)
   * flows where there is no per-account scope key to bind OPFS staging to.
   */
  readonly hideKeepOffline?: boolean;
}

/**
 * Bottom-sheet (mobile) / centered dialog (desktop) that lets the user choose
 * how to receive a downloaded album. Three options, two enabled today:
 *
 * - **Save as ZIP**             one .zip file via the streaming finalizer
 * - **Make available offline**  no file emitted; bytes stay in OPFS
 * - **Save individual files**   one file per photo, strategy-selected per browser
 */
export function DownloadModePicker(props: DownloadModePickerProps): JSX.Element | null {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<PickerKind>(() => loadLastMode());

  const translate = (key: string, opts?: Record<string, unknown>): string => (opts === undefined ? t(key) : t(key, opts));
  const isMobile = useIsMobile();
  const sizeEstimate = useMemo(() => estimateSize(props.photos), [props.photos]);
  const perFileStrategy = detectPerFileStrategy();
  const perFileRefusal = perFileStrategy === 'blobAnchor' && props.photos.length > BLOB_ANCHOR_PHOTO_LIMIT
    ? t('download.modePicker.perFileBlobAnchorRefusal', { count: props.photos.length })
    : null;
  const perFileDisabled = perFileStrategy === null;
  const perFileSub = getPerFileSubLabel(translate, perFileStrategy, props.photos.length);

  useEffect(() => {
    if (!props.open) return;
    const last = loadLastMode(perFileStrategy === 'fsAccessDirectory');
    setSelected(last === 'keepOffline' && props.hideKeepOffline === true ? 'zip' : last);
  }, [props.open, perFileStrategy, props.hideKeepOffline]);

  if (!props.open) return null;

  const handleConfirm = async (): Promise<void> => {
    if (selected === 'perFile') {
      if (perFileStrategy === null || perFileRefusal !== null) return;
      persistLastMode(selected);
      await props.onConfirm({ kind: 'perFile', strategy: perFileStrategy });
      return;
    }
    persistLastMode(selected);
    const mode: DownloadOutputMode = selected === 'zip'
      ? { kind: 'zip', fileName: ensureZipExtension(props.suggestedFileName) }
      : { kind: 'keepOffline' };
    await props.onConfirm(mode);
  };

  const className = `download-mode-picker download-mode-picker--${isMobile ? 'sheet' : 'dialog'}`;

  return (
    <div className="download-mode-picker-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-mode-picker-title"
        onClick={(event): void => event.stopPropagation()}
      >
        <h2 id="download-mode-picker-title" className="download-mode-picker-title">
          {t('download.modePicker.title')}
        </h2>
        <p className="download-mode-picker-subtitle">
          {t('download.modePicker.subtitle', {
            count: props.photos.length,
            size: sizeEstimate.label === null
              ? t('download.modePicker.sizeUnknown')
              : sizeEstimate.label,
          })}
        </p>
        <fieldset className="download-mode-picker-options">
          <legend className="visually-hidden">{t('download.modePicker.title')}</legend>
          <ModeOption
            kind="zip"
            selected={selected}
            onSelect={setSelected}
            label={t('download.modePicker.zip.label')}
            sub={t('download.modePicker.zip.sub')}
          />
          {props.hideKeepOffline === true ? null : (
            <ModeOption
              kind="keepOffline"
              selected={selected}
              onSelect={setSelected}
              label={t('download.modePicker.keepOffline.label')}
              sub={t('download.modePicker.keepOffline.sub')}
            />
          )}
          <ModeOption
            kind="perFile"
            selected={selected}
            onSelect={setSelected}
            label={perFileStrategy === null ? t('download.modePicker.perFile.label') : getPerFileLabel(translate, perFileStrategy, props.photos.length)}
            sub={perFileSub}
            disabled={perFileDisabled}
          />
        </fieldset>
        {selected === 'perFile' && perFileRefusal !== null ? (
          <p className="download-mode-picker-status" role="alert">{perFileRefusal}</p>
        ) : null}
        {/* Directory picking stays in the save-target bridge so the finalizer owns the handle; this is the static pre-pick disclosure. */}
        {selected === 'perFile' && perFileStrategy === 'fsAccessDirectory' ? (
          <p className="download-mode-picker-status">{t('download.modePicker.perFileDirectoryDisclosure')}</p>
        ) : null}
        <StatusRow />
        <div className="download-mode-picker-actions">
          <button type="button" className="download-mode-picker-button" onClick={props.onClose}>
            {t('download.modePicker.cancel')}
          </button>
          <button
            type="button"
            className="download-mode-picker-button download-mode-picker-button--primary"
            onClick={(): void => { void handleConfirm(); }}
            disabled={selected === 'perFile' && (perFileDisabled || perFileRefusal !== null)}
            data-testid="download-mode-picker-start"
          >
            {t('download.modePicker.start')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ModeOptionProps {
  readonly kind: PickerKind;
  readonly selected: PickerKind;
  readonly onSelect: (kind: PickerKind) => void;
  readonly label: string;
  readonly sub: string;
  readonly disabled?: boolean;
}

function ModeOption(p: ModeOptionProps): JSX.Element {
  const id = `download-mode-${p.kind}`;
  return (
    <label className={`download-mode-option ${p.disabled ? 'download-mode-option--disabled' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="radio"
        name="download-mode"
        value={p.kind}
        checked={p.selected === p.kind}
        onChange={(): void => p.onSelect(p.kind)}
        disabled={p.disabled === true}
        data-testid={`download-mode-radio-${p.kind}`}
      />
      <span className="download-mode-option-text">
        <span className="download-mode-option-label">{p.label}</span>
        <span className="download-mode-option-sub">{p.sub}</span>
      </span>
    </label>
  );
}

function getPerFileLabel(t: (key: string, opts?: Record<string, unknown>) => string, strategy: PerFileStrategy, count: number): string {
  switch (strategy) {
    case 'webShare':
      return t('download.modePicker.perFileWebShare');
    case 'fsAccessDirectory':
      return t('download.modePicker.perFile.label');
    case 'fsAccessPerFile':
      return t('download.modePicker.perFileFsAccess', { count });
    case 'blobAnchor':
      return t('download.modePicker.perFileBlobAnchor');
    default: {
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }
}

function getPerFileSubLabel(t: (key: string, opts?: Record<string, unknown>) => string, strategy: PerFileStrategy | null, count: number): string {
  if (strategy === null) {
    return t('download.modePicker.perFileNotSupported');
  }
  if (strategy === 'webShare') {
    return t('download.modePicker.perFilePromptCountOne');
  }
  if (strategy === 'fsAccessDirectory') {
    return t('download.modePicker.perFileDirectory');
  }
  return t('download.modePicker.perFilePromptCountMany', { count });
}

function StatusRow(): JSX.Element | null {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<string | null>(null);
  const [battery, setBattery] = useState<string | null>(null);
  const streamingHint = supportsStreamingSave()
    ? t('download.modePicker.statusStreaming')
    : t('download.modePicker.statusFallback');

  useEffect(() => {
    const nav = navigator as unknown as { connection?: { effectiveType?: string; type?: string } };
    if (nav.connection) {
      const label = nav.connection.type ?? nav.connection.effectiveType ?? null;
      setConnection(label);
    }
    type BatteryManager = { level: number };
    const navWithBattery = navigator as unknown as { getBattery?: () => Promise<BatteryManager> };
    if (typeof navWithBattery.getBattery === 'function') {
      navWithBattery.getBattery().then((b) => {
        setBattery(`${Math.round(b.level * 100)}%`);
      }).catch(() => undefined);
    }
  }, []);

  return (
    <p className="download-mode-picker-status">
      {streamingHint}
      {connection !== null ? ` · ${t('download.modePicker.connection', { type: connection })}` : null}
      {battery !== null ? ` · ${t('download.modePicker.battery', { level: battery })}` : null}
    </p>
  );
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia('(max-width: 768px)');
    const handler = (event: MediaQueryListEvent): void => setIsMobile(event.matches);
    mql.addEventListener('change', handler);
    return (): void => mql.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

function loadLastMode(preferPerFileDirectory = false): PickerKind {
  if (typeof window === 'undefined') return 'zip';
  try {
    const raw = window.localStorage.getItem(LAST_MODE_STORAGE_KEY);
    if (raw === 'zip' || raw === 'keepOffline' || raw === 'perFile') return raw;
  } catch {
    // ignore
  }
  return preferPerFileDirectory ? 'perFile' : 'zip';
}

function persistLastMode(kind: PickerKind): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_MODE_STORAGE_KEY, kind);
  } catch {
    // ignore quota/privacy errors
  }
}

function ensureZipExtension(name: string): string {
  return name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`;
}

interface SizeEstimate {
  readonly bytes: number;
  readonly label: string | null;
}

function estimateSize(_photos: ReadonlyArray<PhotoMeta>): SizeEstimate {
  // PhotoMeta does not currently carry a single declared size; we only have
  // shard-level declared sizes in the plan. As a conservative MVP, return
  // null when we cannot confidently estimate, so the UI shows "size unknown".
  return { bytes: 0, label: null };
}
