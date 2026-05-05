import { afterEach, describe, expect, it, vi } from "vitest";
import { EditScheduleDialog } from "../EditScheduleDialog";
import { click, render, requireElement } from "./DownloadTestUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => document.body.replaceChildren());

describe("EditScheduleDialog", () => {
  it("renders nothing when closed", async () => {
    const r = await render(
      <EditScheduleDialog open={false} initialSchedule={null} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(r.container.querySelector("[role=dialog]")).toBeNull();
    await r.unmount();
  });

  it("pre-fills with the job's current schedule", async () => {
    const r = await render(
      <EditScheduleDialog
        open
        initialSchedule={{ kind: "wifi", maxDelayMs: 7_200_000 }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const wifiRadio = requireElement(r.container.querySelector<HTMLInputElement>("[data-testid=schedule-kind-wifi]"));
    expect(wifiRadio.checked).toBe(true);
    const maxDelay = requireElement(r.container.querySelector<HTMLInputElement>("[data-testid=schedule-max-delay]"));
    expect(maxDelay.value).toBe("2");
    await r.unmount();
  });

  it("emits the new schedule on Save", async () => {
    const onConfirm = vi.fn();
    const r = await render(
      <EditScheduleDialog
        open
        initialSchedule={{ kind: "immediate" }}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    await click(requireElement(r.container.querySelector("[data-testid=schedule-kind-idle]")));
    await click(requireElement(r.container.querySelector("[data-testid=edit-schedule-save]")));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "idle" });
    await r.unmount();
  });

  it("backdrop click invokes onClose", async () => {
    const onClose = vi.fn();
    const r = await render(
      <EditScheduleDialog open initialSchedule={null} onClose={onClose} onConfirm={vi.fn()} />,
    );
    await click(requireElement(r.container.querySelector(".download-edit-schedule-backdrop")));
    expect(onClose).toHaveBeenCalled();
    await r.unmount();
  });
});
