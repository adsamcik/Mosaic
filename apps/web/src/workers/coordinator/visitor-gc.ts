/**
 * Visitor OPFS GC — terminal/abandoned share-link-scope jobs are swept on
 * coordinator startup so an offline tab does not retain a visitor staging
 * directory indefinitely after the user closes the share link.
 *
 * Sweep rules (visitor-scope jobs only — auth/legacy are NEVER swept here):
 *   - Terminal phase  (Done | Cancelled | Errored) older than
 *     {@link VISITOR_GC_TTL_MS}                       → swept.
 *   - Non-terminal jobs older than
 *     {@link VISITOR_RESUME_GRACE_MS}                 → swept (assume the
 *     share link is dead and the user is never coming back).
 *
 * Auth/legacy jobs have their own retention paths via session lifecycle
 * and the existing `gc(opts)` API; this helper specifically guards the
 * tail of visitor sessions where there is no session to anchor cleanup to.
 *
 * # ZK-safety
 * The helper takes only opaque `scopeKey` strings (never link ids / grants)
 * and returns job ids; callers must continue to log only the prefix.
 */
import type { DownloadPhase } from '../types';

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** TTL for terminal visitor jobs (default 7 days). */
export const VISITOR_GC_TTL_DAYS = 7;
export const VISITOR_GC_TTL_MS = VISITOR_GC_TTL_DAYS * ONE_DAY_MS;

/** Grace period for non-terminal visitor jobs (default 14 days). */
export const VISITOR_RESUME_GRACE_DAYS = 14;
export const VISITOR_RESUME_GRACE_MS = VISITOR_RESUME_GRACE_DAYS * ONE_DAY_MS;

/** Minimal job shape required by {@link selectStaleVisitorJobs}. */
export interface VisitorGcCandidate {
  readonly jobId: string;
  readonly scopeKey: string;
  readonly phase: DownloadPhase;
  readonly lastUpdatedAtMs: number;
}

export interface VisitorGcOptions {
  readonly nowMs: number;
  /** Override for tests. */
  readonly ttlMs?: number;
  /** Override for tests. */
  readonly graceMs?: number;
}

/** True for the three terminal `DownloadPhase` values. */
function isTerminalPhase(phase: DownloadPhase): boolean {
  return phase === 'Done' || phase === 'Cancelled' || phase === 'Errored';
}

/** True iff the scope key marks a share-link visitor job. */
export function isVisitorScopeKey(scopeKey: string): boolean {
  return scopeKey.startsWith('visitor:');
}

/**
 * Pick visitor jobs that should be purged. Auth / legacy jobs are never
 * selected so non-visitor retention rules win.
 */
export function selectStaleVisitorJobs(
  candidates: Iterable<VisitorGcCandidate>,
  opts: VisitorGcOptions,
): string[] {
  const ttl = opts.ttlMs ?? VISITOR_GC_TTL_MS;
  const grace = opts.graceMs ?? VISITOR_RESUME_GRACE_MS;
  const stale: string[] = [];
  for (const job of candidates) {
    if (!isVisitorScopeKey(job.scopeKey)) continue;
    const ageMs = opts.nowMs - job.lastUpdatedAtMs;
    if (ageMs < 0) continue; // future-stamped clock skew → keep
    const limit = isTerminalPhase(job.phase) ? ttl : grace;
    if (ageMs > limit) {
      stale.push(job.jobId);
    }
  }
  return stale;
}