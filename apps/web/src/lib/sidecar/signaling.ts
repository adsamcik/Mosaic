/**
 * Sidecar Beacon — client-side WebSocket signaling wrapper.
 *
 * Talks to the in-memory relay at `WS /api/sidecar/signal/:roomId`. The relay
 * is opaque: it never sees plaintext, only the AEAD-sealed frames produced by
 * the PAKE-derived tunnel. This module enforces:
 *
 *   * binary-only framing (text frames are rejected)
 *   * per-frame size cap matching the server (8 KiB)
 *   * a single transient-reconnect attempt with exponential backoff
 *   * deterministic room-id derivation from PAKE msg1 via HKDF-SHA-256
 *
 * ZK-safe logging policy: never log payload bytes, room ids, or msg1.
 */
const MAX_FRAME_BYTES = 8 * 1024;
const ROOM_ID_LENGTH = 32; // 16-byte HKDF output, hex-encoded
const HKDF_INFO = new TextEncoder().encode('mosaic.sidecar.v1.room');
const HKDF_SALT = new Uint8Array(0); // deliberate: msg1 is high-entropy ikm

export interface SidecarSignalingOptions {
  /** Base URL (e.g., "https://example.com" or "wss://…"). When omitted, derived from window.location. */
  baseUrl?: string;
  /** Maximum reconnect attempts on transient drop (default 2). 0 disables reconnect. */
  maxReconnectAttempts?: number;
  /** Initial reconnect backoff in ms (default 250). Doubles each attempt, capped at 5 s. */
  initialBackoffMs?: number;
  /** Override WebSocket constructor (test injection). */
  webSocketCtor?: typeof WebSocket;
}

export type SidecarSignalingState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface SidecarSignalingChannel {
  readonly state: SidecarSignalingState;
  /** Send a binary frame. Resolves once the buffered amount drops back below the cap. */
  send(frame: Uint8Array): Promise<void>;
  /** Subscribe to incoming frames. Returns an unsubscribe function. */
  onFrame(handler: (frame: Uint8Array) => void): () => void;
  /** Subscribe to terminal close events. */
  onClose(handler: (info: { code: number; reason: string; clean: boolean }) => void): () => void;
  /** Subscribe to errors (transport-level; payload-level errors are surfaced via close). */
  onError(handler: (err: Error) => void): () => void;
  /** Initiate a clean shutdown. Idempotent. */
  close(code?: number, reason?: string): void;
}

/**
 * Derive the 32-hex room id from PAKE msg1 using HKDF-SHA-256. The room id
 * is non-leaky: it is computed from a high-entropy public PAKE message, so
 * the server cannot enumerate pairing codes from it.
 */
export async function deriveSidecarRoomId(msg1: Uint8Array): Promise<string> {
  if (!(msg1 instanceof Uint8Array) || msg1.length === 0) {
    throw new TypeError('deriveSidecarRoomId: msg1 must be a non-empty Uint8Array');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('deriveSidecarRoomId: SubtleCrypto unavailable');
  }
  // Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer / detached-buffer issues.
  const ikm = new Uint8Array(msg1.length);
  ikm.set(msg1);
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    key,
    16 * 8,
  );
  return toHex(new Uint8Array(bits));
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function isValidRoomId(roomId: string): boolean {
  return /^[0-9a-f]{32}$/.test(roomId);
}

function buildSignalingUrl(roomId: string, baseUrl?: string): string {
  if (!isValidRoomId(roomId)) {
    throw new TypeError(`invalid sidecar room id (expected ${ROOM_ID_LENGTH}-char hex)`);
  }
  let origin: string;
  if (baseUrl) {
    origin = baseUrl;
  } else if (typeof globalThis !== 'undefined' && (globalThis as { location?: Location }).location) {
    origin = (globalThis as { location: Location }).location.origin;
  } else {
    throw new Error('sidecar signaling: no baseUrl provided and no window.location');
  }

  // Normalise http(s) → ws(s).
  const url = new URL('/api/sidecar/signal/' + roomId, origin);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

/**
 * Open a signaling channel for the given room id. The returned channel is
 * already connecting; await {@link SidecarSignalingChannel.send} or hook
 * `onFrame` before the first frame to avoid races.
 */
export function openSidecarSignalingChannel(
  roomId: string,
  options: SidecarSignalingOptions = {},
): SidecarSignalingChannel {
  const url = buildSignalingUrl(roomId, options.baseUrl);
  const Ctor = options.webSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error('sidecar signaling: WebSocket is not available in this environment');
  }
  const maxReconnects = options.maxReconnectAttempts ?? 2;
  const initialBackoff = options.initialBackoffMs ?? 250;

  return new SidecarChannel(url, Ctor, maxReconnects, initialBackoff);
}

