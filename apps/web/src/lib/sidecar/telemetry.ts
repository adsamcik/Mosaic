/**
 * Sidecar Beacon — ZK-safe telemetry collector.
 *
 * Constraint inventory (per SPIKE-sidecar-beacon.md §7):
 *   * NO per-session ids, NO room ids, NO codes, NO bytes, NO timestamps
 *     beyond bucketed durations.
 *   * Continuous numeric values are ALWAYS bucketed before they leave the
 *     module — the public `record()` API only accepts pre-bucketed shapes.
 *   * Events are batched in memory and flushed periodically to
 *     `POST /api/sidecar/telemetry/v1`. A best-effort flush is also
 *     attempted on `pagehide` / `beforeunload`.
 *
 * Telemetry is gated by TWO independent flags so devs can disable it
 * without disabling the feature:
 *   * `featureFlags.sidecar` — gates the feature itself
 *   * `featureFlags.sidecarTelemetry` — gates this collector
 *
 * The collector is a no-op when either flag is off.
 */

import { getFeatureFlag } from '../feature-flags';

export type SidecarTelemetryEventName =
  | 'pair-initiated'
  | 'pair-completed'
  | 'pair-aborted'
  | 'pair-failed'
  | 'session-completed'
  | 'session-aborted'
  | 'session-disconnected';

export type SidecarErrCode =
  | 'WrongCode'
  | 'SignalingTimeout'
  | 'IceFailed'
  | 'Aborted'
  | 'NetworkError'
  | 'Unknown';

export type SidecarBytesBucket = 'small' | 'medium' | 'large' | 'xlarge';
export type SidecarThroughputBucket = 'slow' | 'medium' | 'fast';
export type SidecarDurationBucket = 'short' | 'medium' | 'long';
export type SidecarPhotoCountBucket = '<10' | '10-50' | '50-200' | '200+';

/**
 * Public envelope shape. The fields are exhaustively listed so reviewers can
 * see at a glance that nothing pseudonymous (room id, code, msg1, sessionId)
 * is present. Any future addition MUST be a coarse enum, never a continuous
 * value or an identifier.
 */
export interface SidecarTelemetryEvent {
  readonly event: SidecarTelemetryEventName;
  readonly errCode?: SidecarErrCode;
  readonly turnUsed?: boolean;
  readonly photoCountBucket?: SidecarPhotoCountBucket;
  readonly bytesBucket?: SidecarBytesBucket;
  readonly throughputBucket?: SidecarThroughputBucket;
  readonly durationBucket?: SidecarDurationBucket;
}

// ----- Bucketing helpers (exported for test parity assertions) -----

export function bucketPhotoCount(n: number): SidecarPhotoCountBucket {
  if (!Number.isFinite(n) || n < 0) return '<10';
  if (n < 10) return '<10';
  if (n < 50) return '10-50';
  if (n < 200) return '50-200';
  return '200+';
}

/** Bytes -> coarse bucket. Boundaries: <50 MB / <500 MB / <5 GB / >=5 GB. */
export function bucketBytes(n: number): SidecarBytesBucket {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  if (!Number.isFinite(n) || n < 0) return 'small';
  if (n < 50 * MB) return 'small';
  if (n < 500 * MB) return 'medium';
  if (n < 5 * GB) return 'large';
  return 'xlarge';
}

/** Throughput in bytes/sec -> coarse bucket. Boundaries: <1 MB/s / <10 MB/s / >=10 MB/s. */
export function bucketThroughput(bytesPerSec: number): SidecarThroughputBucket {
  const MB = 1024 * 1024;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return 'slow';
  if (bytesPerSec < 1 * MB) return 'slow';
  if (bytesPerSec < 10 * MB) return 'medium';
  return 'fast';
}

/** Duration in milliseconds -> coarse bucket. Boundaries: <30 s / <5 min / >=5 min. */
export function bucketDuration(ms: number): SidecarDurationBucket {
  if (!Number.isFinite(ms) || ms < 0) return 'short';
  if (ms < 30_000) return 'short';
  if (ms < 5 * 60_000) return 'medium';
  return 'long';
}

// ----- Collector --------------------------------------------------------

