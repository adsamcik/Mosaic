import { describe, expect, it } from 'vitest';
import { pairSidecar, PairingError } from '../pairing';
import type { SidecarSignalingChannel } from '../signaling';
import type {
  SidecarPakeInitiator,
  SidecarPakeResponder,
  SidecarTunnel,
} from '../../../workers/rust-crypto-core';
import { DATA_CHANNEL_LABEL } from '../peer';

// ---- Shared fakes ----------------------------------------------------------

type Listener = (b: Uint8Array) => void;

interface FakeRelay {
  channelFor(role: 'A' | 'B'): SidecarSignalingChannel;
}

function makeRelay(): FakeRelay {
  // Two-party in-memory "relay": frames sent by A reach B's onFrame listeners and vice versa.
  const aHandlers = new Set<Listener>();
  const bHandlers = new Set<Listener>();
  const aClose = new Set<() => void>();
  const bClose = new Set<() => void>();
  let closedA = false;
  let closedB = false;

  function makeChannel(side: 'A' | 'B'): SidecarSignalingChannel {
    const myHandlers = side === 'A' ? aHandlers : bHandlers;
    const peerHandlers = side === 'A' ? bHandlers : aHandlers;
    const closeHandlers = side === 'A' ? aClose : bClose;
    return {
      state: 'open',
      async send(frame) {
        if (side === 'A' && closedA) throw new Error('A closed');
        if (side === 'B' && closedB) throw new Error('B closed');
        // Defensive copy.
        const copy = new Uint8Array(frame.byteLength);
        copy.set(frame);
        // Deliver asynchronously to mimic real WS.
        setTimeout(() => { for (const h of peerHandlers) h(copy); }, 0);
      },
      onFrame(h) {
        myHandlers.add(h);
        return () => myHandlers.delete(h);
      },
      onClose(h) {
        closeHandlers.add(h);
        return () => closeHandlers.delete(h);
      },
      onError() { return () => {}; },
      close() {
        if (side === 'A') closedA = true;
        else closedB = true;
      },
    };
  }
  return {
    channelFor(role) { return makeChannel(role); },
  };
}

// ---- PAKE fakes (deterministic; just verify code matches) ------------------

let nextHandle = 1;

