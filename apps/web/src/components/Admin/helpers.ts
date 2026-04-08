/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Format date to readable string */
export function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Unknown';
  }
}

/** Calculate usage percentage */
export function usagePercent(
  current: number,
  max: number | undefined,
  defaultMax: number,
): number {
  const effectiveMax = max ?? defaultMax;
  if (effectiveMax <= 0) return 0;
  return Math.min(100, Math.round((current / effectiveMax) * 100));
}

/** Convert bytes to GB for display */
export function bytesToGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

/** Convert GB to bytes */
export function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 * 1024 * 1024);
}