export interface SidecarTelemetrySink {
  /**
   * Send a batch. MUST resolve only after the network roundtrip (or the
   * implementation has handed off to navigator.sendBeacon). Failures are
   * swallowed by the collector.
   */
  flush(events: readonly SidecarTelemetryEvent[]): Promise<void>;
}

export interface SidecarTelemetryCollectorOptions {
  /** Endpoint URL. Defaults to `/api/sidecar/telemetry/v1`. */
  readonly endpoint?: string;
  /** Flush interval in ms. Defaults to 5 minutes. */
  readonly flushIntervalMs?: number;
  /** Maximum batch size before forced flush. Defaults to 64. */
  readonly maxBatchSize?: number;
  /** Test/DI override for the network sink. */
  readonly sink?: SidecarTelemetrySink;
  /** Test/DI override for the feature-flag check. */
  readonly enabled?: () => boolean;
  /** Test/DI override for setInterval. */
  readonly setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  /** Test/DI override for clearInterval. */
  readonly clearIntervalImpl?: (handle: unknown) => void;
}

const DEFAULT_FLUSH_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BATCH = 64;

export class SidecarTelemetryCollector {
  private readonly opts: Required<Omit<SidecarTelemetryCollectorOptions, 'sink' | 'enabled' | 'setIntervalImpl' | 'clearIntervalImpl'>> & {
    readonly sink: SidecarTelemetrySink;
    readonly enabled: () => boolean;
    readonly setIntervalImpl: (cb: () => void, ms: number) => unknown;
    readonly clearIntervalImpl: (handle: unknown) => void;
  };
  private buffer: SidecarTelemetryEvent[] = [];
  private intervalHandle: unknown = null;
  private disposed = false;

  constructor(opts: SidecarTelemetryCollectorOptions = {}) {
    const endpoint = opts.endpoint ?? '/api/sidecar/telemetry/v1';
    const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH;
    const sink = opts.sink ?? makeFetchSink(endpoint);
    const enabled = opts.enabled ?? defaultEnabled;
    const setIntervalImpl =
      opts.setIntervalImpl ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    const clearIntervalImpl =
      opts.clearIntervalImpl ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
    this.opts = { endpoint, flushIntervalMs, maxBatchSize, sink, enabled, setIntervalImpl, clearIntervalImpl };
  }

  /**
   * Record one event. Sanitises the input shape — any unknown property is
   * dropped, ensuring callers cannot accidentally smuggle a roomId / code /
   * msg1 / sessionId / raw byte count through the public surface.
   */
  record(event: SidecarTelemetryEvent): void {
    if (this.disposed) return;
    if (!this.opts.enabled()) return;
    const sanitized = sanitizeEvent(event);
    if (!sanitized) return;
    this.buffer.push(sanitized);
    this.startTimerIfNeeded();
    if (this.buffer.length >= this.opts.maxBatchSize) {
      void this.flushNow();
    }
  }

