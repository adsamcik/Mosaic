/**
 * Conditional download scheduling — pure evaluation logic.
 *
 * The schedule says *when* a download is allowed to start. It does not
 * touch browser APIs directly; instead {@link evaluateSchedule} consumes a
 * pre-captured {@link ScheduleContext} (see `schedule-context.ts`).
 *
 * ZK-safe: reasons returned are short, generic strings ("waiting for Wi-Fi",
 * "battery API unavailable, falling back"). They never contain job IDs,
 * album IDs, scope keys, or any other secret-adjacent value. Safe to log.
 *
 * Defense-in-depth: structurally invalid `window` schedules are released
 * instead of refused. Refusing an invalid, content-stable window without a
 * max-delay would brick the job across every future evaluation.
 */

export type ScheduleKind =
  | 'immediate'
  | 'wifi'
  | 'wifi-charging'
  | 'idle'
  | 'window';

export interface DownloadSchedule {
  /** Schedule kind. */
  readonly kind: ScheduleKind;
  /** For 'window': earliest start hour (0-23, local time). */
  readonly windowStartHour?: number;
  /** For 'window': latest start hour (0-23, local time). End-exclusive. */
  readonly windowEndHour?: number;
  /**
   * Maximum delay before forcing a start. After this, the schedule expires
   * and the job runs anyway. Measured against `scheduledAtMs`.
   */
  readonly maxDelayMs?: number;
}

export interface ScheduleContext {
  readonly online: boolean;
  /** Network Information API: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown'. */
  readonly effectiveType: string;
  readonly saveData: boolean;
  /** Battery level 0..1, or `null` when API unavailable. */
  readonly batteryLevel: number | null;
  /** `true` when charging, `false` when discharging, `null` when API unavailable. */
  readonly batteryCharging: boolean | null;
  readonly visibilityState: 'visible' | 'hidden';
  /** Whether the platform has signalled an idle state (Idle Detection API). */
  readonly idleStateActive?: boolean;
  readonly nowMs: number;
  /** Local-time hour 0..23. */
  readonly localHour: number;
  /** Wallclock at which the schedule was registered. */
  readonly scheduledAtMs: number;
}

export interface ScheduleEvaluation {
  readonly canStart: boolean;
  /** Why the schedule says no (or yes). Human-readable; safe to log. */
  readonly reason: string;
  /** Suggested re-evaluation delay (ms). `null` when re-evaluation should be event-driven. */
  readonly retryAfterMs: number | null;
}

/** Default re-evaluation interval when no specific signal is awaited. */
export const DEFAULT_RETRY_AFTER_MS = 30_000;

/** Minimum sane window hour. */
const MIN_HOUR = 0;
/** Maximum sane window hour (exclusive end allowed up to 24). */
const MAX_HOUR_INCLUSIVE = 23;

/** A `ScheduleEvaluation` indicating an immediate "go". */
function go(reason: string): ScheduleEvaluation {
  return { canStart: true, reason, retryAfterMs: null };
}

/** A `ScheduleEvaluation` indicating "not yet". */
function wait(reason: string, retryAfterMs: number | null = DEFAULT_RETRY_AFTER_MS): ScheduleEvaluation {
  return { canStart: false, reason, retryAfterMs };
}

/** Returns true when the network looks "Wi-Fi-ish" (fast + not user-restricted). */
function isWifiLike(ctx: ScheduleContext): boolean {
  if (!ctx.online) return false;
  if (ctx.saveData) return false;
  // The browser doesn't report Wi-Fi vs cellular. effectiveType is the
  // best proxy: slow-2g/2g almost always means cellular or a captive
  // portal we shouldn't burn data on. 'unknown' is treated as Wi-Fi-like
  // because Firefox doesn't expose the API at all and we don't want to
  // strand desktop users behind a permanent gate.
  return ctx.effectiveType !== 'slow-2g' && ctx.effectiveType !== '2g';
}

