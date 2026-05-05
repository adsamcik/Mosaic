import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadSchedule } from "../useDownloadSchedule";
import { act, useEffect, type JSX } from "react";
import { createRoot } from "react-dom/client";
import type { JobSummary } from "../../workers/types";

const mocks = vi.hoisted(() => ({
  forceStartJob: vi.fn(async () => undefined),
  updateJobSchedule: vi.fn(async () => undefined),
  cancelJob: vi.fn(async () => ({ phase: 'Cancelled' as const })),
  jobs: [] as JobSummary[],
}));

vi.mock("../useDownloadManager", () => ({
  useDownloadManager: () => ({
    ready: true,
    jobs: mocks.jobs,
    resumableJobs: [],
    api: null,
    error: null,
    subscribe: () => () => undefined,
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    cancelJob: mocks.cancelJob,
    computeAlbumDiff: vi.fn(),
    forceStartJob: mocks.forceStartJob,
    updateJobSchedule: mocks.updateJobSchedule,
  }),
}));

const baseJob: JobSummary = {
  jobId: "abc",
  albumId: "alb",
  phase: "Idle",
  photoCounts: { pending: 1, inflight: 0, done: 0, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 0,
  lastUpdatedAtMs: 0,
  scopeKey: "auth:00000000000000000000000000000000",
  lastErrorReason: null,
  schedule: { kind: "wifi" },
  scheduleEvaluation: { canStart: false, reason: "connection too slow", retryAfterMs: 30_000 },
};

beforeEach(() => {
  mocks.jobs = [];
  mocks.forceStartJob.mockClear();
  mocks.updateJobSchedule.mockClear();
  mocks.cancelJob.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

interface CapturedRef { current: ReturnType<typeof useDownloadSchedule> | null }

function Probe({ jobId, captured }: { readonly jobId: string; readonly captured: CapturedRef }): JSX.Element {
  const result = useDownloadSchedule(jobId);
  useEffect(() => {
    captured.current = result;
  });
  return <div />;
}

async function renderProbe(jobId: string): Promise<{ captured: CapturedRef; cleanup: () => Promise<void> }> {
  const captured: CapturedRef = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe jobId={jobId} captured={captured} />);
    await Promise.resolve();
  });
  return {
    captured,
    cleanup: async (): Promise<void> => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

describe("useDownloadSchedule", () => {
  it("returns null fields for an unknown job", async () => {
    const { captured, cleanup } = await renderProbe("missing");
    expect(captured.current?.schedule).toBeNull();
    expect(captured.current?.evaluation).toBeNull();
    await cleanup();
  });

  it("surfaces the job's schedule + evaluation when present", async () => {
    mocks.jobs = [baseJob];
    const { captured, cleanup } = await renderProbe("abc");
    expect(captured.current?.schedule).toEqual({ kind: "wifi" });
    expect(captured.current?.evaluation?.reason).toBe("connection too slow");
    await cleanup();
  });

  it("forceStart proxies to manager.forceStartJob", async () => {
    mocks.jobs = [baseJob];
    const { captured, cleanup } = await renderProbe("abc");
    await captured.current?.forceStart();
    expect(mocks.forceStartJob).toHaveBeenCalledWith("abc");
    await cleanup();
  });

  it("updateSchedule proxies to manager.updateJobSchedule", async () => {
    mocks.jobs = [baseJob];
    const { captured, cleanup } = await renderProbe("abc");
    await captured.current?.updateSchedule({ kind: "idle" });
    expect(mocks.updateJobSchedule).toHaveBeenCalledWith("abc", { kind: "idle" });
    await cleanup();
  });

  it("cancel proxies to manager.cancelJob with hard cancel", async () => {
    mocks.jobs = [baseJob];
    const { captured, cleanup } = await renderProbe("abc");
    await captured.current?.cancel();
    expect(mocks.cancelJob).toHaveBeenCalledWith("abc", { soft: false });
    await cleanup();
  });
});