  /** Flush all buffered events immediately. */
  async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.opts.sink.flush(batch);
    } catch {
      // Telemetry must never crash the app. Drop batch on failure.
    }
  }

  /** Stop the periodic timer; final flush is the caller's job. */
  dispose(): void {
    this.disposed = true;
    if (this.intervalHandle != null) {
      this.opts.clearIntervalImpl(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Test-only: read buffered events without flushing. */
  _peekBuffer(): readonly SidecarTelemetryEvent[] {
    return this.buffer.slice();
  }

  private startTimerIfNeeded(): void {
    if (this.intervalHandle != null) return;
    this.intervalHandle = this.opts.setIntervalImpl(() => {
      void this.flushNow();
    }, this.opts.flushIntervalMs);
  }
}

// ----- Module-level singleton (lazy) ------------------------------------

let singleton: SidecarTelemetryCollector | null = null;

export function getSidecarTelemetry(): SidecarTelemetryCollector {
  if (!singleton) singleton = new SidecarTelemetryCollector();
  return singleton;
}

/** Test-only: replace the singleton with a fresh instance. */
export function __setSidecarTelemetryForTests(collector: SidecarTelemetryCollector | null): void {
  singleton = collector;
}

// ----- Internals --------------------------------------------------------

function defaultEnabled(): boolean {
  return getFeatureFlag('sidecar') && getFeatureFlag('sidecarTelemetry');
}

/**
 * Strip any unrecognised properties. The output is a fresh object — never the
 * caller's reference, so accidental retention of large payloads is impossible.
 */
function sanitizeEvent(e: SidecarTelemetryEvent): SidecarTelemetryEvent | null {
  if (!isValidEventName(e.event)) return null;
  const out: { -readonly [K in keyof SidecarTelemetryEvent]: SidecarTelemetryEvent[K] } = { event: e.event };
  if (e.errCode !== undefined && isValidErrCode(e.errCode)) out.errCode = e.errCode;
  if (typeof e.turnUsed === 'boolean') out.turnUsed = e.turnUsed;
  if (e.photoCountBucket !== undefined && isValidPhotoCountBucket(e.photoCountBucket)) out.photoCountBucket = e.photoCountBucket;
  if (e.bytesBucket !== undefined && isValidBytesBucket(e.bytesBucket)) out.bytesBucket = e.bytesBucket;
  if (e.throughputBucket !== undefined && isValidThroughputBucket(e.throughputBucket)) out.throughputBucket = e.throughputBucket;
  if (e.durationBucket !== undefined && isValidDurationBucket(e.durationBucket)) out.durationBucket = e.durationBucket;
  return out;
}

const EVENT_NAMES: ReadonlySet<SidecarTelemetryEventName> = new Set<SidecarTelemetryEventName>([
  'pair-initiated', 'pair-completed', 'pair-aborted', 'pair-failed',
  'session-completed', 'session-aborted', 'session-disconnected',
]);
const ERR_CODES: ReadonlySet<SidecarErrCode> = new Set<SidecarErrCode>([
  'WrongCode', 'SignalingTimeout', 'IceFailed', 'Aborted', 'NetworkError', 'Unknown',
]);
const PHOTO_BUCKETS: ReadonlySet<SidecarPhotoCountBucket> = new Set<SidecarPhotoCountBucket>(['<10', '10-50', '50-200', '200+']);
const BYTES_BUCKETS: ReadonlySet<SidecarBytesBucket> = new Set<SidecarBytesBucket>(['small', 'medium', 'large', 'xlarge']);
const THROUGHPUT_BUCKETS: ReadonlySet<SidecarThroughputBucket> = new Set<SidecarThroughputBucket>(['slow', 'medium', 'fast']);
const DURATION_BUCKETS: ReadonlySet<SidecarDurationBucket> = new Set<SidecarDurationBucket>(['short', 'medium', 'long']);

function isValidEventName(v: unknown): v is SidecarTelemetryEventName { return typeof v === 'string' && EVENT_NAMES.has(v as SidecarTelemetryEventName); }
function isValidErrCode(v: unknown): v is SidecarErrCode { return typeof v === 'string' && ERR_CODES.has(v as SidecarErrCode); }
function isValidPhotoCountBucket(v: unknown): v is SidecarPhotoCountBucket { return typeof v === 'string' && PHOTO_BUCKETS.has(v as SidecarPhotoCountBucket); }
function isValidBytesBucket(v: unknown): v is SidecarBytesBucket { return typeof v === 'string' && BYTES_BUCKETS.has(v as SidecarBytesBucket); }
function isValidThroughputBucket(v: unknown): v is SidecarThroughputBucket { return typeof v === 'string' && THROUGHPUT_BUCKETS.has(v as SidecarThroughputBucket); }
function isValidDurationBucket(v: unknown): v is SidecarDurationBucket { return typeof v === 'string' && DURATION_BUCKETS.has(v as SidecarDurationBucket); }

/**
 * Default sink: POST a JSON envelope `{ events: [...] }`. Uses
 * `navigator.sendBeacon` when available so unload-time flushes survive
 * tab close.
 */
function makeFetchSink(endpoint: string): SidecarTelemetrySink {
  return {
    async flush(events): Promise<void> {
      const body = JSON.stringify({ events });
      // Prefer sendBeacon for resilience across page unloads.
      const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: BodyInit) => boolean } }).navigator;
      if (nav?.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        const ok = nav.sendBeacon(endpoint, blob);
        if (ok) return;
      }
      // Fallback to fetch with keepalive; ignore network failures.
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        });
      } catch {
        // swallow
      }
    },
  };
}
