import type { JSX } from "react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { DownloadSchedule, ScheduleKind } from "../../lib/download-schedule";

const STORAGE_KEY = "mosaic.download-schedule.last-used";
const MIN_MAX_DELAY_HOURS = 1;
const MAX_MAX_DELAY_HOURS = 168;
const HOUR_MS = 60 * 60 * 1000;

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["immediate", "wifi", "wifi-charging", "idle", "window"];

const KIND_TRANSLATION_KEY: Readonly<Record<ScheduleKind, string>> = {
  immediate: "download.schedule.kind.immediate",
  wifi: "download.schedule.kind.wifi",
  "wifi-charging": "download.schedule.kind.wifiCharging",
  idle: "download.schedule.kind.idle",
  window: "download.schedule.kind.window",
};

export interface ScheduleControlsProps {
  readonly value: DownloadSchedule;
  readonly onChange: (next: DownloadSchedule) => void;
  /** When true, controls are rendered in a compact dialog layout. */
  readonly compact?: boolean;
}

/**
 * Shared schedule editor used by both the download mode picker and the
 * tray's `Edit schedule` dialog.
 *
 * Exposes the five {@link ScheduleKind} options as a radio group, plus
 * the optional `windowStartHour`/`windowEndHour` time pickers and a
 * `maxDelayMs` numeric input (rendered as hours).
 *
 * Pure controlled component: persists nothing, captures nothing. Callers
 * decide what to do with `onChange`.
 */
export function ScheduleControls(props: ScheduleControlsProps): JSX.Element {
  const { value, onChange, compact = false } = props;
  const { t } = useTranslation();
  const groupId = useId();
  const setKind = (kind: ScheduleKind): void => {
    if (kind === "window") {
      onChange({
        kind,
        windowStartHour: value.windowStartHour ?? 22,
        windowEndHour: value.windowEndHour ?? 6,
        ...(value.maxDelayMs === undefined ? {} : { maxDelayMs: value.maxDelayMs }),
      });
      return;
    }
    onChange({
      kind,
      ...(value.maxDelayMs === undefined ? {} : { maxDelayMs: value.maxDelayMs }),
    });
  };

  return (
    <div className={`download-schedule-controls ${compact ? "download-schedule-controls--compact" : ""}`}>
      <fieldset className="download-schedule-kind-group">
        <legend className="download-schedule-kind-legend">{t("download.schedule.title")}</legend>
        {SCHEDULE_KINDS.map((kind) => {
          const id = `${groupId}-${kind}`;
          return (
            <label key={kind} className="download-schedule-kind-option" htmlFor={id}>
              <input
                id={id}
                type="radio"
                name={`${groupId}-kind`}
                value={kind}
                checked={value.kind === kind}
                onChange={(): void => setKind(kind)}
                data-testid={`schedule-kind-${kind}`}
              />
              <span>{t(KIND_TRANSLATION_KEY[kind])}</span>
            </label>
          );
        })}
      </fieldset>
      {value.kind === "window" && (
        <div className="download-schedule-window">
          <label>
            <span>{t("download.schedule.windowStart")}</span>
            <input
              type="time"
              value={hourToTime(value.windowStartHour ?? 22)}
              onChange={(event): void => onChange({ ...value, windowStartHour: timeToHour(event.target.value, value.windowStartHour ?? 22) })}
              data-testid="schedule-window-start"
            />
          </label>
          <label>
            <span>{t("download.schedule.windowEnd")}</span>
            <input
              type="time"
              value={hourToTime(value.windowEndHour ?? 6)}
              onChange={(event): void => onChange({ ...value, windowEndHour: timeToHour(event.target.value, value.windowEndHour ?? 6) })}
              data-testid="schedule-window-end"
            />
          </label>
        </div>
      )}
      <label className="download-schedule-max-delay">
        <span>{t("download.schedule.maxDelay")}</span>
        <input
          type="number"
          min={MIN_MAX_DELAY_HOURS}
          max={MAX_MAX_DELAY_HOURS}
          step={1}
          value={value.maxDelayMs === undefined ? "" : Math.round(value.maxDelayMs / HOUR_MS)}
          onChange={(event): void => {
            const raw = event.target.value;
            if (raw === "") {
              const next: DownloadSchedule = { ...value };
              delete (next as { maxDelayMs?: number }).maxDelayMs;
              onChange(next);
              return;
            }
            const hours = Number.parseInt(raw, 10);
            if (!Number.isFinite(hours)) return;
            const clamped = Math.max(MIN_MAX_DELAY_HOURS, Math.min(MAX_MAX_DELAY_HOURS, hours));
            onChange({ ...value, maxDelayMs: clamped * HOUR_MS });
          }}
          data-testid="schedule-max-delay"
        />
        <span className="download-schedule-max-delay-hint">{t("download.schedule.maxDelayHelp")}</span>
      </label>
    </div>
  );
}

/**
 * Read the last-used schedule from localStorage. Returns Immediate as a
 * safe fallback when storage is unavailable / corrupt.
 *
 * Validation is conservative: any unrecognized field shape, kind code,
 * or numeric range produces the Immediate fallback.
 */
export function loadLastUsedSchedule(): DownloadSchedule {
  if (typeof window === "undefined") return { kind: "immediate" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { kind: "immediate" };
    const parsed: unknown = JSON.parse(raw);
    if (!isValidScheduleShape(parsed)) return { kind: "immediate" };
    return parsed;
  } catch {
    return { kind: "immediate" };
  }
}

/** Persist the last-used schedule. Silently swallows quota / privacy errors. */
export function persistLastUsedSchedule(schedule: DownloadSchedule): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  } catch {
    // ignore: storage may be disabled in private mode.
  }
}

function isValidScheduleShape(value: unknown): value is DownloadSchedule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string") return false;
  if (!SCHEDULE_KINDS.includes(v.kind as ScheduleKind)) return false;
  if (v.maxDelayMs !== undefined && (typeof v.maxDelayMs !== "number" || !Number.isFinite(v.maxDelayMs) || v.maxDelayMs < 0)) return false;
  if (v.kind === "window") {
    if (!isValidHour(v.windowStartHour) || !isValidHour(v.windowEndHour)) return false;
  }
  return true;
}

function isValidHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

function hourToTime(hour: number): string {
  const clamped = Math.max(0, Math.min(23, Math.round(hour)));
  return `${String(clamped).padStart(2, "0")}:00`;
}

function timeToHour(value: string, fallback: number): number {
  const match = /^([0-9]{1,2}):([0-9]{2})$/u.exec(value);
  if (!match) return fallback;
  const hour = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback;
  return hour;
}
