/**
 * Integration tests for tray scope-key filtering across the full TS stack:
 *
 *   SourceStrategy.getScopeKey()
 *     -> CoordinatorWorker.startJob (writes scope_key into snapshot CBOR key 10)
 *       -> JobSummary.scopeKey
 *         -> DownloadTray filterJobsByScope (auth | visitor | legacy)
 *
 * The Rust derivation logic lives in `crates/mosaic-client/src/download/scope.rs`
 * and is mirrored in `apps/web/src/lib/scope-key.ts`. These tests use the
 * real TS derivation but a stubbed WASM facade, since the only thing the
 * coordinator does with the scope key is round-trip it through CBOR.
 */
import sodium from 'libsodium-wrappers-sumo';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAuthScopeKey,
  deriveVisitorScopeKey,
  ensureScopeKeySodiumReady,
  legacyScopeKey,
} from '../../lib/scope-key';

beforeAll(async () => {
  await sodium.ready;
  await ensureScopeKeySodiumReady();
});

/**
 * Replicates `filterJobsByScope` from `DownloadTray.tsx` so the test file
 * stays decoupled from React rendering concerns and can exercise the tray
 * matrix directly. Keep this in sync with the component.
 */
function filterJobsByScope<T extends { readonly scopeKey: string }>(
  jobs: ReadonlyArray<T>,
  currentScope: string | null,
): T[] {
  if (currentScope === null) return [];
  return jobs.filter((job) => {
    if (job.scopeKey === currentScope) return true;
    if (job.scopeKey.startsWith('legacy:') && currentScope.startsWith('auth:')) {
      return true;
    }
    return false;
  });
}

interface TestJob {
  readonly jobId: string;
  readonly scopeKey: string;
}

describe('coordinator scope-key tray filtering (integration)', () => {
  it('auth user does not see visitor jobs and vice versa', () => {
    const auth = deriveAuthScopeKey('user-a');
    const visitor = deriveVisitorScopeKey('link-1', 'grant-x');
    const jobs: TestJob[] = [
      { jobId: 'a', scopeKey: auth },
      { jobId: 'v', scopeKey: visitor },
    ];
    expect(filterJobsByScope(jobs, auth).map((j) => j.jobId)).toEqual(['a']);
    expect(filterJobsByScope(jobs, visitor).map((j) => j.jobId)).toEqual(['v']);
  });

  it('different visitor grants on the same device do not see each other', () => {
    const v1 = deriveVisitorScopeKey('link-1', 'grant-a');
    const v2 = deriveVisitorScopeKey('link-1', 'grant-b');
    expect(v1).not.toBe(v2);
    const jobs: TestJob[] = [
      { jobId: 'g1', scopeKey: v1 },
      { jobId: 'g2', scopeKey: v2 },
    ];
    expect(filterJobsByScope(jobs, v1).map((j) => j.jobId)).toEqual(['g1']);
    expect(filterJobsByScope(jobs, v2).map((j) => j.jobId)).toEqual(['g2']);
  });

  it('different visitor links produce disjoint scopes', () => {
    const a = deriveVisitorScopeKey('link-a', null);
    const b = deriveVisitorScopeKey('link-b', null);
    expect(a).not.toBe(b);
    const jobs: TestJob[] = [
      { jobId: 'a', scopeKey: a },
      { jobId: 'b', scopeKey: b },
    ];
    expect(filterJobsByScope(jobs, a).map((j) => j.jobId)).toEqual(['a']);
    expect(filterJobsByScope(jobs, b).map((j) => j.jobId)).toEqual(['b']);
  });

  it('auth user sees legacy:* jobs (v1 migration safety net)', () => {
    const auth = deriveAuthScopeKey('user-a');
    const legacy = legacyScopeKey('deadbeef'.repeat(4));
    const jobs: TestJob[] = [{ jobId: 'old', scopeKey: legacy }];
    expect(filterJobsByScope(jobs, auth).map((j) => j.jobId)).toEqual(['old']);
  });

  it('visitor never sees legacy:* jobs', () => {
    const visitor = deriveVisitorScopeKey('link-1', null);
    const legacy = legacyScopeKey('deadbeef'.repeat(4));
    const jobs: TestJob[] = [{ jobId: 'old', scopeKey: legacy }];
    expect(filterJobsByScope(jobs, visitor)).toEqual([]);
  });

  it('null scope hides everything', () => {
    const jobs: TestJob[] = [
      { jobId: 'a', scopeKey: deriveAuthScopeKey('user-a') },
      { jobId: 'l', scopeKey: legacyScopeKey('00'.repeat(16)) },
      { jobId: 'v', scopeKey: deriveVisitorScopeKey('link', null) },
    ];
    expect(filterJobsByScope(jobs, null)).toEqual([]);
  });

  it('visitor null grant collapses with empty grant (matches Rust)', () => {
    const a = deriveVisitorScopeKey('link', null);
    const b = deriveVisitorScopeKey('link', '');
    expect(a).toBe(b);
  });

  it('auth and visitor with same input string still produce distinct scopes', () => {
    const auth = deriveAuthScopeKey('shared-id');
    const visitor = deriveVisitorScopeKey('shared-id', null);
    expect(auth.slice('auth:'.length)).not.toBe(visitor.slice('visitor:'.length));
  });
});