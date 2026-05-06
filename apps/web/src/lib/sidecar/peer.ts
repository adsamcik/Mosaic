/**
 * Sidecar Beacon - RTCPeerConnection wrapper.
 *
 * Wraps a single peer connection over the post-PAKE AEAD tunnel:
 *   * Initiator creates an ordered/reliable DataChannel ("sidecar"),
 *     responder receives it via ondatachannel.
 *   * SDP offer/answer + ICE candidates are JSON-encoded, sealed via the
 *     tunnel, and forwarded over the existing signaling channel. Strict
 *     in-order delivery is required (the tunnels AEAD nonce counter will
 *     reject reordered frames).
 *   * Application data frames (already-sealed bytes) are sent via sendFrame
 *     and dispatched through onFrame.
 *   * Backpressure is enforced: writes pause when bufferedAmount exceeds
 *     HIGH_WATER_MARK_BYTES and resume on the bufferedamountlow event
 *     (threshold LOW_WATER_MARK_BYTES).
 *
 * ZK-safe logging policy: never logs SDP, ICE, payload bytes, or key
 * material. Only state transitions and error categories.
 */

import type { SidecarSignalingChannel } from './signaling';
import type { SidecarTunnel } from '../../workers/rust-crypto-core';

export const HIGH_WATER_MARK_BYTES = 8 * 1024 * 1024;
export const LOW_WATER_MARK_BYTES = 1 * 1024 * 1024;
export const DATA_CHANNEL_LABEL = 'sidecar';

export type PeerState = 'connecting' | 'connected' | 'disconnected' | 'closed' | 'failed';

export interface PeerOptions {
  readonly iceServers: readonly RTCIceServer[];
  readonly signaling: SidecarSignalingChannel;
  readonly tunnel: SidecarTunnel;
  readonly role: 'initiator' | 'responder';
  readonly rtcPeerConnectionCtor?: typeof RTCPeerConnection;
}

export interface PeerConnection {
  ready(): Promise<void>;
  sendFrame(sealed: Uint8Array): Promise<void>;
  onFrame(handler: (sealed: Uint8Array) => void): () => void;
  onState(handler: (state: PeerState) => void): () => void;
  close(): Promise<void>;
}

