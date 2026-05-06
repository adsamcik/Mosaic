/**
 * Sidecar Beacon - top-level pairing orchestration.
 *
 * Composes the four lower-level pieces (signaling channel, PAKE handshake,
 * AEAD tunnel, peer connection) into a single Promise<PairingResult>:
 *
 *   1. Initiator generates PAKE msg1; derives roomId = HKDF(msg1).
 *      Responder is given msg1 out-of-band (e.g. via QR scan) and derives
 *      the same roomId.
 *   2. Both open the signaling channel for that roomId.
 *   3. PAKE runs cleartext over the relay (msg1 -> msg2/respConfirm ->
 *      initConfirm). Wrong code -> PairingError.WrongCode.
 *   4. Both sides open the AEAD tunnel from the derived material.
 *   5. WebRTC SDP+ICE flows sealed over the tunnel via the same signaling
 *      channel, until the data channel opens.
 *   6. Returns { peer, tunnel, close }.
 *
 * ZK-safe logging policy: this module never logs the pairing code, msg1,
 * roomId, key material, SDP, or ICE bytes.
 */

import {
  rustOpenSidecarPakeInitiator,
  rustOpenSidecarPakeResponder,
  rustOpenSidecarTunnel,
  type SidecarPakeInitiator,
  type SidecarPakeResponder,
  type SidecarTunnel,
} from '../../workers/rust-crypto-core';
import { createPeerConnection, type PeerConnection } from './peer';
import {
  deriveSidecarRoomId,
  openSidecarSignalingChannel,
  type SidecarSignalingChannel,
} from './signaling';

export type PairingErrorCode =
  | 'WrongCode'
  | 'SignalingTimeout'
  | 'IceFailed'
  | 'Aborted'
  | 'SignalingClosed'
  | 'InvalidResponderInput';

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  constructor(code: PairingErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PairingError';
    this.code = code;
  }
}

export interface PairingOptions {
  readonly role: 'initiator' | 'responder';
  /** 6 ASCII digit bytes. */
  readonly code: Uint8Array;
  /** Optional WebSocket origin (defaults to window.location). */
  readonly signalingBaseUrl?: string;
  readonly iceServers: readonly RTCIceServer[];
  /**
   * REQUIRED for role='responder': the initiator's PAKE msg1 (delivered
   * out-of-band, e.g. via a QR code or link). The responder uses it to
   * derive the same roomId. Ignored for initiators.
   */
  readonly msg1?: Uint8Array;
  /** Aborts the handshake. */
  readonly abort?: AbortSignal;
  /** Maximum time for the full handshake (signaling + PAKE + WebRTC). Default 60 s. */
  readonly timeoutMs?: number;
  /** Test/dependency injection overrides. */
  readonly _overrides?: PairingOverrides;
}

export interface PairingOverrides {
  readonly openSignaling?: (roomId: string, baseUrl?: string) => SidecarSignalingChannel;
  readonly openPakeInitiator?: () => Promise<SidecarPakeInitiator>;
  readonly openPakeResponder?: () => Promise<SidecarPakeResponder>;
  readonly openTunnel?: (handle: number) => Promise<SidecarTunnel>;
  readonly deriveRoomId?: (msg1: Uint8Array) => Promise<string>;
  readonly rtcPeerConnectionCtor?: typeof RTCPeerConnection;
}

