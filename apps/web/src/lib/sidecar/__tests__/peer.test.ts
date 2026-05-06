import { describe, expect, it } from 'vitest';
import { createPeerConnection, HIGH_WATER_MARK_BYTES, LOW_WATER_MARK_BYTES, DATA_CHANNEL_LABEL } from '../peer';
import type { SidecarSignalingChannel } from '../signaling';
import type { SidecarTunnel } from '../../../workers/rust-crypto-core';

// ---- Test doubles -----------------------------------------------------------

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((e?: Event) => void) | null = null;
  onclose: ((e?: Event) => void) | null = null;
  onerror: ((e?: Event) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null = null;
  onbufferedamountlow: ((e?: Event) => void) | null = null;
  sent: ArrayBuffer[] = [];
  closed = false;
  constructor(public label: string) {}
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
    this.closed = true;
    this.onclose?.();
  }
  // Test helpers.
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  fireMessage(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
}

class FakePC {
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  closedCalled = false;
  channels: FakeDataChannel[] = [];
  constructor(public config?: RTCConfiguration) {
    FakePC.instances.push(this);
  }
  static instances: FakePC[] = [];
  createDataChannel(label: string, _init?: RTCDataChannelInit): FakeDataChannel {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer\r\n' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = d;
  }
  async addIceCandidate(_c?: RTCIceCandidateInit): Promise<void> {
    // no-op
  }
  close(): void {
    this.closedCalled = true;
    this.iceConnectionState = 'closed';
    this.oniceconnectionstatechange?.();
  }
  // Test helpers.
  fireIceCandidate(candidate: RTCIceCandidateInit | null): void {
    const c = candidate
      ? ({ toJSON: () => candidate } as unknown as RTCIceCandidate)
      : null;
    this.onicecandidate?.({ candidate: c });
  }
  fireIceState(s: RTCIceConnectionState): void {
    this.iceConnectionState = s;
    this.oniceconnectionstatechange?.();
  }
  receiveDataChannel(label = DATA_CHANNEL_LABEL): FakeDataChannel {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    this.ondatachannel?.({ channel: ch });
    return ch;
  }
}

function makeFakeSignaling(): {
  ch: SidecarSignalingChannel;
  fireIncoming: (b: Uint8Array) => void;
  sent: Uint8Array[];
  unsubCount: { value: number };
} {
  const handlers = new Set<(f: Uint8Array) => void>();
  const sent: Uint8Array[] = [];
  const unsubCount = { value: 0 };
  const ch: SidecarSignalingChannel = {
    state: 'open',
    async send(frame) {
      sent.push(new Uint8Array(frame));
    },
    onFrame(h) {
      handlers.add(h);
      return () => {
        handlers.delete(h);
        unsubCount.value++;
      };
    },
    onClose() { return () => {}; },
    onError() { return () => {}; },
    close() {},
  };
  return {
    ch,
    sent,
    unsubCount,
    fireIncoming: (b) => { for (const h of handlers) h(b); },
  };
}

function makeIdentityTunnel(): SidecarTunnel {
  // Identity "tunnel" — seal/open are no-ops. We tag with a 1-byte prefix so
  // tests can confirm seal was actually called.
  let closed = false;
  return {
    send: {
      async seal(p) {
        if (closed) throw new Error('closed');
        const out = new Uint8Array(p.byteLength + 1);
        out[0] = 0xAA;
        out.set(p, 1);
        return out;
      },
    },
    recv: {
      async open(s) {
        if (closed) throw new Error('closed');
        if (s[0] !== 0xAA) throw new Error('bad seal');
        return s.slice(1);
      },
    },
    async close() { closed = true; },
  };
}

function decodeEnvelope(sealed: Uint8Array): unknown {
  // Strip the 1-byte AA tag and JSON.parse.
  return JSON.parse(new TextDecoder().decode(sealed.slice(1)));
}

function encodeEnvelope(env: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(env));
  const out = new Uint8Array(json.byteLength + 1);
  out[0] = 0xAA;
  out.set(json, 1);
  return out;
}

// ---- Tests ------------------------------------------------------------------

