import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_AFTER_MS,
  evaluateSchedule,
  isImmediate,
  type DownloadSchedule,
  type ScheduleContext,
} from '../download-schedule';

function ctx(overrides: Partial<ScheduleContext> = {}): ScheduleContext {
  return {
    online: true,
    effectiveType: '4g',
    saveData: false,
    batteryLevel: 0.8,
    batteryCharging: true,
    visibilityState: 'visible',
    nowMs: 1_000,
    localHour: 12,
    scheduledAtMs: 1_000,
    ...overrides,
  };
}

describe('evaluateSchedule — immediate', () => {
  it('always allows start', () => {
    const r = evaluateSchedule({ kind: 'immediate' }, ctx({ online: false, saveData: true }));
    expect(r.canStart).toBe(true);
    expect(r.retryAfterMs).toBeNull();
  });
});

describe('evaluateSchedule — wifi', () => {
  it('allows start on 4g without saveData', () => {
    const r = evaluateSchedule({ kind: 'wifi' }, ctx());
    expect(r.canStart).toBe(true);
  });
  it('blocks when offline', () => {
    const r = evaluateSchedule({ kind: 'wifi' }, ctx({ online: false }));
    expect(r.canStart).toBe(false);
    expect(r.reason).toBe('offline');
    expect(r.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });
  it('blocks when saveData is on', () => {
    const r = evaluateSchedule({ kind: 'wifi' }, ctx({ saveData: true }));
    expect(r.canStart).toBe(false);
    expect(r.reason).toBe('data-saver enabled');
  });
  it.each(['slow-2g', '2g'])('blocks on %s', (et) => {
    const r = evaluateSchedule({ kind: 'wifi' }, ctx({ effectiveType: et }));
    expect(r.canStart).toBe(false);
  });
  it.each(['3g', '4g', 'unknown'])('allows on %s', (et) => {
    const r = evaluateSchedule({ kind: 'wifi' }, ctx({ effectiveType: et }));
    expect(r.canStart).toBe(true);
  });
});

describe('evaluateSchedule — wifi-charging', () => {
  it('requires charging', () => {
    expect(evaluateSchedule({ kind: 'wifi-charging' }, ctx({ batteryCharging: false })).canStart).toBe(false);
    expect(evaluateSchedule({ kind: 'wifi-charging' }, ctx({ batteryCharging: true })).canStart).toBe(true);
  });
  it('falls back to wifi-only when battery API is unavailable', () => {
    const r = evaluateSchedule({ kind: 'wifi-charging' }, ctx({ batteryCharging: null, batteryLevel: null }));
    expect(r.canStart).toBe(true);
    expect(r.reason).toMatch(/battery API unavailable/);
  });
  it('blocks when wifi rule fails even if charging', () => {
    const r = evaluateSchedule({ kind: 'wifi-charging' }, ctx({ saveData: true, batteryCharging: true }));
    expect(r.canStart).toBe(false);
    expect(r.reason).toBe('data-saver enabled');
  });
});

describe('evaluateSchedule — idle', () => {
  it('starts when tab hidden', () => {
    expect(evaluateSchedule({ kind: 'idle' }, ctx({ visibilityState: 'hidden' })).canStart).toBe(true);
  });
  it('starts when idle detection active even if visible', () => {
    expect(evaluateSchedule({ kind: 'idle' }, ctx({ visibilityState: 'visible', idleStateActive: true })).canStart).toBe(true);
  });
  it('blocks when user is active', () => {
    expect(evaluateSchedule({ kind: 'idle' }, ctx({ visibilityState: 'visible', idleStateActive: false })).canStart).toBe(false);
  });
});

describe('evaluateSchedule — window', () => {
  it('allows within same-day window', () => {
    const r = evaluateSchedule({ kind: 'window', windowStartHour: 9, windowEndHour: 17 }, ctx({ localHour: 10 }));
    expect(r.canStart).toBe(true);
  });
  it('end is exclusive', () => {
    expect(evaluateSchedule({ kind: 'window', windowStartHour: 9, windowEndHour: 17 }, ctx({ localHour: 17 })).canStart).toBe(false);
    expect(evaluateSchedule({ kind: 'window', windowStartHour: 9, windowEndHour: 17 }, ctx({ localHour: 16 })).canStart).toBe(true);
  });
  it('start is inclusive', () => {
    expect(evaluateSchedule({ kind: 'window', windowStartHour: 9, windowEndHour: 17 }, ctx({ localHour: 9 })).canStart).toBe(true);
  });
  it('wraps midnight when start > end', () => {
    const sched: DownloadSchedule = { kind: 'window', windowStartHour: 22, windowEndHour: 6 };
    expect(evaluateSchedule(sched, ctx({ localHour: 23 })).canStart).toBe(true);
    expect(evaluateSchedule(sched, ctx({ localHour: 0 })).canStart).toBe(true);
    expect(evaluateSchedule(sched, ctx({ localHour: 5 })).canStart).toBe(true);
    expect(evaluateSchedule(sched, ctx({ localHour: 6 })).canStart).toBe(false);
    expect(evaluateSchedule(sched, ctx({ localHour: 12 })).canStart).toBe(false);
    expect(evaluateSchedule(sched, ctx({ localHour: 21 })).canStart).toBe(false);
  });
  it.each([
    { windowStartHour: undefined, windowEndHour: 5 },
    { windowStartHour: 5, windowEndHour: undefined },
    { windowStartHour: -1, windowEndHour: 5 },
    { windowStartHour: 5, windowEndHour: 24 },
    { windowStartHour: 1.5, windowEndHour: 5 },
  ])('rejects misconfigured window %j', (cfg) => {
    const r = evaluateSchedule({ kind: 'window', ...cfg } as DownloadSchedule, ctx());
    expect(r.canStart).toBe(false);
    expect(r.retryAfterMs).toBeNull();
  });
  it('rejects empty window (start === end)', () => {
    const r = evaluateSchedule({ kind: 'window', windowStartHour: 5, windowEndHour: 5 }, ctx({ localHour: 5 }));
    expect(r.canStart).toBe(false);
    expect(r.reason).toBe('window empty');
  });
});

describe('evaluateSchedule — maxDelayMs override', () => {
  it('forces start once the deadline elapses, even when conditions block', () => {
    const sched: DownloadSchedule = { kind: 'wifi', maxDelayMs: 60_000 };
    const blocked = ctx({ online: false, nowMs: 1_000, scheduledAtMs: 1_000 });
    expect(evaluateSchedule(sched, blocked).canStart).toBe(false);
    const elapsed = ctx({ online: false, nowMs: 1_000 + 60_000, scheduledAtMs: 1_000 });
    const r = evaluateSchedule(sched, elapsed);
    expect(r.canStart).toBe(true);
    expect(r.reason).toBe('max-delay elapsed');
  });
  it('ignores zero or negative maxDelayMs', () => {
    const sched: DownloadSchedule = { kind: 'wifi', maxDelayMs: 0 };
    const r = evaluateSchedule(sched, ctx({ online: false, nowMs: 1_000_000, scheduledAtMs: 0 }));
    expect(r.canStart).toBe(false);
  });
  it('still works for window schedules', () => {
    const sched: DownloadSchedule = { kind: 'window', windowStartHour: 1, windowEndHour: 2, maxDelayMs: 10 };
    const c = ctx({ localHour: 12, nowMs: 100, scheduledAtMs: 50 });
    expect(evaluateSchedule(sched, c).canStart).toBe(true);
  });
});

describe('isImmediate', () => {
  it('returns true only for immediate', () => {
    expect(isImmediate({ kind: 'immediate' })).toBe(true);
    expect(isImmediate({ kind: 'wifi' })).toBe(false);
  });
});
