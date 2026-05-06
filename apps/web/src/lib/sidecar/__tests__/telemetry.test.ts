import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SidecarTelemetryCollector,
  bucketBytes,
  bucketDuration,
  bucketPhotoCount,
  bucketThroughput,
  type SidecarTelemetryEvent,
  type SidecarTelemetrySink,
} from '../telemetry';
import { __setFeatureFlagForTests, __resetFeatureFlagsForTests } from '../../feature-flags';

function mkSink(): { sink: SidecarTelemetrySink; flushed: SidecarTelemetryEvent[][]; failNext: { value: boolean } } {
  const flushed: SidecarTelemetryEvent[][] = [];
  const failNext = { value: false };
  return {
    flushed,
    failNext,
    sink: {
      async flush(events) {
        if (failNext.value) { failNext.value = false; throw new Error('net'); }
        flushed.push(events.map((e) => ({ ...e })));
      },
    },
  };
}

beforeEach(() => {
  __setFeatureFlagForTests('sidecar', true);
  __setFeatureFlagForTests('sidecarTelemetry', true);
});
afterEach(() => {
  __resetFeatureFlagsForTests();
});

describe('bucketing helpers', () => {
  it('photoCount boundaries', () => {
    expect(bucketPhotoCount(0)).toBe('<10');
    expect(bucketPhotoCount(9)).toBe('<10');
    expect(bucketPhotoCount(10)).toBe('10-50');
    expect(bucketPhotoCount(49)).toBe('10-50');
    expect(bucketPhotoCount(50)).toBe('50-200');
    expect(bucketPhotoCount(199)).toBe('50-200');
    expect(bucketPhotoCount(200)).toBe('200+');
    expect(bucketPhotoCount(10000)).toBe('200+');
    expect(bucketPhotoCount(-1)).toBe('<10');
    expect(bucketPhotoCount(Number.NaN)).toBe('<10');
  });
  it('bytes boundaries', () => {
    const MB = 1024 * 1024, GB = 1024 * MB;
    expect(bucketBytes(0)).toBe('small');
    expect(bucketBytes(50 * MB - 1)).toBe('small');
    expect(bucketBytes(50 * MB)).toBe('medium');
    expect(bucketBytes(500 * MB - 1)).toBe('medium');
    expect(bucketBytes(500 * MB)).toBe('large');
    expect(bucketBytes(5 * GB - 1)).toBe('large');
    expect(bucketBytes(5 * GB)).toBe('xlarge');
  });
  it('throughput boundaries', () => {
    const MB = 1024 * 1024;
    expect(bucketThroughput(0)).toBe('slow');
    expect(bucketThroughput(MB - 1)).toBe('slow');
    expect(bucketThroughput(MB)).toBe('medium');
    expect(bucketThroughput(10 * MB - 1)).toBe('medium');
    expect(bucketThroughput(10 * MB)).toBe('fast');
  });
  it('duration boundaries', () => {
    expect(bucketDuration(0)).toBe('short');
    expect(bucketDuration(29999)).toBe('short');
    expect(bucketDuration(30000)).toBe('medium');
    expect(bucketDuration(5 * 60000 - 1)).toBe('medium');
    expect(bucketDuration(5 * 60000)).toBe('long');
  });
});