export interface PairingResult {
  readonly peer: PeerConnection;
  readonly tunnel: SidecarTunnel;
  readonly signaling: SidecarSignalingChannel;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PAKE_TAG_INITIATOR_MSG1 = 0x01;
const PAKE_TAG_RESPONDER_MSG2 = 0x02;
const PAKE_TAG_INITIATOR_CONFIRM = 0x03;

export async function pairSidecar(opts: PairingOptions): Promise<PairingResult> {
  const overrides = opts._overrides ?? {};
  const openSignaling =
    overrides.openSignaling ??
    ((roomId, baseUrl) => openSidecarSignalingChannel(roomId, baseUrl ? { baseUrl } : {}));
  const openPakeInit = overrides.openPakeInitiator ?? rustOpenSidecarPakeInitiator;
  const openPakeResp = overrides.openPakeResponder ?? rustOpenSidecarPakeResponder;
  const openTunnel = overrides.openTunnel ?? rustOpenSidecarTunnel;
  const deriveRoom = overrides.deriveRoomId ?? deriveSidecarRoomId;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // --- Resources we may need to clean up on failure -------------------------
  let signaling: SidecarSignalingChannel | null = null;
  let pakeInit: SidecarPakeInitiator | null = null;
  let pakeResp: SidecarPakeResponder | null = null;
  let tunnel: SidecarTunnel | null = null;
  let peer: PeerConnection | null = null;

  const cleanupOnFail = async (): Promise<void> => {
    try { await pakeInit?.close(); } catch { /* ignore */ }
    try { await pakeResp?.close(); } catch { /* ignore */ }
    try { await tunnel?.close(); } catch { /* ignore */ }
    try { await peer?.close(); } catch { /* ignore */ }
    try { signaling?.close(1000, 'pair-failed'); } catch { /* ignore */ }
  };

  // --- Abort + timeout plumbing ---------------------------------------------
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    if (opts.abort) {
      const onAbort = (): void => {
        opts.abort?.removeEventListener('abort', onAbort);
        reject(new PairingError('Aborted'));
      };
      if (opts.abort.aborted) {
        reject(new PairingError('Aborted'));
        return;
      }
      opts.abort.addEventListener('abort', onAbort);
    }
    timeoutHandle = setTimeout(() => reject(new PairingError('SignalingTimeout')), timeoutMs);
  });

  try {
    const result = await Promise.race([watchdog, runPairing()]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return result;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await cleanupOnFail();
    throw err;
  }

  // --- Inner orchestration --------------------------------------------------
  async function runPairing(): Promise<PairingResult> {
    if (opts.role === 'initiator') {
      pakeInit = await openPakeInit();
      const { msg1 } = await pakeInit.start(opts.code);
      const roomId = await deriveRoom(msg1);
      signaling = openSignaling(roomId, opts.signalingBaseUrl);

      // Set up an inbound queue + close watcher.
      const inbox = new FrameInbox(signaling);

      // Send msg1 (tagged so we can multiplex PAKE on the same channel).
      await signaling.send(prefixTag(PAKE_TAG_INITIATOR_MSG1, msg1));

      // Wait for msg2 + responder confirm (single combined frame: tag || u16 msg2_len || msg2 || respConfirm).
      const inFrame = await inbox.next(PAKE_TAG_RESPONDER_MSG2);
      const { msg2, respConfirm } = unpackResponderFrame(inFrame);
      let finished: { keyMaterialHandle: number; initiatorConfirm: Uint8Array };
      try {
        finished = await pakeInit.finish(msg2, respConfirm);
      } catch (err) {
        throw classifyPakeError(err);
      }
      pakeInit = null; // consumed
      // Send our confirm.
      await signaling.send(prefixTag(PAKE_TAG_INITIATOR_CONFIRM, finished.initiatorConfirm));

      inbox.dispose(); // PAKE done; hand the channel over to the peer
      tunnel = await openTunnel(finished.keyMaterialHandle);
      peer = createPeerConnection({
        iceServers: opts.iceServers,
        signaling,
        tunnel,
        role: 'initiator',
        ...(overrides.rtcPeerConnectionCtor ? { rtcPeerConnectionCtor: overrides.rtcPeerConnectionCtor } : {}),
      });
      await peer.ready();
      return finalize();
    }

    // --- Responder ---
    if (!opts.msg1 || opts.msg1.byteLength === 0) {
      throw new PairingError('InvalidResponderInput', 'responder requires opts.msg1');
    }
    const roomId = await deriveRoom(opts.msg1);
    signaling = openSignaling(roomId, opts.signalingBaseUrl);
    const inbox = new FrameInbox(signaling);

    pakeResp = await openPakeResp();
    let stepResult: { msg2: Uint8Array; responderConfirm: Uint8Array };
    try {
      stepResult = await pakeResp.step(opts.code, opts.msg1);
    } catch (err) {
      throw classifyPakeError(err);
    }

    // We may receive msg1 from the peer over the wire too -- drain & ignore it
    // (the responder already had it out-of-band).
    void inbox.expectAndDrop(PAKE_TAG_INITIATOR_MSG1).catch(() => {});

    // Send combined responder frame.
    await signaling.send(packResponderFrame(stepResult.msg2, stepResult.responderConfirm));

    // Wait for initiator's confirm.
    const confirmFrame = await inbox.next(PAKE_TAG_INITIATOR_CONFIRM);
    let finished: { keyMaterialHandle: number };
    try {
      finished = await pakeResp.finish(confirmFrame);
    } catch (err) {
      throw classifyPakeError(err);
    }
    pakeResp = null;

    inbox.dispose();
    tunnel = await openTunnel(finished.keyMaterialHandle);
    peer = createPeerConnection({
      iceServers: opts.iceServers,
      signaling,
      tunnel,
      role: 'responder',
      ...(overrides.rtcPeerConnectionCtor ? { rtcPeerConnectionCtor: overrides.rtcPeerConnectionCtor } : {}),
    });
    await peer.ready();
    return finalize();
  }

  function finalize(): PairingResult {
    if (!peer || !tunnel || !signaling) {
      throw new PairingError('Aborted', 'finalize: missing resources');
    }
    const peerRef = peer;
    const tunnelRef = tunnel;
    const sigRef = signaling;
    let closed = false;
    return {
      peer: peerRef,
      tunnel: tunnelRef,
      signaling: sigRef,
      async close() {
        if (closed) return;
        closed = true;
        // peer.close() also closes the tunnel; sequence them defensively.
        try { await peerRef.close(); } catch { /* ignore */ }
        try { await tunnelRef.close(); } catch { /* ignore */ }
        try { sigRef.close(1000, 'pairing-closed'); } catch { /* ignore */ }
      },
    };
  }
}

