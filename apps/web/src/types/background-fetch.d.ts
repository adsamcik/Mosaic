/**
 * Ambient types for the Background Fetch API (Chromium-only).
 * See https://wicg.github.io/background-fetch/.
 *
 * The TypeScript DOM lib does not yet ship these, so we declare the narrow
 * subset Mosaic uses. Kept here (not in the SW file) so both window-side
 * (`useBackgroundFetch`) and SW-side code share one source of truth.
 */

export {};

declare global {
  interface ImageResource {
    src: string;
    sizes?: string;
    type?: string;
    label?: string;
    purpose?: string;
  }

  interface BackgroundFetchOptions {
    icons?: ImageResource[];
    title?: string;
    downloadTotal?: number;
  }

  interface BackgroundFetchUIOptions {
    icons?: ImageResource[];
    title?: string;
  }

  interface BackgroundFetchRecord {
    readonly request: Request;
    readonly responseReady: Promise<Response>;
  }

  interface BackgroundFetchRegistration extends EventTarget {
    readonly id: string;
    readonly uploadTotal: number;
    readonly uploaded: number;
    readonly downloadTotal: number;
    readonly downloaded: number;
    readonly result: '' | 'success' | 'failure';
    readonly failureReason:
      | ''
      | 'aborted'
      | 'bad-status'
      | 'fetch-error'
      | 'quota-exceeded'
      | 'download-total-exceeded';
    readonly recordsAvailable: boolean;
    abort(): Promise<boolean>;
    match(request: RequestInfo): Promise<BackgroundFetchRecord | undefined>;
    matchAll(request?: RequestInfo): Promise<BackgroundFetchRecord[]>;
  }

  interface BackgroundFetchManager {
    fetch(
      id: string,
      requests: RequestInfo | RequestInfo[],
      options?: BackgroundFetchOptions,
    ): Promise<BackgroundFetchRegistration>;
    get(id: string): Promise<BackgroundFetchRegistration | undefined>;
    getIds(): Promise<string[]>;
  }

  interface ServiceWorkerRegistration {
    readonly backgroundFetch?: BackgroundFetchManager;
  }

  interface BackgroundFetchEvent extends ExtendableEvent {
    readonly registration: BackgroundFetchRegistration;
  }

  interface BackgroundFetchUpdateUIEvent extends BackgroundFetchEvent {
    updateUI(options: BackgroundFetchUIOptions): Promise<void>;
  }

  interface ServiceWorkerGlobalScopeEventMap {
    backgroundfetchsuccess: BackgroundFetchUpdateUIEvent;
    backgroundfetchfail: BackgroundFetchUpdateUIEvent;
    backgroundfetchabort: BackgroundFetchEvent;
    backgroundfetchclick: BackgroundFetchEvent;
  }
}