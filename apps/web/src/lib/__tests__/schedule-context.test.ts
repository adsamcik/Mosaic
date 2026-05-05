import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureScheduleContext } from '../schedule-context';

interface MutableNav {
  connection?: { effectiveType?: string; saveData?: boolean };
  onLine?: boolean;
  getBattery?: () => Promise<{ level?: number; charging?: boolean }>;
}

const realNavigator = globalThis.navigator;
const realDocument = globalThis.document;

function setNav(nav: MutableNav | undefined): void {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}
function setDoc(doc: { visibilityState?: string } | undefined): void {
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: realDocument, configurable: true, writable: true });
  vi.useRealTimers();
});

describe('captureScheduleContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:30:00'));
  });

  it('reads connection + battery + visibility', async () => {
    setNav({
      connection: { effectiveType: '4g', saveData: false },
      onLine: true,
      getBattery: () => Promise.resolve({ level: 0.42, charging: true }),
    });
    setDoc({ visibilityState: 'visible' });

    const ctx = await captureScheduleContext(1000);
    expect(ctx.online).toBe(true);
    expect(ctx.effectiveType).toBe('4g');
    expect(ctx.saveData).toBe(false);
    expect(ctx.batteryLevel).toBe(0.42);
    expect(ctx.batteryCharging).toBe(true);
    expect(ctx.visibilityState).toBe('visible');
    expect(ctx.scheduledAtMs).toBe(1000);
    expect(typeof ctx.nowMs).toBe('number');
    expect(ctx.localHour).toBe(14);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('falls back gracefully when battery API is missing (Firefox)', async () => {
    setNav({
      connection: { effectiveType: '3g' },
      onLine: true,
    });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.batteryLevel).toBeNull();
    expect(ctx.batteryCharging).toBeNull();
  });

  it('treats getBattery rejection as absent', async () => {
    setNav({
      connection: { effectiveType: '4g' },
      onLine: true,
      getBattery: () => Promise.reject(new Error('SecurityError')),
    });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.batteryCharging).toBeNull();
    expect(ctx.batteryLevel).toBeNull();
  });

  it('falls back when navigator.connection is missing', async () => {
    setNav({ onLine: true });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.effectiveType).toBe('unknown');
    expect(ctx.saveData).toBe(false);
  });

  it('reports offline when navigator.onLine === false', async () => {
    setNav({ connection: { effectiveType: '4g' }, onLine: false });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.online).toBe(false);
  });

  it('defaults online=true when onLine is unknown', async () => {
    setNav({ connection: { effectiveType: '4g' } });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.online).toBe(true);
  });

  it('reports hidden visibility', async () => {
    setNav({ connection: { effectiveType: '4g' }, onLine: true });
    setDoc({ visibilityState: 'hidden' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.visibilityState).toBe('hidden');
  });

  it('clamps battery level to [0,1]', async () => {
    setNav({
      onLine: true,
      getBattery: () => Promise.resolve({ level: 1.5, charging: false }),
    });
    setDoc({ visibilityState: 'visible' });
    const ctx = await captureScheduleContext(0);
    expect(ctx.batteryLevel).toBe(1);
  });
});
