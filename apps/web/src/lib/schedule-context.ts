/**
 * Browser-API → {@link ScheduleContext} adapter.
 *
 * Reads from `navigator.connection`, `navigator.getBattery`,
 * `document.visibilityState` and `Date`, with graceful fallbacks for
 * platforms (Firefox, Safari) that omit the underlying APIs. Pure I/O —
 * never decides whether a job may start; that is `download-schedule.ts`.
 *
 * The returned object is frozen so callers cannot accidentally mutate
 * the snapshot between capture and evaluation.
 */

import type { ScheduleContext } from './download-schedule';

interface NetworkInformationLike {
  readonly effectiveType?: string;
  readonly saveData?: boolean;
}

interface NavigatorWithConnection {
  readonly connection?: NetworkInformationLike;
  readonly mozConnection?: NetworkInformationLike;
  readonly webkitConnection?: NetworkInformationLike;
  readonly onLine?: boolean;
  getBattery?: () => Promise<BatteryManagerLike>;
}

interface BatteryManagerLike {
  readonly level?: number;
  readonly charging?: boolean;
}

function getConnection(nav: NavigatorWithConnection): NetworkInformationLike | undefined {
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

function clampLevel(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function readBattery(
  nav: NavigatorWithConnection,
): Promise<{ level: number | null; charging: boolean | null }> {
  if (typeof nav.getBattery !== 'function') {
    return { level: null, charging: null };
  }
  try {
    const mgr = await nav.getBattery();
    return {
      level: clampLevel(mgr.level),
      charging: typeof mgr.charging === 'boolean' ? mgr.charging : null,
    };
  } catch {
    // Some browsers throw SecurityError or have removed the API entirely.
    return { level: null, charging: null };
  }
}

function readVisibility(doc: Document | undefined): 'visible' | 'hidden' {
  // `visibilityState` is the only documented value set; default to 'visible'
  // when running outside a browser (SSR/tests).
  if (!doc) return 'visible';
  return doc.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

function readLocalHour(now: Date): number {
  const hour = now.getHours();
  // getHours can in theory yield NaN if Date is corrupted; guard.
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 0;
  return hour;
}

/**
 * Capture a one-shot snapshot of the conditions relevant to scheduling.
 *
 * @param scheduledAtMs the wallclock at which the schedule was registered.
 *   Used by {@link evaluateSchedule} for `maxDelayMs` accounting.
 */
export async function captureScheduleContext(scheduledAtMs: number): Promise<ScheduleContext> {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as NavigatorWithConnection;
  const doc = typeof document !== 'undefined' ? document : undefined;

  const conn = getConnection(nav);
  const effectiveType = typeof conn?.effectiveType === 'string' ? conn.effectiveType : 'unknown';
  const saveData = conn?.saveData === true;
  const online = nav.onLine !== false; // default to online when unknown
  const battery = await readBattery(nav);
  const now = new Date();

  const ctx: ScheduleContext = {
    online,
    effectiveType,
    saveData,
    batteryLevel: battery.level,
    batteryCharging: battery.charging,
    visibilityState: readVisibility(doc),
    nowMs: now.getTime(),
    localHour: readLocalHour(now),
    scheduledAtMs,
  };
  return Object.freeze(ctx);
}
