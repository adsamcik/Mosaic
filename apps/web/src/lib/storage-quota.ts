/**
 * Storage quota helpers (v1.0.2 storage-pressure-ui).
 *
 * Thin wrapper around the StorageManager.estimate() API that exposes a
 * normalised view of usage / quota plus threshold helpers. Kept separate
 * from the React hook so threshold logic is independently unit-testable.
 *
 * ZK-safety note: usage estimates are not key material or photo content,
 * but they are still derived from the user's local device and never sent
 * to the server. Callers must not include raw byte counts in error reports
 * or telemetry — log only the ratio bucket (e.g. "above-threshold").
 */

/** Default pressure threshold: warn at 80% of quota. */
export const DEFAULT_STORAGE_PRESSURE_THRESHOLD = 0.8;

/** Critical pressure threshold: 95% — eviction is imminent. */
export const DEFAULT_STORAGE_CRITICAL_THRESHOLD = 0.95;

/** Normalised snapshot of storage usage. */
export interface StorageQuotaSnapshot {
  /** Whether navigator.storage.estimate is available in this environment. */
  readonly supported: boolean;
  /** Raw usage bytes reported by the browser (0 when unsupported). */
  readonly usageBytes: number;
  /** Raw quota bytes reported by the browser (0 when unsupported). */
  readonly quotaBytes: number;
  /**
   * Fraction of quota in use, in [0, 1]. NaN when quota is 0 or unsupported.
   * Use {@link isStorageUnderPressure} rather than reading this directly.
   */
  readonly usageRatio: number;
}

interface StorageManagerLike {
  readonly estimate?: () => Promise<StorageEstimate>;
}

function getStorageManager(): StorageManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const storage = (navigator as Navigator & { storage?: StorageManagerLike }).storage;
  if (!storage || typeof storage.estimate !== 'function') return undefined;
  return storage;
}

/** Returns true when the StorageManager.estimate() API is available. */
export function isStorageQuotaSupported(): boolean {
  return getStorageManager() !== undefined;
}

/**
 * Probe `navigator.storage.estimate()` and return a normalised snapshot.
 * Never throws; on error or unsupported environments returns a snapshot
 * with `supported = false`.
 */
export async function readStorageQuota(): Promise<StorageQuotaSnapshot> {
  const storage = getStorageManager();
  if (!storage) {
    return {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      usageRatio: Number.NaN,
    };
  }
  try {
    const estimate = await storage.estimate!();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
    const ratio = quota > 0 ? usage / quota : Number.NaN;
    return {
      supported: true,
      usageBytes: usage,
      quotaBytes: quota,
      usageRatio: ratio,
    };
  } catch {
    return {
      supported: true,
      usageBytes: 0,
      quotaBytes: 0,
      usageRatio: Number.NaN,
    };
  }
}

/**
 * Whether the snapshot crosses the supplied pressure threshold.
 *
 * Returns `false` for unsupported / NaN ratios — we never want to alarm
 * users on browsers that don't surface a quota. The caller is expected
 * to supply a finite threshold in (0, 1]; values outside that range are
 * clamped.
 */
export function isStorageUnderPressure(
  snapshot: StorageQuotaSnapshot,
  threshold: number = DEFAULT_STORAGE_PRESSURE_THRESHOLD,
): boolean {
  if (!snapshot.supported) return false;
  if (!Number.isFinite(snapshot.usageRatio)) return false;
  const clamped = Math.min(Math.max(threshold, 0), 1);
  return snapshot.usageRatio >= clamped;
}

/** Whether the snapshot crosses the critical threshold (default 95%). */
export function isStorageCritical(
  snapshot: StorageQuotaSnapshot,
  threshold: number = DEFAULT_STORAGE_CRITICAL_THRESHOLD,
): boolean {
  return isStorageUnderPressure(snapshot, threshold);
}

/** Format a byte count for human display (1024-based). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