function makeFakePake(matchCode: Uint8Array): {
  initiator: () => Promise<SidecarPakeInitiator>;
  responder: () => Promise<SidecarPakeResponder>;
} {
  return {
    initiator: async () => {
      let h: number | null = null;
      return {
        async start(code) {
          void code;
          h = nextHandle++;
          return { msg1: tag(h, 'INIT-MSG1') };
        },
        async finish(_msg2, respConfirm) {
          if (h === null) throw new Error('no handle');
          // Validate that responder's confirm carries the same handle.
          const respHandle = readHandle(respConfirm);
          void respHandle;
          if (!startsWith(respConfirm, 'RESP-CONFIRM')) throw new Error('bad confirm');
          // Check responder's code via embedded marker
          if (!startsWithCode(respConfirm, matchCode)) throw new Error('code mismatch');
          const initiatorConfirm = tag(h, 'INIT-CONFIRM');
          appendCode(initiatorConfirm, matchCode);
          h = null;
          return { keyMaterialHandle: nextHandle++, initiatorConfirm };
        },
        async close() { h = null; },
      };
    },
    responder: async () => {
      let h: number | null = null;
      let initHandle: number | null = null;
      let myCode: Uint8Array | null = null;
      return {
        async step(code, msg1) {
          // Accept any msg1 (mismatch is detected later via the embedded code).
          void msg1;
          initHandle = readHandle(msg1);
          h = nextHandle++;
          myCode = code;
          const msg2 = tag(initHandle, 'RESP-MSG2');
          const responderConfirm = tag(initHandle, 'RESP-CONFIRM');
          appendCode(responderConfirm, code);
          return { msg2, responderConfirm };
        },
        async finish(initiatorConfirm) {
          if (h === null || initHandle === null || !myCode) throw new Error('no state');
          if (!startsWith(initiatorConfirm, 'INIT-CONFIRM')) throw new Error('bad confirm');
          if (!startsWithCode(initiatorConfirm, myCode)) throw new Error('code mismatch');
          h = null;
          return { keyMaterialHandle: nextHandle++ };
        },
        async close() { h = null; },
      };
    },
  };
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const TAG_OFF = 4;
const PREFIX_OFF = TAG_OFF + 16;

function tag(handle: number, label: string): Uint8Array {
  const out = new Uint8Array(PREFIX_OFF + 32);
  new DataView(out.buffer).setUint32(0, handle, true);
  const labelBytes = new TextEncoder().encode(label);
  out.set(labelBytes.slice(0, 16), TAG_OFF);
  return out;
}
function readHandle(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
}
function startsWith(buf: Uint8Array, label: string): boolean {
  const labelBytes = new TextEncoder().encode(label);
  for (let i = 0; i < labelBytes.length; i++) if (buf[TAG_OFF + i] !== labelBytes[i]) return false;
  return true;
}
function appendCode(buf: Uint8Array, code: Uint8Array): void {
  buf.set(code, PREFIX_OFF);
}
function startsWithCode(buf: Uint8Array, code: Uint8Array): boolean {
  for (let i = 0; i < code.byteLength; i++) if (buf[PREFIX_OFF + i] !== code[i]) return false;
  return true;
}

// ---- Tunnel fake (identity with 1-byte tag) --------------------------------

function makeFakeTunnel(_handle: number): SidecarTunnel {
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

// ---- RTCPeerConnection mock with auto-pairing ------------------------------

type FakePCInst = {
  role: 'A' | 'B' | null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  ondatachannel: ((ev: { channel: FakeDC }) => void) | null;
  iceConnectionState: RTCIceConnectionState;
  remoteDescription: RTCSessionDescriptionInit | null;
  closedCalled: boolean;
  channels: FakeDC[];
};

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
      const cp = data.slice(0);
      Promise.resolve().then(() => this.paired!.onmessage?.({ data: cp }));
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

function makePairedRTC(): { ctorA: typeof RTCPeerConnection; ctorB: typeof RTCPeerConnection; instances: FakePCInst[] } {
  const instances: FakePCInst[] = [];
  let pendingA: FakePCInst | null = null;
  let pendingB: FakePCInst | null = null;
  let pendingDC: FakeDC | null = null;

  function makeCtor(role: 'A' | 'B'): typeof RTCPeerConnection {
    return class FakePC {
      iceConnectionState: RTCIceConnectionState = 'new';
      onicecandidate: FakePCInst['onicecandidate'] = null;
      oniceconnectionstatechange: FakePCInst['oniceconnectionstatechange'] = null;
      ondatachannel: FakePCInst['ondatachannel'] = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      closedCalled = false;
      channels: FakeDC[] = [];
      constructor(_cfg?: RTCConfiguration) {
        const inst: FakePCInst = {
          role,
          onicecandidate: null,
          oniceconnectionstatechange: null,
          ondatachannel: null,
          iceConnectionState: 'new',
          remoteDescription: null,
          closedCalled: false,
          channels: [],
        };
        instances.push(inst);
        if (role === 'A') pendingA = inst;
        else pendingB = inst;
        // Bridge instance state via getters/setters delegating to inst.
        Object.defineProperty(this, 'onicecandidate', {
          get: () => inst.onicecandidate,
          set: (v: FakePCInst['onicecandidate']) => { inst.onicecandidate = v; },
        });
        Object.defineProperty(this, 'oniceconnectionstatechange', {
          get: () => inst.oniceconnectionstatechange,
          set: (v: FakePCInst['oniceconnectionstatechange']) => { inst.oniceconnectionstatechange = v; },
        });
        Object.defineProperty(this, 'ondatachannel', {
          get: () => inst.ondatachannel,
          set: (v: FakePCInst['ondatachannel']) => {
            inst.ondatachannel = v;
            // If A already created a DC, deliver it now.
            if (role === 'B' && pendingDC && v) {
              const captured = pendingDC;
              pendingDC = null;
              const channelB = new FakeDC(DATA_CHANNEL_LABEL);
              channelB.paired = captured;
              captured.paired = channelB;
              inst.channels.push(channelB);
              v({ channel: channelB });
              setTimeout(() => {
                captured.open();
                channelB.open();
              }, 0);
            }
          },
        });
      }
      createDataChannel(label: string, _init?: RTCDataChannelInit): FakeDC {
        const ch = new FakeDC(label);
        const inst = role === 'A' ? pendingA! : pendingB!;
        inst.channels.push(ch);
        if (role === 'A') {
          pendingDC = ch;
          // If B's ondatachannel is already attached, deliver now.
          if (pendingB && pendingB.ondatachannel) {
            const channelB = new FakeDC(DATA_CHANNEL_LABEL);
            channelB.paired = ch;
            ch.paired = channelB;
            pendingB.channels.push(channelB);
            pendingB.ondatachannel({ channel: channelB });
            pendingDC = null;
            setTimeout(() => {
              ch.open();
              channelB.open();
            }, 0);
          }
        }
        return ch;
      }
      async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'fake-offer' }; }
      async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'fake-answer' }; }
      async setLocalDescription(_d: RTCSessionDescriptionInit): Promise<void> {}
      async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
        const inst = role === 'A' ? pendingA! : pendingB!;
        inst.remoteDescription = d;
      }
      async addIceCandidate(_c?: RTCIceCandidateInit): Promise<void> {}
      close(): void {
        const inst = role === 'A' ? pendingA! : pendingB!;
        inst.closedCalled = true;
        inst.iceConnectionState = 'closed';
        inst.oniceconnectionstatechange?.();
      }
    } as unknown as typeof RTCPeerConnection;
  }

  return {
    ctorA: makeCtor('A'),
    ctorB: makeCtor('B'),
    instances,
  };
}

