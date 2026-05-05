/**
 * React hook wrapping the Background Fetch API.
 *
 * Background Fetch is a Chromium-only feature (Chrome desktop + Chrome Android,
 * not Firefox, not Safari). On unsupported browsers `support.supported` is
 * `false` and `start` rejects: callers must always check before invoking.
 *
 * The actual download is performed by the browser; the service worker
 * (see `src/service-worker/sw.ts`) catches `backgroundfetchsuccess` and stores
 * encrypted bytes in `mosaic-bgfetch-cache`. Decryption stays in the foreground
 * worker pool (ZK invariant — the SW never sees keys).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '../lib/logger';

const log = createLogger('useBackgroundFetch');

export interface BackgroundFetchSupport {
  readonly supported: boolean;
  readonly registration: ServiceWorkerRegistration | null;
}

export interface BackgroundFetchHandle {
  readonly id: string;
  abort(): Promise<boolean>;
}

export interface BackgroundFetchHookOptions {
  readonly id: string;
  readonly title: string;
  readonly icons?: ImageResource[];
  readonly downloadTotal?: number;
}

export type SuccessHandler = (jobId: string, urls: string[]) => void;
export type FailHandler = (jobId: string, reason: string) => void;

export interface UseBackgroundFetchResult {
  readonly support: BackgroundFetchSupport;
  start(urls: string[], options: BackgroundFetchHookOptions): Promise<BackgroundFetchHandle>;
  onSuccess(handler: SuccessHandler): () => void;
  onFail(handler: FailHandler): () => void;
}

interface SuccessMessage {
  readonly type: 'mosaic.bgfetch.success';
  readonly jobId: string;
  readonly urls: string[];
}
interface FailMessage {
  readonly type: 'mosaic.bgfetch.fail';
  readonly jobId: string;
  readonly reason: string;
}

function isSuccessMessage(value: unknown): value is SuccessMessage {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'mosaic.bgfetch.success';
}
function isFailMessage(value: unknown): value is FailMessage {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'mosaic.bgfetch.fail';
}

/** Test seam — replaced in unit tests via `__setBackgroundFetchTestEnv`. */
let env: {
  readonly navigator: { readonly serviceWorker?: ServiceWorkerContainer } | null;
} = {
  get navigator() {
    return typeof navigator === 'undefined' ? null : navigator;
  },
};

/** @internal — for tests only. */
export function __setBackgroundFetchTestEnv(next: typeof env | null): void {
  if (next === null) {
    env = {
      get navigator() {
        return typeof navigator === 'undefined' ? null : navigator;
      },
    };
  } else {
    env = next;
  }
}

export function useBackgroundFetch(): UseBackgroundFetchResult {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const successHandlers = useRef(new Set<SuccessHandler>());
  const failHandlers = useRef(new Set<FailHandler>());

  // Acquire the SW registration once.
  useEffect(() => {
    let cancelled = false;
    const sw = env.navigator?.serviceWorker;
    if (!sw) return;
    sw.ready.then((reg) => {
      if (!cancelled) setRegistration(reg);
    }).catch((err) => {
      log.warn('Service worker not ready', {
        errorName: err instanceof Error ? err.name : 'Unknown',
      });
    });
    return (): void => { cancelled = true; };
  }, []);

  // Listen for SW → page messages and fan out to subscribers.
  useEffect(() => {
    const sw = env.navigator?.serviceWorker;
    if (!sw) return;
    const listener = (event: MessageEvent<unknown>): void => {
      if (isSuccessMessage(event.data)) {
        for (const h of successHandlers.current) {
          try { h(event.data.jobId, event.data.urls); } catch { /* isolate handlers */ }
        }
      } else if (isFailMessage(event.data)) {
        for (const h of failHandlers.current) {
          try { h(event.data.jobId, event.data.reason); } catch { /* isolate */ }
        }
      }
    };
    sw.addEventListener('message', listener);
    return (): void => { sw.removeEventListener('message', listener); };
  }, []);

  const support = useMemo<BackgroundFetchSupport>(() => {
    const supported = registration !== null
      && typeof registration.backgroundFetch !== 'undefined';
    return { supported, registration };
  }, [registration]);

  return useMemo<UseBackgroundFetchResult>(() => ({
    support,
    async start(urls: string[], options: BackgroundFetchHookOptions): Promise<BackgroundFetchHandle> {
      if (!support.supported || !support.registration?.backgroundFetch) {
        throw new Error('Background Fetch is not supported on this browser');
      }
      if (urls.length === 0) {
        throw new Error('Background Fetch requires at least one URL');
      }
      const fetchOptions: BackgroundFetchOptions = {
        title: options.title,
        ...(options.icons ? { icons: options.icons } : {}),
        ...(options.downloadTotal !== undefined ? { downloadTotal: options.downloadTotal } : {}),
      };
      const reg = await support.registration.backgroundFetch.fetch(
        options.id,
        urls,
        fetchOptions,
      );
      return {
        id: reg.id,
        abort: () => reg.abort(),
      };
    },
    onSuccess(handler: SuccessHandler): () => void {
      successHandlers.current.add(handler);
      return (): void => { successHandlers.current.delete(handler); };
    },
    onFail(handler: FailHandler): () => void {
      failHandlers.current.add(handler);
      return (): void => { failHandlers.current.delete(handler); };
    },
  }), [support]);
}