function classifyPakeError(err: unknown): PairingError {
  // Any error from PAKE finish is treated as wrong-code (the PAKE construction
  // does not distinguish wrong-code from tampering by design).
  const msg = err instanceof Error ? err.message : String(err);
  return new PairingError('WrongCode', 'pake: ' + msg);
}

// --- PAKE multiplexing helpers ---------------------------------------------

function prefixTag(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

function packResponderFrame(msg2: Uint8Array, respConfirm: Uint8Array): Uint8Array {
  // [tag=2][u16 msg2_len][msg2][respConfirm]
  if (msg2.byteLength > 0xffff) throw new RangeError('pairing: msg2 too large');
  const out = new Uint8Array(1 + 2 + msg2.byteLength + respConfirm.byteLength);
  out[0] = PAKE_TAG_RESPONDER_MSG2;
  new DataView(out.buffer).setUint16(1, msg2.byteLength, true);
  out.set(msg2, 3);
  out.set(respConfirm, 3 + msg2.byteLength);
  return out;
}

function unpackResponderFrame(frame: Uint8Array): { msg2: Uint8Array; respConfirm: Uint8Array } {
  if (frame.byteLength < 3) throw new PairingError('WrongCode', 'malformed responder frame');
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const msg2Len = dv.getUint16(1, true);
  if (frame.byteLength < 3 + msg2Len) throw new PairingError('WrongCode', 'malformed responder frame');
  const msg2 = frame.slice(3, 3 + msg2Len);
  const respConfirm = frame.slice(3 + msg2Len);
  return { msg2, respConfirm };
}

/**
 * Demultiplexer over the signaling channel during the PAKE phase. Frames
 * arriving with a known tag are routed to the matching `next(tag)` waiter.
 */
class FrameInbox {
  private readonly queues = new Map<number, Uint8Array[]>();
  private readonly waiters = new Map<number, Array<(b: Uint8Array) => void>>();
  private readonly unsub: () => void;
  private disposed = false;

  constructor(channel: SidecarSignalingChannel) {
    this.unsub = channel.onFrame((frame) => {
      if (this.disposed || frame.byteLength === 0) return;
      const tag = frame[0]!;
      const body = frame.slice(1);
      // For the responder-msg2 frame, the body includes the original tag-prefixed structure.
      // We re-prefix so the consumer sees [tag||body] preserved -- that matches what next() returns.
      // Actually: next() returns the body *with* the tag stripped for INIT_MSG1 / INIT_CONFIRM (raw payload),
      // and *with* the tag preserved for RESPONDER_MSG2 (so unpackResponderFrame can read its header).
      let routed: Uint8Array;
      if (tag === PAKE_TAG_RESPONDER_MSG2) {
        routed = frame; // preserve full layout for unpackResponderFrame
      } else {
        routed = body;
      }
      const w = this.waiters.get(tag);
      if (w && w.length > 0) {
        const fn = w.shift()!;
        fn(routed);
        return;
      }
      const q = this.queues.get(tag) ?? [];
      q.push(routed);
      this.queues.set(tag, q);
    });
  }

  async next(tag: number): Promise<Uint8Array> {
    const q = this.queues.get(tag);
    if (q && q.length > 0) {
      return q.shift()!;
    }
    return new Promise<Uint8Array>((resolve) => {
      const list = this.waiters.get(tag) ?? [];
      list.push(resolve);
      this.waiters.set(tag, list);
    });
  }

  /** Wait for a tag and discard. Used by the responder to drain the initiator's msg1 echo. */
  async expectAndDrop(tag: number): Promise<void> {
    await this.next(tag);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.unsub(); } catch { /* ignore */ }
    this.queues.clear();
    this.waiters.clear();
  }
}



