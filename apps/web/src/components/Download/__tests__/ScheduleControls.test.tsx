import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState, type JSX } from "react";
import { ScheduleControls, loadLastUsedSchedule, persistLastUsedSchedule } from "../ScheduleControls";
import type { DownloadSchedule } from "../../../lib/download-schedule";
import { click, render, requireElement } from "./DownloadTestUtils";

import { vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = "mosaic.download-schedule.last-used";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
});

function Harness({ initial }: { readonly initial: DownloadSchedule }): JSX.Element {
  const [schedule, setSchedule] = useState<DownloadSchedule>(initial);
  return <ScheduleControls value={schedule} onChange={setSchedule} />;
}

describe("ScheduleControls", () => {
  it("renders all five kind options", async () => {
    const r = await render(<Harness initial={{ kind: "immediate" }} />);
    for (const kind of ["immediate", "wifi", "wifi-charging", "idle", "window"]) {
      expect(r.container.querySelector(`[data-testid=\"schedule-kind-${kind}\"]`)).not.toBeNull();
    }
    await r.unmount();
  });

  it("window kind reveals start/end inputs and seeds defaults", async () => {
    const r = await render(<Harness initial={{ kind: "immediate" }} />);
    await click(requireElement(r.container.querySelector("[data-testid=\"schedule-kind-window\"]")));
    const start = r.container.querySelector<HTMLInputElement>("[data-testid=\"schedule-window-start\"]");
    const end = r.container.querySelector<HTMLInputElement>("[data-testid=\"schedule-window-end\"]");
    expect(start?.value).toBe("22:00");
    expect(end?.value).toBe("06:00");
    await r.unmount();
  });
});

describe("loadLastUsedSchedule / persistLastUsedSchedule", () => {
  it("persists and reads back", () => {
    persistLastUsedSchedule({ kind: "wifi", maxDelayMs: 3_600_000 });
    expect(loadLastUsedSchedule()).toEqual({ kind: "wifi", maxDelayMs: 3_600_000 });
  });

  it("falls back to immediate when nothing is stored", () => {
    expect(loadLastUsedSchedule()).toEqual({ kind: "immediate" });
  });

  it("falls back to immediate on corrupt JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json{");
    expect(loadLastUsedSchedule()).toEqual({ kind: "immediate" });
  });

  it("rejects unknown schedule kinds", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: "satellite" }));
    expect(loadLastUsedSchedule()).toEqual({ kind: "immediate" });
  });

  it("rejects window schedules with out-of-range hours", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: "window", windowStartHour: 99, windowEndHour: 6 }));
    expect(loadLastUsedSchedule()).toEqual({ kind: "immediate" });
  });

  it("rejects negative maxDelayMs", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: "wifi", maxDelayMs: -1 }));
    expect(loadLastUsedSchedule()).toEqual({ kind: "immediate" });
  });
});
