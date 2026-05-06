import { describe, expect, it } from 'vitest';
import { pairSidecar } from '../pairing';
import { DATA_CHANNEL_LABEL } from '../peer';
import { chunkPhoto } from '../chunker';
import { encodeFrame, decodeFrame } from '../framing';
import { createSidecarReceiveSink } from '../sink';
import type { PerFileSaveTarget } from '../../save-target';
import type { SidecarSignalingChannel } from '../signaling';
import type { SidecarTunnel } from '../../../workers/rust-crypto-core';

// Goal: pair two PairingResults in-process, pipe a synthetic photo from one to
// the other, and assert byte-equality on the receive side.

function ascii(s: string): Uint8Array { return new TextEncoder().encode(s); }

// Same fakes as pairing.test.ts but trimmed for this scenario.
function makeRelay() {
  const aH = new Set<(b: Uint8Array) => void>();
  const bH = new Set<(b: Uint8Array) => void>();
  function ch(side: 'A' | 'B'): SidecarSignalingChannel {
    const my = side === 'A' ? aH : bH;
    const peer = side === 'A' ? bH : aH;
    return {
      state: 'open',
      async send(f) {
        const c = new Uint8Array(f.byteLength); c.set(f);
        setTimeout(() => { for (const h of peer) h(c); }, 0);
      },
      onFrame(h) { my.add(h); return () => my.delete(h); },
      onClose() { return () => {}; },
      onError() { return () => {}; },
      close() {},
    };
  }
  return { ch };
}

function makeTunnel(): SidecarTunnel {
  return {
    send: { async seal(p) { const o = new Uint8Array(p.byteLength + 1); o[0] = 0xAA; o.set(p, 1); return o; } },
    recv: { async open(s) { return s.slice(1); } },
    async close() {},
  };
}

function makeFakePake(_code: Uint8Array) {
  return {
    initiator: async () => ({
      async start() { return { msg1: new Uint8Array([1, 2, 3]) }; },
      async finish() { return { keyMaterialHandle: 1, initiatorConfirm: new Uint8Array([1]) }; },
      async close() {},
    }),
    responder: async () => ({
      async step() { return { msg2: new Uint8Array([4, 5]), responderConfirm: new Uint8Array([6]) }; },
      async finish() { return { keyMaterialHandle: 2 }; },
      async close() {},
    }),
  };
}

class FakeDC {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  paired: FakeDC | null = null;
  closed = false;
  constructor(public label: string) {}
  send(data: ArrayBuffer): void {
    if (this.paired && this.paired.readyState === 'open') {
      this.paired.bufferedAmount += data.byteLength;
      const cp = data.slice(0);
      Promise.resolve().then(() => {
        this.paired!.onmessage?.({ data: cp });
        this.paired!.bufferedAmount = Math.max(0, this.paired!.bufferedAmount - data.byteLength);
      });
    }
  }
  close(): void {
    this.readyState = 'closed';
    this.closed = true;
    this.onclose?.();
    if (this.paired && !this.paired.closed) this.paired.close();
  }
  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

function makePairedRTC() {
  let pendingDC: FakeDC | null = null;
  let pendingB: { ondatachannel: ((ev: { channel: FakeDC }) => void) | null } | null = null;

  const ctorA = class FakePCA {
    iceConnectionState: RTCIceConnectionState = 'new';
    onicecandidate: unknown = null;
    oniceconnectionstatechange: (() => void) | null = null;
    ondatachannel: ((ev: { channel: FakeDC }) => void) | null = null;
    constructor() {}
    createDataChannel(label: string): FakeDC {
      const ch = new FakeDC(label);
      pendingDC = ch;
      if (pendingB && pendingB.ondatachannel) {
        const captured = ch;
        pendingDC = null;
        const channelB = new FakeDC(DATA_CHANNEL_LABEL);
        channelB.paired = captured;
        captured.paired = channelB;
        const cb = pendingB.ondatachannel;
        cb({ channel: channelB });
        setTimeout(() => { captured.open(); channelB.open(); }, 0);
      }
      return ch;
    }
    async createOffer() { return { type: 'offer' as const, sdp: 'fake' }; }
    async createAnswer() { return { type: 'answer' as const, sdp: 'fake' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  } as unknown as typeof RTCPeerConnection;

  const ctorB = class FakePCB {
    iceConnectionState: RTCIceConnectionState = 'new';
    onicecandidate: unknown = null;
    oniceconnectionstatechange: (() => void) | null = null;
    private _ondc: ((ev: { channel: FakeDC }) => void) | null = null;
    constructor() { pendingB = this as unknown as { ondatachannel: ((ev: { channel: FakeDC }) => void) | null }; }
    get ondatachannel() { return this._ondc; }
    set ondatachannel(v: ((ev: { channel: FakeDC }) => void) | null) {
      this._ondc = v;
      if (pendingDC && v) {
        const captured = pendingDC;
        pendingDC = null;
        const channelB = new FakeDC(DATA_CHANNEL_LABEL);
        channelB.paired = captured;
        captured.paired = channelB;
        v({ channel: channelB });
        setTimeout(() => { captured.open(); channelB.open(); }, 0);
      }
    }
    createDataChannel(): FakeDC { return new FakeDC('unused'); }
    async createOffer() { return { type: 'offer' as const, sdp: 'fake' }; }
    async createAnswer() { return { type: 'answer' as const, sdp: 'fake' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  } as unknown as typeof RTCPeerConnection;

  return { ctorA, ctorB };
}

function makeMemoryTarget(): { target: PerFileSaveTarget; saved: Map<string, Uint8Array>; finalized: { value: boolean } } {
  const saved = new Map<string, Uint8Array>();
  const finalized = { value: false };
  return {
    target: {
      async openOne(filename: string, _sizeBytes: number): Promise<WritableStream<Uint8Array>> {
        const parts: Uint8Array[] = [];
        return new WritableStream<Uint8Array>({
          write(c) { const cp = new Uint8Array(c.byteLength); cp.set(c); parts.push(cp); },
          close() {
            const total = parts.reduce((a, b) => a + b.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const p of parts) { out.set(p, off); off += p.byteLength; }
            saved.set(filename, out);
          },
        });
      },
      async finalize() { finalized.value = true; },
      async abort() {},
    },
    saved,
    finalized,
  };
}

function makeStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= data.byteLength) { controller.close(); return; }
      const end = Math.min(off + chunkSize, data.byteLength);
      controller.enqueue(data.slice(off, end));
      off = end;
    },
  });
}