/**
 * Return `null` if the max-delay override has not fired, otherwise a
 * "max-delay elapsed" evaluation that always allows start.
 */
function maxDelayOverride(
  schedule: DownloadSchedule,
  ctx: ScheduleContext,
): ScheduleEvaluation | null {
  if (schedule.maxDelayMs === undefined) return null;
  if (schedule.maxDelayMs <= 0) return null;
  const elapsed = ctx.nowMs - ctx.scheduledAtMs;
  if (elapsed >= schedule.maxDelayMs) {
    return go('max-delay elapsed');
  }
  return null;
}

function evaluateImmediate(): ScheduleEvaluation {
  return go('immediate');
}

function evaluateWifi(ctx: ScheduleContext): ScheduleEvaluation {
  if (!ctx.online) return wait('offline');
  if (ctx.saveData) return wait('data-saver enabled');
  if (ctx.effectiveType === 'slow-2g' || ctx.effectiveType === '2g') {
    return wait('connection too slow');
  }
  return go('connection OK');
}

function evaluateWifiCharging(ctx: ScheduleContext): ScheduleEvaluation {
  const wifi = evaluateWifi(ctx);
  if (!wifi.canStart) return wifi;
  if (ctx.batteryCharging === null) {
    // Battery API unavailable (e.g. Firefox). Per spec, fall back to wifi.
    return go('connection OK (battery API unavailable)');
  }
  if (!ctx.batteryCharging) {
    return wait('not charging');
  }
  return go('connection OK and charging');
}

function evaluateIdle(ctx: ScheduleContext): ScheduleEvaluation {
  if (ctx.idleStateActive === true) return go('idle');
  if (ctx.visibilityState === 'hidden') return go('tab hidden');
  return wait('user active');
}

function isWindowHourValid(hour: number): boolean {
  return Number.isInteger(hour) && hour >= MIN_HOUR && hour <= MAX_HOUR_INCLUSIVE;
}

function evaluateWindow(schedule: DownloadSchedule, ctx: ScheduleContext): ScheduleEvaluation {
  const start = schedule.windowStartHour;
  const end = schedule.windowEndHour;
  if (start === undefined || end === undefined) {
    return go('schedule invalid; releasing');
  }
  if (!isWindowHourValid(start) || !isWindowHourValid(end)) {
    return go('schedule invalid; releasing');
  }
  if (start === end) {
    return go('schedule invalid; releasing');
  }
  const hour = ctx.localHour;
  // Same-day window [start, end). Wraps midnight when start > end.
  const inWindow = start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
  return inWindow ? go('within window') : wait('outside window');
}

/**
 * Pure evaluation: given a schedule and a snapshot of conditions, decide
 * whether the job may start now.
 *
 * The `maxDelayMs` override is checked first when set: a job that has been
 * waiting too long will always be released, regardless of conditions, so a
 * misconfigured schedule cannot strand a download forever.
 */
export function evaluateSchedule(
  schedule: DownloadSchedule,
  context: ScheduleContext,
): ScheduleEvaluation {
  const override = maxDelayOverride(schedule, context);
  if (override) return override;
  switch (schedule.kind) {
    case 'immediate':
      return evaluateImmediate();
    case 'wifi':
      return evaluateWifi(context);
    case 'wifi-charging':
      return evaluateWifiCharging(context);
    case 'idle':
      return evaluateIdle(context);
    case 'window':
      return evaluateWindow(schedule, context);
    default: {
      // Exhaustiveness guard for forward-compat. Returning a refusal here
      // means a future client encountering a schedule from a newer client
      // simply waits for max-delay rather than running it blindly.
      const _exhaustive: never = schedule.kind;
      void _exhaustive;
      return wait('unknown schedule kind', null);
    }
  }
}

/** Convenience helper for fixtures and the schedule manager. */
export function isImmediate(schedule: DownloadSchedule): boolean {
  return schedule.kind === 'immediate';
}
