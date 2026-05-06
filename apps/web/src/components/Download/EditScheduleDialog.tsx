import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import type { DownloadSchedule } from "../../lib/download-schedule";
import { ScheduleControls } from "./ScheduleControls";

export interface EditScheduleDialogProps {
  readonly open: boolean;
  /** Initial schedule to edit; defaults to immediate when null. */
  readonly initialSchedule: DownloadSchedule | null;
  readonly onClose: () => void;
  /** Called with the new schedule on Save. */
  readonly onConfirm: (schedule: DownloadSchedule) => void | Promise<void>;
}

/**
 * Dialog wrapping {@link ScheduleControls} for the tray's `Edit schedule`
 * action. Pre-fills with the job's current schedule and emits the new
 * schedule on Save (caller wires it to `coordinator.updateJobSchedule`).
 *
 * Closing without saving is a no-op; the job's schedule is unchanged.
 */
export function EditScheduleDialog(props: EditScheduleDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const [schedule, setSchedule] = useState<DownloadSchedule>(props.initialSchedule ?? { kind: "immediate" });
  if (!props.open) return null;

  const handleConfirm = async (): Promise<void> => {
    await props.onConfirm(schedule);
  };

  return (
    <div className="download-edit-schedule-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className="download-edit-schedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-schedule-title"
        onClick={(event): void => event.stopPropagation()}
      >
        <h2 id="edit-schedule-title" className="download-edit-schedule-title">
          {t("download.tray.editScheduleTitle")}
        </h2>
        <ScheduleControls value={schedule} onChange={setSchedule} compact />
        <div className="download-edit-schedule-actions">
          <button type="button" className="download-tray-button" onClick={props.onClose}>
            {t("download.schedule.cancel")}
          </button>
          <button
            type="button"
            className="download-tray-button download-tray-button--primary"
            onClick={(): void => { void handleConfirm(); }}
            data-testid="edit-schedule-save"
          >
            {t("download.schedule.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