describe('sidecar end-to-end roundtrip', () => {
  it('pairs two clients in-process and round-trips a synthetic photo', async () => {
    const code = ascii('123456');
    const relay = makeRelay();
    const rtc = makePairedRTC();
    const pake = makeFakePake(code);

    const initP = pairSidecar({
      role: 'initiator', code, iceServers: [],
      _overrides: {
        openSignaling: () => relay.ch('A'),
        openPakeInitiator: pake.initiator,
        openPakeResponder: pake.responder,
        openTunnel: async () => makeTunnel(),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorA,
      },
    });
    const respP = pairSidecar({
      role: 'responder', code, msg1: ascii('m1-oob'), iceServers: [],
      _overrides: {
        openSignaling: () => relay.ch('B'),
        openPakeInitiator: pake.initiator,
        openPakeResponder: pake.responder,
        openTunnel: async () => makeTunnel(),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorB,
      },
    });

    const [a, b] = await Promise.all([initP, respP]);

    // Receiver side: decode frames, drive a sink writing to memory.
    const memTarget = makeMemoryTarget();
    const sink = createSidecarReceiveSink({
      saveTarget: memTarget.target,
    });
    let receiveError: unknown = null;
    b.peer.onFrame((sealedFrame) => {
      // The peer wrapper already decrypted via the tunnel; here we get raw payload bytes.
      // BUT: in the real flow data-plane bytes are sealed via tunnel.send.seal() before
      // being put on the wire and tunnel.recv.open()'d on receive. The peer wrapper does
      // NOT auto-seal application bytes — the caller does. So in this integration test we
      // mirror that: chunkPhoto -> encodeFrame -> tunnel.seal -> peer.sendFrame, and on
      // the receive end peer.onFrame -> tunnel.open -> decodeFrame -> sink.process.
      void sealedFrame;
    });

    // Build a 250 KB synthetic photo with a deterministic byte pattern.
    const PHOTO_BYTES = 250 * 1024;
    const photo = new Uint8Array(PHOTO_BYTES);
    for (let i = 0; i < PHOTO_BYTES; i++) photo[i] = (i * 1103515245 + 12345) & 0xff;
    const filename = 'IMG-é-😀.jpg';

    // Wire up the receiver's pipeline: peer.onFrame -> tunnel.recv.open -> decode -> sink.
    // (Re-subscribe; the no-op above was just exposition.)
    const subs: Array<() => void> = [];
    subs.push(b.peer.onFrame(() => {})); // dummy to ensure unsub works
    for (const s of subs) s();
    // Real subscription:
    const realUnsub = b.peer.onFrame((sealedFrame) => {
      void (async () => {
        try {
          const plain = await b.tunnel.recv.open(sealedFrame);
          const frame = decodeFrame(plain);
          await sink.process(frame);
        } catch (e) {
          receiveError = e;
        }
      })();
    });

    // Sender side: chunk the photo, encode each frame, seal, and send.
    const chunkBytes = 64 * 1024 - 32; // mimic per-spec margin computation
    const stream = makeStream(photo, 16 * 1024);
    let lastFramePromise: Promise<void> = Promise.resolve();
    for await (const frame of chunkPhoto(0, filename, BigInt(PHOTO_BYTES), stream, { maxChunkBytes: chunkBytes })) {
      const encoded = encodeFrame(frame);
      const sealed = await a.tunnel.send.seal(encoded);
      lastFramePromise = a.peer.sendFrame(sealed);
      await lastFramePromise;
    }
    // Send SESSION_END.
    {
      const encoded = encodeFrame({ kind: 'sessionEnd' });
      const sealed = await a.tunnel.send.seal(encoded);
      await a.peer.sendFrame(sealed);
    }

    // Drain receive queue: data-channel delivery is microtask-deferred.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (memTarget.finalized.value) break;
    }
    realUnsub();

    expect(receiveError).toBeNull();
    expect(memTarget.finalized.value).toBe(true);
    expect(memTarget.saved.has(filename)).toBe(true);
    const got = memTarget.saved.get(filename)!;
    expect(got.byteLength).toBe(PHOTO_BYTES);
    // Byte-equality: spot-check + full hash via reduce.
    let mismatch = 0;
    for (let i = 0; i < PHOTO_BYTES; i++) if (got[i] !== photo[i]) { mismatch++; break; }
    expect(mismatch).toBe(0);
    // Full equality.
    expect(Buffer.from(got).equals(Buffer.from(photo))).toBe(true);

    await a.close();
    await b.close();
  });
});