type SignalingEnvelope =
  | { readonly type: 'sdp.offer'; readonly sdp: string }
  | { readonly type: 'sdp.answer'; readonly sdp: string }
  | { readonly type: 'ice'; readonly candidate: RTCIceCandidateInit }
  | { readonly type: 'ice.end' };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function createPeerConnection(opts: PeerOptions): PeerConnection {
  const Ctor =
    opts.rtcPeerConnectionCtor ??
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!Ctor) {
    throw new Error('peer: RTCPeerConnection unavailable in this environment');
  }

  const pc = new Ctor({ iceServers: [...opts.iceServers] });
  let dc: RTCDataChannel | null = null;
  let state: PeerState = 'connecting';
  let closed = false;

  const stateHandlers = new Set<(s: PeerState) => void>();
  const frameHandlers = new Set<(b: Uint8Array) => void>();
  const drainWaiters: Array<() => void> = [];

  let readyResolve: () => void = () => {};
  let readyReject: (e: Error) => void = () => {};
  const readyP = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  function setState(next: PeerState): void {
    if (state === next) return;
    state = next;
    for (const h of stateHandlers) {
      try { h(next); } catch { /* swallow */ }
    }
  }

  async function sendSignaling(env: SignalingEnvelope): Promise<void> {
    if (closed) return;
    const json = JSON.stringify(env);
    const plaintext = textEncoder.encode(json);
    const sealed = await opts.tunnel.send.seal(plaintext);
    await opts.signaling.send(sealed);
  }

  async function handleSignalingFrame(sealed: Uint8Array): Promise<void> {
    if (closed) return;
    let env: SignalingEnvelope;
    try {
      const plain = await opts.tunnel.recv.open(sealed);
      const text = textDecoder.decode(plain);
      env = JSON.parse(text) as SignalingEnvelope;
    } catch {
      void closeInternal('signaling-decode-failed');
      return;
    }
    try {
      switch (env.type) {
        case 'sdp.offer': {
          if (opts.role !== 'responder') return;
          await pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await sendSignaling({ type: 'sdp.answer', sdp: ans.sdp ?? '' });
          break;
        }
        case 'sdp.answer': {
          if (opts.role !== 'initiator') return;
          await pc.setRemoteDescription({ type: 'answer', sdp: env.sdp });
          break;
        }
        case 'ice': {
          try { await pc.addIceCandidate(env.candidate); } catch { /* late dup */ }
          break;
        }
        case 'ice.end': {
          try { await pc.addIceCandidate(); } catch { /* ignore */ }
          break;
        }
        default: {
          const _exhaustive: never = env;
          void _exhaustive;
        }
      }
    } catch {
      void closeInternal('signaling-handler-failed');
    }
  }

  const sigUnsub = opts.signaling.onFrame((sealed) => {
    void handleSignalingFrame(sealed);
  });

  function attachDataChannel(channel: RTCDataChannel): void {
    dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK_BYTES;

    channel.onopen = () => {
      setState('connected');
      readyResolve();
    };
    channel.onclose = () => {
      setState('closed');
      void closeInternal('dc-closed');
    };
    channel.onerror = () => {
      setState('failed');
      readyReject(new Error('peer: data channel error'));
    };
    channel.onmessage = (ev) => {
      const data = ev.data;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      } else {
        void closeInternal('non-binary-data-frame');
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      for (const h of frameHandlers) {
        try { h(copy); } catch { /* swallow */ }
      }
    };
    channel.onbufferedamountlow = () => {
      const waiters = drainWaiters.splice(0);
      for (const w of waiters) w();
    };
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      void sendSignaling({ type: 'ice', candidate: ev.candidate.toJSON() });
    } else {
      void sendSignaling({ type: 'ice.end' });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'failed') {
      setState('failed');
      readyReject(new Error('peer: ICE failed'));
    } else if (s === 'disconnected') {
      setState('disconnected');
    } else if (s === 'closed') {
      setState('closed');
    }
  };

  if (opts.role === 'initiator') {
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    attachDataChannel(channel);
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignaling({ type: 'sdp.offer', sdp: offer.sdp ?? '' });
      } catch (err) {
        readyReject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  } else {
    pc.ondatachannel = (ev) => {
      attachDataChannel(ev.channel);
    };
  }

  async function sendFrame(sealed: Uint8Array): Promise<void> {
    if (closed) throw new Error('peer: sendFrame after close');
    if (!dc || dc.readyState !== 'open') {
      throw new Error('peer: data channel not open');
    }
    while (dc.bufferedAmount > HIGH_WATER_MARK_BYTES) {
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
      if (closed) throw new Error('peer: closed while awaiting drain');
      if (!dc || dc.readyState !== 'open') throw new Error('peer: channel closed during drain');
    }
    const buf = new ArrayBuffer(sealed.byteLength);
    new Uint8Array(buf).set(sealed);
    dc.send(buf);
  }

  async function closeInternal(_reason?: string): Promise<void> {
    if (closed) return;
    closed = true;
    void _reason;
    setState('closed');
    const waiters = drainWaiters.splice(0);
    for (const w of waiters) w();
    try { sigUnsub(); } catch { /* ignore */ }
    if (dc) {
      try {
        dc.onopen = null;
        dc.onclose = null;
        dc.onerror = null;
        dc.onmessage = null;
        dc.onbufferedamountlow = null;
      } catch { /* ignore */ }
      try { dc.close(); } catch { /* ignore */ }
      dc = null;
    }
    try {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
    } catch { /* ignore */ }
    try { pc.close(); } catch { /* ignore */ }
    try { await opts.tunnel.close(); } catch { /* ignore */ }
    readyResolve();
  }

  return {
    ready: () => readyP,
    sendFrame,
    onFrame: (h) => {
      frameHandlers.add(h);
      return () => frameHandlers.delete(h);
    },
    onState: (h) => {
      stateHandlers.add(h);
      return () => stateHandlers.delete(h);
    },
    close: () => closeInternal(),
  };
}
