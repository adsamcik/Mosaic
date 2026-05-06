/**
 * Background Fetch launcher — main-thread side.
 *
 * The coordinator worker can't initiate Background Fetch (no
 * `navigator.serviceWorker` in DedicatedWorker scope), so the React hook
 * driving a download (e.g. `useAlbumDownload`) calls this from the main
 * thread BEFORE / IN PARALLEL with `runCoordinatorDownload`.
 *
 * Heuristic for "large enough":
 *   - On Chromium-Android the BG-Fetch UI is heavyweight; we don't want
 *     to spawn a notification for a 5-photo download.
 *   - Threshold: `photoCount >= 50`. We don't reliably know totalBytes
 *     up-front (shards have variable size and are encrypted), so photo
 *     count is the more available, ZK-safe proxy. Documented constant
 *     so it can be tuned later.
 *
 * On unsupported browsers (Firefox, Safari, no SW) this is a no-op.
 * On BG-Fetch fail/abort, the foreground coordinator path keeps running
 * unaltered — the cache-peek in `shard-service.ts` is purely additive.
 */
import { createLogger } from './logger';
import { buildAuthShardUrl } from './shard-service';

const log = createLogger('bgfetch-launcher');

/** Photo-count threshold above which a Background Fetch is worthwhile. */
export const BG_FETCH_PHOTO_COUNT_THRESHOLD = 50;

export interface BgFetchLaunchInput {
  readonly jobId: string;
  readonly title: string;
  readonly shardIds: ReadonlyArray<string>;
  readonly photoCount: number;
  readonly downloadTotal?: number;
}

export interface BgFetchStarter {
  readonly support: { readonly supported: boolean };
  readonly start: (
    urls: string[],
    options: { id: string; title: string; downloadTotal?: number },
  ) => Promise<{ id: string; abort: () => Promise<boolean> }>;
}

export interface BgFetchLaunchResult {
  readonly kind: 'launched' | 'unsupported' | 'too-small' | 'no-shards' | 'error';
  readonly handle?: { id: string; abort: () => Promise<boolean> };
}

/**
 * Try to launch a Background Fetch for the given job. Returns a structured
 * result; never throws. Caller treats anything other than `'launched'` as
 * "no BG-Fetch in flight, proceed with foreground only" — which is correct
 * because the foreground path is unchanged.
 */
export async function maybeStartBackgroundFetch(
  starter: BgFetchStarter,
  input: BgFetchLaunchInput,
): Promise<BgFetchLaunchResult> {
  if (!starter.support.supported) return { kind: 'unsupported' };
  if (input.photoCount < BG_FETCH_PHOTO_COUNT_THRESHOLD) return { kind: 'too-small' };
  if (input.shardIds.length === 0) return { kind: 'no-shards' };

  const urls = input.shardIds.map(buildAuthShardUrl);
  try {
    const handle = await starter.start(urls, {
      id: input.jobId,
      title: input.title,
      ...(input.downloadTotal !== undefined ? { downloadTotal: input.downloadTotal } : {}),
    });
    log.info('Background Fetch launched');
    return { kind: 'launched', handle };
  } catch (err) {
    log.warn('Background Fetch launch failed', {
      errorName: err instanceof Error ? err.name : 'Unknown',
    });
    return { kind: 'error' };
  }
}