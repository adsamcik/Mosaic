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
 * Two-phase initiator API (so the pairing modal can render a QR/URL with
 * msg1 BEFORE the responder joins):
 *
 *   const prefix = await pairSidecarInitiatorBegin(opts);
 *   // prefix.msg1 is now available to encode into a /pair#m=...&c=... URL
 *   const result = await prefix.resume();
 *
 * `pairSidecar({ role: 'initiator' })` is preserved as a thin wrapper for
 * backwards compatibility.
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

/**
 * Initiator-only prefix handle returned by {@link pairSidecarInitiatorBegin}.
 * The caller may render `msg1` (e.g. base64url-encoded into a /pair URL)
 * before invoking {@link InitiatorPrefix.resume} to complete the handshake.
 */
export interface InitiatorPrefix {
  /** PAKE msg1 bytes — caller can render URL/QR with these. Defensive copy. */
  readonly msg1: Uint8Array;
  /**
   * Resume the handshake. Resolves to the full pairing result once the
   * responder joins, completes PAKE, and the data channel opens.
   * Idempotent: subsequent calls return the same in-flight promise.
   */
  resume(): Promise<PairingResult>;
  /** Cancel before resume completes (and during, via the underlying abort). */
  abort(): void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PAKE_TAG_INITIATOR_MSG1 = 0x01;
const PAKE_TAG_RESPONDER_MSG2 = 0x02;
const PAKE_TAG_INITIATOR_CONFIRM = 0x03;

interface ResolvedOverrides {
  readonly openSignaling: (roomId: string, baseUrl?: string) => SidecarSignalingChannel;
  readonly openPakeInit: () => Promise<SidecarPakeInitiator>;
  readonly openPakeResp: () => Promise<SidecarPakeResponder>;
  readonly openTunnel: (handle: number) => Promise<SidecarTunnel>;
  readonly deriveRoom: (msg1: Uint8Array) => Promise<string>;
  readonly rtcPeerConnectionCtor?: typeof RTCPeerConnection;
}

function resolveOverrides(opts: PairingOptions): ResolvedOverrides {
  const o = opts._overrides ?? {};
  const base: Omit<ResolvedOverrides, 'rtcPeerConnectionCtor'> = {
    openSignaling:
      o.openSignaling ??
      ((roomId, baseUrl) => openSidecarSignalingChannel(roomId, baseUrl ? { baseUrl } : {})),
    openPakeInit: o.openPakeInitiator ?? rustOpenSidecarPakeInitiator,
    openPakeResp: o.openPakeResponder ?? rustOpenSidecarPakeResponder,
    openTunnel: o.openTunnel ?? rustOpenSidecarTunnel,
    deriveRoom: o.deriveRoomId ?? deriveSidecarRoomId,
  };
  return o.rtcPeerConnectionCtor !== undefined
    ? { ...base, rtcPeerConnectionCtor: o.rtcPeerConnectionCtor }
    : base;
}

/**
 * Phase 1 of the initiator handshake. Opens PAKE, captures msg1, derives the
 * roomId, and opens the signaling channel — but does NOT yet exchange any
 * frames with the responder. Returns synchronously-available msg1 so the
 * caller can render a pairing URL/QR before the responder joins.
 */
export async function pairSidecarInitiatorBegin(
  opts: Omit<PairingOptions, 'role'>,
): Promise<InitiatorPrefix> {
  const fullOpts: PairingOptions = { ...opts, role: 'initiator' };
  const resolved = resolveOverrides(fullOpts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Internal abort controller chained to the user's abort signal so resume()
  // and abort() share the same cancellation surface.
  const ac = new AbortController();
  if (opts.abort) {
    if (opts.abort.aborted) ac.abort();
    else opts.abort.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // Pre-flight: do NOT swallow these so the caller learns of failure
  // immediately (before showing a QR for an already-broken session).
  if (ac.signal.aborted) throw new PairingError('Aborted');

  const pakeInit = await resolved.openPakeInit();
  let msg1: Uint8Array;
  try {
    const started = await pakeInit.start(opts.code);
    msg1 = started.msg1;
  } catch (err) {
    try { await pakeInit.close(); } catch { /* ignore */ }
    throw classifyPakeError(err);
  }
  const roomId = await resolved.deriveRoom(msg1);
  const signaling = resolved.openSignaling(roomId, opts.signalingBaseUrl);

  // Defensive copy of msg1 so the caller can mutate the buffer freely.
  const msg1Copy = new Uint8Array(msg1.byteLength);
  msg1Copy.set(msg1);

  let resumed: Promise<PairingResult> | null = null;
  let prefixDisposed = false;

  const disposePrefix = async (): Promise<void> => {
    // Only used when abort() is called BEFORE resume(). After resume the
    // inner handshake owns these resources.
    if (prefixDisposed) return;
    prefixDisposed = true;
    try { await pakeInit.close(); } catch { /* ignore */ }
    try { signaling.close(1000, 'pair-aborted'); } catch { /* ignore */ }
  };

  return {
    msg1: msg1Copy,
    resume(): Promise<PairingResult> {
      if (resumed) return resumed;
      // Past this point, resources flow into the inner handshake which has
      // its own cleanup paths.
      prefixDisposed = true;
      resumed = runInitiatorHandshake({
        opts: fullOpts,
        resolved,
        timeoutMs,
        abort: ac.signal,
        pakeInit,
        msg1,
        signaling,
      });
      return resumed;
    },
    abort(): void {
      ac.abort();
      if (!resumed) {
        // Fire-and-forget: caller doesn't await abort().
        void disposePrefix();
      }
    },
  };
}

/**
 * Top-level pairing entry point. Convenience wrapper around
 * {@link pairSidecarInitiatorBegin} for the initiator role; runs the
 * responder handshake directly.
 */
export async function pairSidecar(opts: PairingOptions): Promise<PairingResult> {
  if (opts.role === 'initiator') {
    const { role: _role, ...rest } = opts;
    void _role;
    const prefix = await pairSidecarInitiatorBegin(rest);
    return prefix.resume();
  }
  return runResponderHandshake(opts);
}

// ---------------------------------------------------------------------------
// Inner handshakes
// ---------------------------------------------------------------------------

interface InitiatorHandshakeArgs {
  readonly opts: PairingOptions;
  readonly resolved: ResolvedOverrides;
  readonly timeoutMs: number;
  readonly abort: AbortSignal;
  readonly pakeInit: SidecarPakeInitiator;
  readonly msg1: Uint8Array;
  readonly signaling: SidecarSignalingChannel;
}

async function runInitiatorHandshake(args: InitiatorHandshakeArgs): Promise<PairingResult> {
  const { opts, resolved, timeoutMs, abort, signaling, msg1 } = args;
  // Mutable handles consumed by cleanupOnFail.
  let pakeInit: SidecarPakeInitiator | null = args.pakeInit;
  let tunnel: SidecarTunnel | null = null;
  let peer: PeerConnection | null = null;

  const cleanupOnFail = async (): Promise<void> => {
    try { await pakeInit?.close(); } catch { /* ignore */ }
    try { await tunnel?.close(); } catch { /* ignore */ }
    try { await peer?.close(); } catch { /* ignore */ }
    try { signaling.close(1000, 'pair-failed'); } catch { /* ignore */ }
  };

  const { watchdog, clear } = makeWatchdog(abort, timeoutMs);

  try {
    const result = await Promise.race([watchdog, (async (): Promise<PairingResult> => {
      const inbox = new FrameInbox(signaling);
      await signaling.send(prefixTag(PAKE_TAG_INITIATOR_MSG1, msg1));
      const inFrame = await inbox.next(PAKE_TAG_RESPONDER_MSG2);
      const { msg2, respConfirm } = unpackResponderFrame(inFrame);
      let finished: { keyMaterialHandle: number; initiatorConfirm: Uint8Array };
      try {
        finished = await pakeInit!.finish(msg2, respConfirm);
      } catch (err) {
        throw classifyPakeError(err);
      }
      pakeInit = null;
      await signaling.send(prefixTag(PAKE_TAG_INITIATOR_CONFIRM, finished.initiatorConfirm));
      inbox.dispose();
      tunnel = await resolved.openTunnel(finished.keyMaterialHandle);
      peer = createPeerConnection({
        iceServers: opts.iceServers,
        signaling,
        tunnel,
        role: 'initiator',
        ...(resolved.rtcPeerConnectionCtor ? { rtcPeerConnectionCtor: resolved.rtcPeerConnectionCtor } : {}),
      });
      await peer.ready();
      return finalize(peer, tunnel, signaling);
    })()]);
    clear();
    return result;
  } catch (err) {
    clear();
    await cleanupOnFail();
    throw err;
  }
}

async function runResponderHandshake(opts: PairingOptions): Promise<PairingResult> {
  const resolved = resolveOverrides(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!opts.msg1 || opts.msg1.byteLength === 0) {
    throw new PairingError('InvalidResponderInput', 'responder requires opts.msg1');
  }

  let signaling: SidecarSignalingChannel | null = null;
  let pakeResp: SidecarPakeResponder | null = null;
  let tunnel: SidecarTunnel | null = null;
  let peer: PeerConnection | null = null;

  const cleanupOnFail = async (): Promise<void> => {
    try { await pakeResp?.close(); } catch { /* ignore */ }
    try { await tunnel?.close(); } catch { /* ignore */ }
    try { await peer?.close(); } catch { /* ignore */ }
    try { signaling?.close(1000, 'pair-failed'); } catch { /* ignore */ }
  };

  const ac = new AbortController();
  if (opts.abort) {
    if (opts.abort.aborted) ac.abort();
    else opts.abort.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const { watchdog, clear } = makeWatchdog(ac.signal, timeoutMs);

  try {
    const result = await Promise.race([watchdog, (async (): Promise<PairingResult> => {
      const roomId = await resolved.deriveRoom(opts.msg1!);
      signaling = resolved.openSignaling(roomId, opts.signalingBaseUrl);
      const inbox = new FrameInbox(signaling);

      pakeResp = await resolved.openPakeResp();
      let stepResult: { msg2: Uint8Array; responderConfirm: Uint8Array };
      try {
        stepResult = await pakeResp.step(opts.code, opts.msg1!);
      } catch (err) {
        throw classifyPakeError(err);
      }

      void inbox.expectAndDrop(PAKE_TAG_INITIATOR_MSG1).catch(() => {});
      await signaling.send(packResponderFrame(stepResult.msg2, stepResult.responderConfirm));
      const confirmFrame = await inbox.next(PAKE_TAG_INITIATOR_CONFIRM);
      let finished: { keyMaterialHandle: number };
      try {
        finished = await pakeResp.finish(confirmFrame);
      } catch (err) {
        throw classifyPakeError(err);
      }
      pakeResp = null;

      inbox.dispose();
      tunnel = await resolved.openTunnel(finished.keyMaterialHandle);
      peer = createPeerConnection({
        iceServers: opts.iceServers,
        signaling,
        tunnel,
        role: 'responder',
        ...(resolved.rtcPeerConnectionCtor ? { rtcPeerConnectionCtor: resolved.rtcPeerConnectionCtor } : {}),
      });
      await peer.ready();
      return finalize(peer, tunnel, signaling);
    })()]);
    clear();
    return result;
  } catch (err) {
    clear();
    await cleanupOnFail();
    throw err;
  }
}

function makeWatchdog(
  abort: AbortSignal,
  timeoutMs: number,
): { watchdog: Promise<never>; clear: () => void } {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    if (abort.aborted) {
      reject(new PairingError('Aborted'));
      return;
    }
    onAbort = (): void => reject(new PairingError('Aborted'));
    abort.addEventListener('abort', onAbort, { once: true });
    timeoutHandle = setTimeout(() => reject(new PairingError('SignalingTimeout')), timeoutMs);
  });
  return {
    watchdog,
    clear: (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (onAbort) abort.removeEventListener('abort', onAbort);
    },
  };
}

function finalize(
  peer: PeerConnection,
  tunnel: SidecarTunnel,
  signaling: SidecarSignalingChannel,
): PairingResult {
  let closed = false;
  return {
    peer,
    tunnel,
    signaling,
    async close() {
      if (closed) return;
      closed = true;
      try { await peer.close(); } catch { /* ignore */ }
      try { await tunnel.close(); } catch { /* ignore */ }
      try { signaling.close(1000, 'pairing-closed'); } catch { /* ignore */ }
    },
  };
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