describe('peer (initiator)', () => {
  it('creates an ordered DataChannel and emits sealed SDP offer over signaling', async () => {
    const sig = makeFakeSignaling();
    const tunnel = makeIdentityTunnel();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel,
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    // Wait one microtask cycle so the offer flow runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(sig.sent.length).toBeGreaterThanOrEqual(1);
    const env = decodeEnvelope(sig.sent[0]!) as { type: string; sdp: string };
    expect(env.type).toBe('sdp.offer');
    expect(env.sdp).toContain('fake-offer');

    // Open the data channel; ready() should resolve.
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    pc.channels[0]!.open();
    await peer.ready();

    await peer.close();
  });

  it('forwards ICE candidates as sealed signaling frames', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    pc.fireIceCandidate({ candidate: 'candidate:fake', sdpMid: '0', sdpMLineIndex: 0 });
    pc.fireIceCandidate(null);
    await new Promise((r) => setTimeout(r, 0));
    const types = sig.sent.map((b) => (decodeEnvelope(b) as { type: string }).type);
    expect(types).toContain('ice');
    expect(types).toContain('ice.end');
    await peer.close();
  });

  it('processes inbound sdp.answer by setting remote description', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    sig.fireIncoming(encodeEnvelope({ type: 'sdp.answer', sdp: 'fake-answer' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'fake-answer' });
    await peer.close();
  });
});

describe('peer (responder)', () => {
  it('answers an inbound SDP offer and accepts the data channel', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'responder',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    sig.fireIncoming(encodeEnvelope({ type: 'sdp.offer', sdp: 'fake-offer' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'fake-offer' });
    const answerEnv = sig.sent.map((b) => decodeEnvelope(b) as { type: string }).find((e) => e.type === 'sdp.answer');
    expect(answerEnv).toBeDefined();

    const ch = pc.receiveDataChannel();
    ch.open();
    await peer.ready();
    await peer.close();
  });
});

describe('peer (data plane)', () => {
  it('sendFrame writes to the data channel', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    const ch = pc.channels[0]!;
    ch.open();
    await peer.ready();
    await peer.sendFrame(new Uint8Array([1, 2, 3]));
    expect(ch.sent.length).toBe(1);
    expect(Array.from(new Uint8Array(ch.sent[0]!))).toEqual([1, 2, 3]);
    await peer.close();
  });

  it('onFrame fires defensively-copied bytes on inbound DC messages', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    const ch = pc.channels[0]!;
    ch.open();
    await peer.ready();
    const received: Uint8Array[] = [];
    peer.onFrame((b) => received.push(b));
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([9, 8, 7, 6]);
    ch.fireMessage(buf);
    // Mutate source after fire; copy must be detached.
    new Uint8Array(buf).fill(0);
    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual([9, 8, 7, 6]);
    await peer.close();
  });

  it('backpressure: sendFrame pauses when bufferedAmount > HIGH and resumes on bufferedamountlow', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    const ch = pc.channels[0]!;
    ch.open();
    await peer.ready();
    // Confirm low-water-mark threshold was set.
    expect(ch.bufferedAmountLowThreshold).toBe(LOW_WATER_MARK_BYTES);
    ch.bufferedAmount = HIGH_WATER_MARK_BYTES + 1;
    let resolved = false;
    const p = peer.sendFrame(new Uint8Array([1])).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(ch.sent.length).toBe(0);
    // Drain.
    ch.bufferedAmount = 0;
    ch.onbufferedamountlow?.();
    await p;
    expect(resolved).toBe(true);
    expect(ch.sent.length).toBe(1);
    await peer.close();
  });
});

describe('peer lifecycle', () => {
  it('close is idempotent and unsubscribes the signaling listener', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    await peer.close();
    await peer.close();
    expect(sig.unsubCount.value).toBe(1);
    expect(pc.closedCalled).toBe(true);
  });

  it('emits failed state on ICE failure', async () => {
    const sig = makeFakeSignaling();
    const states: string[] = [];
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    peer.onState((s) => states.push(s));
    // Observe the ready() rejection so it doesn't show as unhandled.
    peer.ready().catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const pc = FakePC.instances[FakePC.instances.length - 1]!;
    pc.fireIceState('failed');
    expect(states).toContain('failed');
    await peer.close();
  });

  it('sendFrame after close throws', async () => {
    const sig = makeFakeSignaling();
    const peer = createPeerConnection({
      iceServers: [],
      signaling: sig.ch,
      tunnel: makeIdentityTunnel(),
      role: 'initiator',
      rtcPeerConnectionCtor: FakePC as unknown as typeof RTCPeerConnection,
    });
    await new Promise((r) => setTimeout(r, 0));
    await peer.close();
    await expect(peer.sendFrame(new Uint8Array([1]))).rejects.toThrow(/after close/);
  });
});

