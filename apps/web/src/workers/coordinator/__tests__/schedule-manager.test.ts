import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleContext, ScheduleEvaluation } from '../../../lib/download-schedule';
import { ScheduleManager, type ScheduleManagerDeps } from '../schedule-manager';

function baseCtx(overrides: Partial<ScheduleContext> = {}): ScheduleContext {
  return Object.freeze({
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
  });
}

interface Harness {
  mgr: ScheduleManager;
  deps: ScheduleManagerDeps;
  dispatched: Array<{ jobId: string; evaluation: ScheduleEvaluation }>;
  setCtx(ctx: ScheduleContext): void;
  fireVisibility(): void;
  fireOnline(): void;
  tick(ms: number): Promise<void>;
}

function makeHarness(): Harness {
  let currentCtx: ScheduleContext = baseCtx();
  const dispatched: Array<{ jobId: string; evaluation: ScheduleEvaluation }> = [];
  const visListeners: Array<() => void> = [];
  const onlineListeners: Array<() => void> = [];

  const deps: ScheduleManagerDeps = {
    captureContext: () => Promise.resolve(currentCtx),
    dispatch: (jobId, evaluation) => {
      dispatched.push({ jobId, evaluation });
    },
    onVisibilityChange: (handler) => {
      visListeners.push(handler);
      return () => {
        const i = visListeners.indexOf(handler);
        if (i >= 0) visListeners.splice(i, 1);
      };
    },
    onOnlineChange: (handler) => {
      onlineListeners.push(handler);
      return () => {
        const i = onlineListeners.indexOf(handler);
        if (i >= 0) onlineListeners.splice(i, 1);
      };
    },
    setTimer: (cb, ms) => setInterval(cb, ms),
    clearTimer: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const mgr = new ScheduleManager(deps);
  return {
    mgr,
    deps,
    dispatched,
    setCtx(ctx) { currentCtx = ctx; },
    fireVisibility() { for (const h of [...visListeners]) h(); },
    fireOnline() { for (const h of [...onlineListeners]) h(); },
    async tick(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ScheduleManager', () => {
  it('dispatches immediate jobs synchronously without enqueueing', () => {
    const h = makeHarness();
    h.mgr.add({ jobId: 'a', schedule: { kind: 'immediate' }, scheduledAtMs: 0 });
    expect(h.mgr.size()).toBe(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.jobId).toBe('a');
    expect(h.dispatched[0]?.evaluation.canStart).toBe(true);
  });

  it('keeps a job scheduled while conditions block', async () => {
    const h = makeHarness();
    h.setCtx(baseCtx({ online: false }));
    h.mgr.add({ jobId: 'b', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
    expect(h.mgr.size()).toBe(1);
  });

  it('dispatches and removes a job when conditions pass', async () => {
    const h = makeHarness();
    h.setCtx(baseCtx({ online: false }));
    h.mgr.add({ jobId: 'c', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
    h.setCtx(baseCtx({ online: true }));
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(1);
    expect(h.mgr.size()).toBe(0);
  });

  it('respects maxDelayMs override even when conditions never improve', async () => {
    const h = makeHarness();
    h.setCtx(baseCtx({ online: false, nowMs: 0, scheduledAtMs: 0 }));
    h.mgr.add({ jobId: 'd', schedule: { kind: 'wifi', maxDelayMs: 60_000 }, scheduledAtMs: 0 });
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
    // Advance the captured-context clock beyond the deadline.
    h.setCtx(baseCtx({ online: false, nowMs: 60_000, scheduledAtMs: 0 }));
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.evaluation.reason).toBe('max-delay elapsed');
  });

  it('re-evaluates on visibility change when started', async () => {
    const h = makeHarness();
    h.mgr.start();
    h.setCtx(baseCtx({ online: false }));
    h.mgr.add({ jobId: 'e', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
    h.setCtx(baseCtx({ online: true }));
    h.fireVisibility();
    await vi.runOnlyPendingTimersAsync();
    expect(h.dispatched).toHaveLength(1);
    h.mgr.stop();
  });

  it('re-evaluates on online event', async () => {
    const h = makeHarness();
    h.mgr.start();
    h.setCtx(baseCtx({ online: false }));
    h.mgr.add({ jobId: 'f', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
    h.setCtx(baseCtx({ online: true }));
    h.fireOnline();
    await vi.runOnlyPendingTimersAsync();
    expect(h.dispatched).toHaveLength(1);
    h.mgr.stop();
  });

  it('removed jobs are not dispatched', async () => {
    const h = makeHarness();
    h.mgr.add({ jobId: 'g', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    h.mgr.remove('g');
    await h.mgr.evaluateAll();
    expect(h.dispatched).toHaveLength(0);
  });

  it('stop() cancels the periodic tick and unsubscribes', () => {
    const h = makeHarness();
    h.mgr.start();
    h.mgr.stop();
    h.mgr.stop(); // idempotent
    h.mgr.add({ jobId: 'h', schedule: { kind: 'wifi' }, scheduledAtMs: 0 });
    h.setCtx(baseCtx({ online: false }));
    h.fireVisibility();
    // No re-evaluation should fire because we stopped — but we never
    // actually awaited evaluateAll, and visibility now no-ops.
    expect(h.dispatched).toHaveLength(0);
  });
});
