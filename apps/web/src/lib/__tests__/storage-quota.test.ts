import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STORAGE_CRITICAL_THRESHOLD,
  DEFAULT_STORAGE_PRESSURE_THRESHOLD,
  formatBytes,
  isStorageCritical,
  isStorageUnderPressure,
  type StorageQuotaSnapshot,
} from '../storage-quota';

function snapshot(usage: number, quota: number): StorageQuotaSnapshot {
  return {
    supported: true,
    usageBytes: usage,
    quotaBytes: quota,
    usageRatio: quota > 0 ? usage / quota : Number.NaN,
  };
}

describe('storage-quota: isStorageUnderPressure', () => {
  it('returns false for unsupported snapshots', () => {
    const snap: StorageQuotaSnapshot = {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      usageRatio: Number.NaN,
    };
    expect(isStorageUnderPressure(snap)).toBe(false);
  });

  it('returns false when ratio is NaN', () => {
    expect(isStorageUnderPressure(snapshot(100, 0))).toBe(false);
  });

  it('returns false below the default threshold', () => {
    // 50% — well below 80%
    expect(isStorageUnderPressure(snapshot(500, 1000))).toBe(false);
  });

  it('returns false just under the default threshold', () => {
    // 79.9% — just below 80%
    expect(isStorageUnderPressure(snapshot(799, 1000))).toBe(false);
  });

  it('returns true exactly at the default threshold (inclusive)', () => {
    expect(isStorageUnderPressure(snapshot(800, 1000))).toBe(true);
  });

  it('returns true above the default threshold', () => {
    expect(isStorageUnderPressure(snapshot(950, 1000))).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isStorageUnderPressure(snapshot(500, 1000), 0.5)).toBe(true);
    expect(isStorageUnderPressure(snapshot(499, 1000), 0.5)).toBe(false);
  });

  it('clamps thresholds to [0, 1]', () => {
    // threshold > 1 clamps to 1.0; ratio < 1 must return false
    expect(isStorageUnderPressure(snapshot(999, 1000), 5)).toBe(false);
    // threshold < 0 clamps to 0; any non-negative ratio crosses
    expect(isStorageUnderPressure(snapshot(0, 1000), -1)).toBe(true);
  });

  it('default threshold constant is 0.8', () => {
    expect(DEFAULT_STORAGE_PRESSURE_THRESHOLD).toBe(0.8);
  });
});

describe('storage-quota: isStorageCritical', () => {
  it('default critical threshold is 0.95', () => {
    expect(DEFAULT_STORAGE_CRITICAL_THRESHOLD).toBe(0.95);
  });

  it('returns false at 80% (above pressure, below critical)', () => {
    expect(isStorageCritical(snapshot(800, 1000))).toBe(false);
  });

  it('returns true at 95% inclusive', () => {
    expect(isStorageCritical(snapshot(950, 1000))).toBe(true);
  });

  it('returns true at 99%', () => {
    expect(isStorageCritical(snapshot(990, 1000))).toBe(true);
  });

  it('returns false for unsupported', () => {
    const snap: StorageQuotaSnapshot = {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      usageRatio: Number.NaN,
    };
    expect(isStorageCritical(snap)).toBe(false);
  });
});

describe('storage-quota: formatBytes', () => {
  it('formats sub-kilobyte values as bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats kilobytes with one decimal for small values', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('formats large values without decimals when >= 10', () => {
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });

  it('escalates to MB / GB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('returns dash for invalid input', () => {
    expect(formatBytes(Number.NaN)).toBe('–');
    expect(formatBytes(-1)).toBe('–');
  });
});
