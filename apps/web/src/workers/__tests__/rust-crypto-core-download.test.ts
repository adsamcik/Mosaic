import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../types';

const wasmMocks = vi.hoisted(() => ({
  init: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  downloadApplyEventV1: vi.fn(),
  downloadBuildPlanV1: vi.fn(),
  downloadCommitSnapshotV1: vi.fn(),
  downloadInitSnapshotV1: vi.fn(),
  downloadLoadSnapshotV1: vi.fn(),
  downloadVerifySnapshotV1: vi.fn(),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.init,
  downloadApplyEventV1: wasmMocks.downloadApplyEventV1,
  downloadBuildPlanV1: wasmMocks.downloadBuildPlanV1,
  downloadCommitSnapshotV1: wasmMocks.downloadCommitSnapshotV1,
  downloadInitSnapshotV1: wasmMocks.downloadInitSnapshotV1,
  downloadLoadSnapshotV1: wasmMocks.downloadLoadSnapshotV1,
  downloadVerifySnapshotV1: wasmMocks.downloadVerifySnapshotV1,
}));

import {
  rustApplyDownloadEvent,
  rustBuildDownloadPlan,
  rustCommitDownloadSnapshot,
  rustInitDownloadSnapshot,
  rustLoadDownloadSnapshot,
  rustVerifyDownloadSnapshot,
  type DownloadBuildPlanInput,
} from '../rust-crypto-core';

const jobId = new Uint8Array(16).fill(1);
const albumId = '018f0000-0000-7000-8000-000000000002';
const shardId = new Uint8Array(16).fill(3);

function result<T extends object>(fields: T): T & { free(): void } {
  return { ...fields, free: vi.fn() };
}

function planInput(tier: number): DownloadBuildPlanInput {
  return {
    photos: [
      {
        photoId: 'photo-1',
        filename: 'IMG:001.jpg',
        shards: [
          {
            shardId,
            epochId: 7,
            tier,
            expectedHash: new Uint8Array(32).fill(0x44),
            declaredSize: 1234,
          },
        ],
      },
    ],
  };
}

function expectWorkerCode(error: unknown, code: WorkerCryptoErrorCode): void {
  expect(WorkerCryptoError.is(error)).toBe(true);
  if (WorkerCryptoError.is(error)) {
    expect(error.code).toBe(code);
  }
}

describe('rust download facade wrappers', () => {
  beforeEach(() => {
    wasmMocks.downloadApplyEventV1.mockReset();
    wasmMocks.downloadBuildPlanV1.mockReset();
    wasmMocks.downloadCommitSnapshotV1.mockReset();
    wasmMocks.downloadInitSnapshotV1.mockReset();
    wasmMocks.downloadLoadSnapshotV1.mockReset();
    wasmMocks.downloadVerifySnapshotV1.mockReset();
  });

  it('applies a valid download event through WASM', async () => {
    const wasmResult = result({ code: 0, newStateCbor: new Uint8Array([0xa1, 0, 2]) });
    wasmMocks.downloadApplyEventV1.mockReturnValue(wasmResult);

    await expect(
      rustApplyDownloadEvent(new Uint8Array([0xa1, 0, 1]), new Uint8Array([0xa1, 0, 1])),
    ).resolves.toEqual({ newStateBytes: new Uint8Array([0xa1, 0, 2]) });
    expect(wasmResult.free).toHaveBeenCalledTimes(1);
  });

  it('surfaces illegal transitions as typed worker errors', async () => {
    const wasmResult = result({ code: 721, newStateCbor: new Uint8Array() });
    wasmMocks.downloadApplyEventV1.mockReturnValue(wasmResult);

    await expect(
      rustApplyDownloadEvent(new Uint8Array([0xa1, 0, 0]), new Uint8Array([0xa1, 0, 1])),
    ).rejects.toSatisfy((error: unknown) => {
      expectWorkerCode(error, WorkerCryptoErrorCode.DownloadIllegalTransition);
      return true;
    });
    expect(wasmResult.free).toHaveBeenCalledTimes(1);
  });

  it('builds a canonical download plan and rejects disallowed tiers', async () => {
    const ok = result({ code: 0, planCbor: new Uint8Array([0x81]), errorDetail: '' });
    wasmMocks.downloadBuildPlanV1.mockReturnValueOnce(ok);

    await expect(rustBuildDownloadPlan(planInput(3))).resolves.toEqual({
      planBytes: new Uint8Array([0x81]),
    });
    expect(wasmMocks.downloadBuildPlanV1).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(ok.free).toHaveBeenCalledTimes(1);

    const invalid = result({ code: 720, planCbor: new Uint8Array(), errorDetail: 'DisallowedTier' });
    wasmMocks.downloadBuildPlanV1.mockReturnValueOnce(invalid);
    await expect(rustBuildDownloadPlan(planInput(1))).rejects.toSatisfy(
      (error: unknown) => {
        expectWorkerCode(error, WorkerCryptoErrorCode.DownloadInvalidPlan);
        return true;
      },
    );
    expect(invalid.free).toHaveBeenCalledTimes(1);
  });

  it('round-trips download snapshots and detects checksum mismatch', async () => {
    const bodyBytes = new Uint8Array([0xa1, 0, 1]);
    const checksum = new Uint8Array(32).fill(9);
    const planBytes = new Uint8Array([0x81]);
    wasmMocks.downloadBuildPlanV1.mockReturnValue(
      result({ code: 0, planCbor: planBytes, errorDetail: '' }),
    );
    wasmMocks.downloadInitSnapshotV1.mockReturnValue(
      result({ code: 0, body: bodyBytes, checksum }),
    );
    wasmMocks.downloadCommitSnapshotV1.mockReturnValue(result({ code: 0, checksum }));
    wasmMocks.downloadLoadSnapshotV1
      .mockReturnValueOnce(
        result({ code: 0, snapshotCbor: bodyBytes, schemaVersionLoaded: 1 }),
      )
      .mockReturnValueOnce(
        result({ code: 724, snapshotCbor: new Uint8Array(), schemaVersionLoaded: 0 }),
      );

    const built = await rustBuildDownloadPlan(planInput(3));
    const initialized = await rustInitDownloadSnapshot({
      jobId,
      albumId,
      planBytes: built.planBytes,
      nowMs: 1_700_000_000_000,
    });
    await expect(rustCommitDownloadSnapshot(initialized.bodyBytes)).resolves.toEqual({ checksum });
    await expect(rustLoadDownloadSnapshot(bodyBytes, checksum)).resolves.toEqual({
      snapshotBytes: bodyBytes,
      schemaVersionLoaded: 1,
    });
    await expect(rustLoadDownloadSnapshot(bodyBytes, new Uint8Array(32))).rejects.toSatisfy(
      (error: unknown) => {
        expectWorkerCode(error, WorkerCryptoErrorCode.DownloadSnapshotChecksumMismatch);
        return true;
      },
    );
  });

  it('verifies download snapshot checksums without throwing on mismatch', async () => {
    wasmMocks.downloadVerifySnapshotV1
      .mockReturnValueOnce(result({ code: 0, valid: true }))
      .mockReturnValueOnce(result({ code: 0, valid: false }));

    await expect(
      rustVerifyDownloadSnapshot(new Uint8Array([1]), new Uint8Array(32).fill(1)),
    ).resolves.toEqual({ valid: true });
    await expect(
      rustVerifyDownloadSnapshot(new Uint8Array([1]), new Uint8Array(32)),
    ).resolves.toEqual({ valid: false });
  });
});