// ---- Tests -----------------------------------------------------------------

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('pairSidecar', () => {
  it('happy path: initiator + responder both resolve and connect a data channel', async () => {
    const code = ascii('123456');
    const pake = makeFakePake(code);
    const relay = makeRelay();
    const rtc = makePairedRTC();

    const initP = pairSidecar({
      role: 'initiator',
      code,
      iceServers: [],
      _overrides: {
        openSignaling: () => relay.channelFor('A'),
        openPakeInitiator: pake.initiator,
        openPakeResponder: pake.responder,
        openTunnel: async (h) => makeFakeTunnel(h),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorA,
      },
    });
    const respP = pairSidecar({
      role: 'responder',
      code,
      msg1: ascii('placeholder-msg1'), // responder gets msg1 OOB; our fake derives roomId from a stub
      iceServers: [],
      _overrides: {
        openSignaling: () => relay.channelFor('B'),
        openPakeInitiator: pake.initiator,
        openPakeResponder: pake.responder,
        openTunnel: async (h) => makeFakeTunnel(h),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorB,
      },
    });

    const [a, b] = await Promise.all([initP, respP]);
    expect(a.peer).toBeDefined();
    expect(b.peer).toBeDefined();

    // End-to-end smoke: A sends a sealed bytestring; B's onFrame should fire with the same bytes.
    const received: Uint8Array[] = [];
    b.peer.onFrame((f) => received.push(f));
    await a.peer.sendFrame(new Uint8Array([1, 2, 3, 4, 5]));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!)).toEqual([1, 2, 3, 4, 5]);

    await a.close();
    await b.close();
  });

  it('responder without msg1 throws InvalidResponderInput', async () => {
    const code = ascii('123456');
    await expect(
      pairSidecar({
        role: 'responder',
        code,
        iceServers: [],
        _overrides: {
          openSignaling: () => makeRelay().channelFor('A'),
          openPakeResponder: makeFakePake(code).responder,
          openTunnel: async (h) => makeFakeTunnel(h),
          deriveRoomId: async () => '0'.repeat(32),
        },
      }),
    ).rejects.toMatchObject({ code: 'InvalidResponderInput' });
  });

  it('wrong code surfaces as PairingError.WrongCode', async () => {
    const codeA = ascii('111111');
    const codeB = ascii('222222');
    const pakeA = makeFakePake(codeA);
    const pakeB = makeFakePake(codeB);
    const relay = makeRelay();
    const rtc = makePairedRTC();

    const initP = pairSidecar({
      role: 'initiator',
      code: codeA,
      iceServers: [],
      _overrides: {
        openSignaling: () => relay.channelFor('A'),
        openPakeInitiator: pakeA.initiator,
        openPakeResponder: pakeA.responder,
        openTunnel: async (h) => makeFakeTunnel(h),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorA,
      },
    });
    const respP = pairSidecar({
      role: 'responder',
      code: codeB,
      msg1: ascii('placeholder-msg1'),
      iceServers: [],
      _overrides: {
        openSignaling: () => relay.channelFor('B'),
        openPakeInitiator: pakeB.initiator,
        openPakeResponder: pakeB.responder,
        openTunnel: async (h) => makeFakeTunnel(h),
        deriveRoomId: async () => '0'.repeat(32),
        rtcPeerConnectionCtor: rtc.ctorB,
      },
    });

    // The initiator's finish() will detect mismatch on responder's confirm.
    await expect(initP).rejects.toBeInstanceOf(PairingError);
    await expect(initP.catch((e) => e.code)).resolves.toBe('WrongCode');
    // Responder eventually fails too -- swallow.
    respP.catch(() => {});
  });

  it('aborted before signaling opens rejects with Aborted', async () => {
    const code = ascii('123456');
    const ac = new AbortController();
    ac.abort();
    await expect(
      pairSidecar({
        role: 'initiator',
        code,
        iceServers: [],
        abort: ac.signal,
        _overrides: {
          openSignaling: () => makeRelay().channelFor('A'),
          openPakeInitiator: makeFakePake(code).initiator,
          openTunnel: async (h) => makeFakeTunnel(h),
          deriveRoomId: async () => '0'.repeat(32),
        },
      }),
    ).rejects.toMatchObject({ code: 'Aborted' });
  });

  it('handshake timeout surfaces as SignalingTimeout', async () => {
    const code = ascii('123456');
    // No responder ever joins the relay; timeout fires.
    await expect(
      pairSidecar({
        role: 'initiator',
        code,
        iceServers: [],
        timeoutMs: 50,
        _overrides: {
          openSignaling: () => makeRelay().channelFor('A'),
          openPakeInitiator: makeFakePake(code).initiator,
          openTunnel: async (h) => makeFakeTunnel(h),
          deriveRoomId: async () => '0'.repeat(32),
        },
      }),
    ).rejects.toMatchObject({ code: 'SignalingTimeout' });
  });
});







