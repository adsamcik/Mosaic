import { describe, expect, it, vi } from 'vitest';
import {
  deriveSidecarRoomId,
  openSidecarSignalingChannel,
} from '../signaling';

/**
 * Minimal WebSocket double matching the WHATWG surface used by signaling.ts.
 * Tests can drive both directions by calling the helpers below.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: ArrayBuffer[] = [];
  closeCode?: number;
  closeReason?: string;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === 'string') throw new Error('test fake: text frames not supported');
    if (data instanceof ArrayBuffer) {
      this.sent.push(data);
    } else {
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.sent.push(copy);
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => {
      this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true } as CloseEvent);
    });
  }

  // Helpers driven from tests.
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }
  fireMessage(data: ArrayBuffer | string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  fireClose(code: number, reason = '', wasClean = false): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

const ROOM = '0123456789abcdef0123456789abcdef'; // 32 hex chars

function makeChannel(opts: Partial<Parameters<typeof openSidecarSignalingChannel>[1]> = {}) {
  FakeWebSocket.instances = [];
  return openSidecarSignalingChannel(ROOM, {
    baseUrl: 'https://example.test',
    webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    initialBackoffMs: 5,
    maxReconnectAttempts: 1,
    ...opts,
  });
}

describe('deriveSidecarRoomId', () => {
  it('produces a 32-char hex room id', async () => {
    const msg1 = new Uint8Array(64);
    msg1.fill(7);
    const id = await deriveSidecarRoomId(msg1);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for identical inputs', async () => {
    const msg1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = await deriveSidecarRoomId(msg1);
    const b = await deriveSidecarRoomId(msg1);
    expect(a).toBe(b);
  });

  it('differs for different inputs (sanity, not full collision proof)', async () => {
    const a = await deriveSidecarRoomId(new Uint8Array([1, 2, 3]));
    const b = await deriveSidecarRoomId(new Uint8Array([4, 5, 6]));
    expect(a).not.toBe(b);
  });

  it('rejects empty input', async () => {
    await expect(deriveSidecarRoomId(new Uint8Array())).rejects.toThrow(TypeError);
  });
});

describe('openSidecarSignalingChannel', () => {
  it('rejects malformed room ids', () => {
    expect(() =>
      openSidecarSignalingChannel('NOT-HEX', {
        baseUrl: 'https://example.test',
        webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      }),
    ).toThrow(TypeError);
  });

  it('builds a wss:// URL from an https origin', () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe(`wss://example.test/api/sidecar/signal/${ROOM}`);
    ch.close();
  });

  it('sends a binary frame after open', async () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    await ch.send(payload);
    expect(ws.sent).toHaveLength(1);
    expect(new Uint8Array(ws.sent[0])).toEqual(payload);
    ch.close();
  });

  it('rejects oversize outbound frames', async () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    const huge = new Uint8Array(8 * 1024 + 1);
    await expect(ch.send(huge)).rejects.toThrow(RangeError);
    ch.close();
  });

  it('rejects empty outbound frames', async () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    await expect(ch.send(new Uint8Array())).rejects.toThrow(RangeError);
    ch.close();
  });

  it('emits inbound binary frames verbatim', () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    const received: Uint8Array[] = [];
    ch.onFrame((f) => received.push(f));
    ws.fireOpen();

    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([9, 8, 7, 6]);
    ws.fireMessage(buf);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([9, 8, 7, 6]);
    ch.close();
  });

  it('closes when an inbound frame exceeds the size cap', () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    const errors: Error[] = [];
    ch.onError((e) => errors.push(e));
    ws.fireMessage(new ArrayBuffer(8 * 1024 + 1));
    expect(errors.length).toBeGreaterThan(0);
    expect(ws.closeCode).toBe(1009);
  });

  it('reconnects ONCE on a transient drop and stops after the cap', async () => {
    const ch = makeChannel({ maxReconnectAttempts: 1 });
    const ws1 = FakeWebSocket.instances[0];
    ws1.fireOpen();
    expect(ch.state).toBe('open');

    // Simulate a non-clean drop (1006 abnormal closure).
    ws1.fireClose(1006, 'lost', false);
    expect(ch.state).toBe('reconnecting');

    // Advance past the backoff.
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWebSocket.instances.length).toBe(2);
    const ws2 = FakeWebSocket.instances[1];
    ws2.fireOpen();
    expect(ch.state).toBe('open');

    // Second drop: now we've exhausted the budget.
    ws2.fireClose(1006, 'lost-again', false);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWebSocket.instances.length).toBe(2); // no third attempt
    expect(ch.state).toBe('closed');
  });

  it('does not reconnect on policy-violation closes', async () => {
    const ch = makeChannel({ maxReconnectAttempts: 3 });
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    ws.fireClose(1008, 'policy', false);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(ch.state).toBe('closed');
  });

  it('emits onClose exactly once', () => {
    const ch = makeChannel();
    const ws = FakeWebSocket.instances[0];
    ws.fireOpen();
    const closes: Array<{ code: number; reason: string; clean: boolean }> = [];
    ch.onClose((info) => closes.push(info));
    ch.close(1000, 'done');
    ch.close(); // idempotent
    expect(closes.length).toBe(1);
    expect(closes[0].code).toBe(1000);
  });
});
