import { describe, expect, it } from 'vitest';
import {
  isVisitorScopeKey,
  selectStaleVisitorJobs,
  VISITOR_GC_TTL_DAYS,
  VISITOR_GC_TTL_MS,
  VISITOR_RESUME_GRACE_DAYS,
  VISITOR_RESUME_GRACE_MS,
  type VisitorGcCandidate,
} from '../visitor-gc';

const ONE_DAY = 24 * 60 * 60 * 1_000;
const VISITOR = 'visitor:11111111111111111111111111111111';
const VISITOR_OTHER = 'visitor:22222222222222222222222222222222';
const AUTH = 'auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEGACY = 'legacy:cccccccccccccccccccccccccccccccc';

function job(partial: Partial<VisitorGcCandidate>): VisitorGcCandidate {
  return {
    jobId: 'job-x',
    scopeKey: VISITOR,
    phase: 'Done',
    lastUpdatedAtMs: 0,
    ...partial,
  };
}

describe('visitor-gc constants', () => {
  it('exposes ttl + grace in both days and ms', () => {
    expect(VISITOR_GC_TTL_DAYS).toBe(7);
    expect(VISITOR_GC_TTL_MS).toBe(7 * ONE_DAY);
    expect(VISITOR_RESUME_GRACE_DAYS).toBe(14);
    expect(VISITOR_RESUME_GRACE_MS).toBe(14 * ONE_DAY);
  });
});

describe('isVisitorScopeKey', () => {
  it('accepts only visitor: prefix', () => {
    expect(isVisitorScopeKey(VISITOR)).toBe(true);
    expect(isVisitorScopeKey(AUTH)).toBe(false);
    expect(isVisitorScopeKey(LEGACY)).toBe(false);
    expect(isVisitorScopeKey('')).toBe(false);
  });
});

describe('selectStaleVisitorJobs', () => {
  const nowMs = 30 * ONE_DAY;

  it('sweeps a visitor terminal job older than TTL', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'old', phase: 'Done', lastUpdatedAtMs: nowMs - (VISITOR_GC_TTL_MS + ONE_DAY) })],
      { nowMs },
    );
    expect(stale).toEqual(['old']);
  });

  it('keeps a visitor terminal job within TTL', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'fresh', phase: 'Done', lastUpdatedAtMs: nowMs - (VISITOR_GC_TTL_MS - ONE_DAY) })],
      { nowMs },
    );
    expect(stale).toEqual([]);
  });

  it('keeps a visitor non-terminal job within grace', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'paused', phase: 'Paused', lastUpdatedAtMs: nowMs - (VISITOR_RESUME_GRACE_MS - ONE_DAY) })],
      { nowMs },
    );
    expect(stale).toEqual([]);
  });

  it('sweeps a visitor non-terminal job older than grace', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'abandoned', phase: 'Paused', lastUpdatedAtMs: nowMs - (VISITOR_RESUME_GRACE_MS + ONE_DAY) })],
      { nowMs },
    );
    expect(stale).toEqual(['abandoned']);
  });

  it('NEVER sweeps an auth job at any age', () => {
    const stale = selectStaleVisitorJobs(
      [
        job({ jobId: 'auth-old', scopeKey: AUTH, phase: 'Done', lastUpdatedAtMs: 0 }),
        job({ jobId: 'auth-paused', scopeKey: AUTH, phase: 'Paused', lastUpdatedAtMs: 0 }),
      ],
      { nowMs },
    );
    expect(stale).toEqual([]);
  });

  it('NEVER sweeps a legacy job at any age', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'legacy-old', scopeKey: LEGACY, phase: 'Done', lastUpdatedAtMs: 0 })],
      { nowMs },
    );
    expect(stale).toEqual([]);
  });

  it('handles future-stamped clock skew by keeping the job', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'future', phase: 'Done', lastUpdatedAtMs: nowMs + ONE_DAY })],
      { nowMs },
    );
    expect(stale).toEqual([]);
  });

  it('mixed input: only visitor stale jobs are selected', () => {
    const old = nowMs - (VISITOR_GC_TTL_MS + ONE_DAY);
    const stale = selectStaleVisitorJobs(
      [
        job({ jobId: 'v-old', scopeKey: VISITOR, phase: 'Done', lastUpdatedAtMs: old }),
        job({ jobId: 'v2-old', scopeKey: VISITOR_OTHER, phase: 'Cancelled', lastUpdatedAtMs: old }),
        job({ jobId: 'auth-old', scopeKey: AUTH, phase: 'Done', lastUpdatedAtMs: old }),
        job({ jobId: 'legacy-old', scopeKey: LEGACY, phase: 'Done', lastUpdatedAtMs: old }),
      ],
      { nowMs },
    );
    expect(stale.sort()).toEqual(['v-old', 'v2-old']);
  });

  it('respects test overrides for ttl/grace', () => {
    const stale = selectStaleVisitorJobs(
      [job({ jobId: 'a', phase: 'Done', lastUpdatedAtMs: nowMs - 5 * ONE_DAY })],
      { nowMs, ttlMs: 3 * ONE_DAY },
    );
    expect(stale).toEqual(['a']);
  });
});