class SidecarChannel implements SidecarSignalingChannel {
  state: SidecarSignalingState = 'connecting';

  private readonly url: string;
  private readonly Ctor: typeof WebSocket;
  private readonly maxReconnects: number;
  private readonly initialBackoff: number;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  private readonly frameHandlers = new Set<(f: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(info: { code: number; reason: string; clean: boolean }) => void>();
  private readonly errorHandlers = new Set<(e: Error) => void>();

  constructor(url: string, Ctor: typeof WebSocket, maxReconnects: number, initialBackoff: number) {
    this.url = url;
    this.Ctor = Ctor;
    this.maxReconnects = maxReconnects;
    this.initialBackoff = initialBackoff;
    this.connect();
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new this.Ctor(this.url);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      this.finalize(1006, 'connect-failed', false);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      // NOTE: do NOT reset reconnectAttempt on open. The retry budget is a hard cap on total reconnects per channel lifetime.
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        // Text frames are protocol violations on this channel.
        this.emitError(new Error('sidecar: unexpected non-binary frame'));
        this.close(1003, 'binary-only');
        return;
      }
      if (bytes.byteLength > MAX_FRAME_BYTES) {
        this.emitError(new Error('sidecar: inbound frame exceeds size cap'));
        this.close(1009, 'frame-too-large');
        return;
      }
      // Defensive copy so handlers can retain the buffer safely.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      for (const h of this.frameHandlers) {
        try { h(copy); } catch (e) { this.emitError(e instanceof Error ? e : new Error(String(e))); }
      }
    };

    ws.onerror = () => {
      // Browser WebSocket error events carry no detail; surface a generic Error.
      this.emitError(new Error('sidecar: transport error'));
    };

    ws.onclose = (ev) => {
      this.ws = null;
      // Clean closes (code 1000 / 1001 / explicit close()) are terminal.
      // Anything else is a candidate for one reconnect attempt.
      const isTransient = !this.intentionallyClosed
        && ev.code !== 1000
        && ev.code !== 1008 // policy violation: do not retry
        && ev.code !== 1009 // message too big: do not retry
        && this.reconnectAttempt < this.maxReconnects;

      if (isTransient) {
        this.state = 'reconnecting';
        const delay = Math.min(this.initialBackoff * (1 << this.reconnectAttempt), 5000);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.intentionallyClosed) this.connect();
        }, delay);
        return;
      }

      this.finalize(ev.code, ev.reason ?? '', ev.wasClean);
    };
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError('sidecar.send: frame must be a Uint8Array');
    }
    if (frame.byteLength === 0) {
      throw new RangeError('sidecar.send: empty frame');
    }
    if (frame.byteLength > MAX_FRAME_BYTES) {
      throw new RangeError(`sidecar.send: frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    if (this.state === 'closed') {
      throw new Error('sidecar.send: channel is closed');
    }
    // Wait until the underlying socket is open. We don't queue across reconnects:
    // signaling messages are protocol-bound to a specific PAKE/ICE step, so the
    // caller decides whether to resend after a reconnect.
    if (this.state !== 'open' || !this.ws || this.ws.readyState !== this.Ctor.OPEN) {
      await this.waitOpen();
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== this.Ctor.OPEN) {
      throw new Error('sidecar.send: socket not open after wait');
    }
    // Copy into a standalone ArrayBuffer to avoid surprises from views over
    // SharedArrayBuffer or buffers the caller mutates after send().
    const buf = new ArrayBuffer(frame.byteLength);
    new Uint8Array(buf).set(frame);
    ws.send(buf);
  }

  private waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timeoutMs = 10_000;
      const tick = () => {
        if (this.state === 'open' && this.ws && this.ws.readyState === this.Ctor.OPEN) {
          resolve();
        } else if (this.state === 'closed') {
          reject(new Error('sidecar.send: channel closed before open'));
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('sidecar.send: timed out waiting for open'));
        } else {
          setTimeout(tick, 25);
        }
      };
      tick();
    });
  }

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onClose(handler: (info: { code: number; reason: string; clean: boolean }) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  close(code = 1000, reason = 'client-close'): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (ws && (ws.readyState === this.Ctor.OPEN || ws.readyState === this.Ctor.CONNECTING)) {
      try { ws.close(code, reason); } catch { /* ignore */ }
    }
    if (this.state !== 'closed') {
      this.finalize(code, reason, true);
    }
  }

  private finalize(code: number, reason: string, clean: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const info = { code, reason, clean };
    for (const h of this.closeHandlers) {
      try { h(info); } catch { /* swallow */ }
    }
  }

  private emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      try { h(err); } catch { /* swallow */ }
    }
  }
}