describe('SidecarTelemetryCollector', () => {
  it('is a no-op when sidecar flag is off', () => {
    __setFeatureFlagForTests('sidecar', false);
    const { sink, flushed } = mkSink();
    const c = new SidecarTelemetryCollector({ sink, maxBatchSize: 1 });
    c.record({ event: 'pair-initiated' });
    expect(c._peekBuffer()).toHaveLength(0);
    expect(flushed).toHaveLength(0);
  });

  it('is a no-op when telemetry flag is off', () => {
    __setFeatureFlagForTests('sidecarTelemetry', false);
    const { sink, flushed } = mkSink();
    const c = new SidecarTelemetryCollector({ sink, maxBatchSize: 1 });
    c.record({ event: 'pair-initiated' });
    expect(c._peekBuffer()).toHaveLength(0);
    expect(flushed).toHaveLength(0);
  });

  it('batches events and flushes on size cap', async () => {
    const { sink, flushed } = mkSink();
    const c = new SidecarTelemetryCollector({ sink, maxBatchSize: 3 });
    c.record({ event: 'pair-initiated' });
    c.record({ event: 'pair-completed' });
    expect(c._peekBuffer()).toHaveLength(2);
    expect(flushed).toHaveLength(0);
    c.record({ event: 'session-completed', durationBucket: 'short' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
  });

  it('rejects events with invalid event name', () => {
    const { sink } = mkSink();
    const c = new SidecarTelemetryCollector({ sink });
    c.record({ event: 'evil' as unknown as 'pair-initiated' });
    expect(c._peekBuffer()).toHaveLength(0);
  });

  it('strips unknown properties', () => {
    const { sink } = mkSink();
    const c = new SidecarTelemetryCollector({ sink });
    const evil = {
      event: 'pair-completed',
      roomId: 'deadbeef'.repeat(4),
      code: '123456',
      msg1: new Uint8Array([1, 2, 3]),
      sessionId: 'leak',
      bytes: 12345,
    } as unknown as SidecarTelemetryEvent;
    c.record(evil);
    const buf = c._peekBuffer();
    expect(buf).toHaveLength(1);
    expect(Object.keys(buf[0]!).sort()).toEqual(['event']);
  });

  it('strips invalid bucket values', () => {
    const { sink } = mkSink();
    const c = new SidecarTelemetryCollector({ sink });
    c.record({
      event: 'session-completed',
      bytesBucket: 'huge' as unknown as 'small',
      throughputBucket: 'snail' as unknown as 'slow',
    });
    expect(c._peekBuffer()[0]).toEqual({ event: 'session-completed' });
  });

  it('preserves all valid optional fields', () => {
    const { sink } = mkSink();
    const c = new SidecarTelemetryCollector({ sink });
    c.record({
      event: 'session-completed',
      errCode: 'WrongCode',
      turnUsed: true,
      photoCountBucket: '50-200',
      bytesBucket: 'large',
      throughputBucket: 'fast',
      durationBucket: 'medium',
    });
    expect(c._peekBuffer()[0]).toEqual({
      event: 'session-completed',
      errCode: 'WrongCode',
      turnUsed: true,
      photoCountBucket: '50-200',
      bytesBucket: 'large',
      throughputBucket: 'fast',
      durationBucket: 'medium',
    });
  });

  it('ZK-safe: random opaque bytes never reach the sink', async () => {
    const { sink, flushed } = mkSink();
    const c = new SidecarTelemetryCollector({ sink, maxBatchSize: 1 });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const secretHex = Array.from(secret).map((b) => b.toString(16).padStart(2, '0')).join('');
    c.record({
      event: 'pair-failed',
      errCode: 'IceFailed',
      ...({ roomId: secretHex, code: '654321', msg1: secret, sessionId: secretHex } as object),
    } as SidecarTelemetryEvent);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const json = JSON.stringify(flushed[0]);
    expect(json.includes(secretHex)).toBe(false);
    expect(json.includes('654321')).toBe(false);
    expect(json.includes('roomId')).toBe(false);
    expect(json.includes('msg1')).toBe(false);
    expect(json.includes('sessionId')).toBe(false);
  });

  it('flushes periodically via the timer', async () => {
    const { sink, flushed } = mkSink();
    let timerCb: (() => void) | null = null;
    const c = new SidecarTelemetryCollector({
      sink,
      flushIntervalMs: 1000,
      setIntervalImpl: (cb): unknown => { timerCb = cb; return 1; },
      clearIntervalImpl: (): void => { timerCb = null; },
    });
    c.record({ event: 'pair-initiated' });
    expect(timerCb).not.toBeNull();
    timerCb!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toHaveLength(1);
    c.dispose();
    expect(timerCb).toBeNull();
  });

  it('swallows sink errors without raising', async () => {
    const { sink, flushed, failNext } = mkSink();
    const c = new SidecarTelemetryCollector({ sink, maxBatchSize: 1 });
    failNext.value = true;
    c.record({ event: 'pair-failed', errCode: 'NetworkError' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toHaveLength(0);
    c.record({ event: 'pair-completed' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toHaveLength(1);
  });

  it('dispose stops accepting events', () => {
    const { sink } = mkSink();
    const c = new SidecarTelemetryCollector({ sink });
    c.dispose();
    c.record({ event: 'pair-initiated' });
    expect(c._peekBuffer()).toHaveLength(0);
  });
});

describe('default fetch sink', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let posted: { url: string; body: string } | null = null;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    posted = null;
    (globalThis as { navigator?: unknown }).navigator = {} as Navigator;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = { url: String(input), body: String(init?.body ?? '') };
      return new Response('', { status: 204 });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });
  it('POSTs JSON envelope to default endpoint', async () => {
    const c = new SidecarTelemetryCollector({ maxBatchSize: 1 });
    c.record({ event: 'pair-initiated' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).not.toBeNull();
    expect(posted!.url).toContain('/api/sidecar/telemetry/v1');
    const parsed = JSON.parse(posted!.body) as { events: SidecarTelemetryEvent[] };
    expect(parsed.events).toEqual([{ event: 'pair-initiated' }]);
  });
});