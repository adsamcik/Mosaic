import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import qrcode from 'qrcode-generator';
import { pairSidecarInitiatorBegin, PairingError, type InitiatorPrefix } from '../../lib/sidecar/pairing';
import { encodeFrame } from '../../lib/sidecar/framing';
import { chunkPhoto } from '../../lib/sidecar/chunker';
import type { SidecarFallbackKind, SidecarPeerHandle } from '../../workers/types';
import { createLogger } from '../../lib/logger';

const log = createLogger('SidecarPairingModal');

const PAIRING_TTL_MS = 90_000;
const CODE_LENGTH = 6;
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

// Conservative defaults for chunk sizing. The runtime SCTP max-message-size
// can be smaller; we subtract AEAD/frame overhead to stay below it.
const SCTP_DEFAULT_MAX_BYTES = 256 * 1024;
const AEAD_OVERHEAD_BYTES = 16 /* poly1305 tag */ + 24 /* nonce-prefix */;
const FRAME_HEADER_OVERHEAD_BYTES = 32;

export interface SidecarPairingModalProps {
  readonly open: boolean;
  /** Declared fallback if the peer drops mid-job. */
  readonly fallback: SidecarFallbackKind;
  /** Called once the peer is paired and the tunnel is open. */
  readonly onPaired: (handle: SidecarPeerHandle, fallback: SidecarFallbackKind) => void;
  /** Called when the user cancels or the TTL expires without a peer. */
  readonly onCancel: () => void;
}

/**
 * Generate `n` decimal digits using rejection sampling on `crypto.getRandomValues`.
 */
function generateCode(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const buf = new Uint8Array(n - i + 8);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (i >= n) break;
      if (b < 250) {
        out[i] = 0x30 /* '0' */ + (b % 10);
        i += 1;
      }
    }
  }
  return out;
}

function codeToString(code: Uint8Array): string {
  return Array.from(code, (b) => String.fromCharCode(b)).join('');
}

/** RFC 4648 base64url with no padding. */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildSignalingBaseUrl(): string | undefined {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined) ?? {};
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const override = typeof env['VITE_SIDECAR_SIGNAL_URL'] === 'string' ? String(env['VITE_SIDECAR_SIGNAL_URL']) : '';
  return override.length > 0 ? override : undefined;
}

function buildIceServers(): readonly RTCIceServer[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined) ?? {};
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const turnUrl = typeof env['VITE_SIDECAR_TURN_URL'] === 'string' ? String(env['VITE_SIDECAR_TURN_URL']) : '';
  const turnUser = typeof env['VITE_SIDECAR_TURN_USERNAME'] === 'string' ? String(env['VITE_SIDECAR_TURN_USERNAME']) : '';
  const turnCred = typeof env['VITE_SIDECAR_TURN_CREDENTIAL'] === 'string' ? String(env['VITE_SIDECAR_TURN_CREDENTIAL']) : '';
  if (turnUrl.length > 0) {
    return [
      ...DEFAULT_ICE_SERVERS,
      { urls: turnUrl, username: turnUser || undefined, credential: turnCred || undefined } as RTCIceServer,
    ];
  }
  return DEFAULT_ICE_SERVERS;
}

/** Pretty-print "123 456" for the 6-digit code. */
function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * Build the responder pairing URL embedding msg1 (base64url) and the 6-digit
 * code in the URL fragment. Fragments are NEVER sent to the server.
 */
function buildPairUrl(msg1: Uint8Array, codeStr: string): string {
  const m = base64UrlEncode(msg1);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/pair#m=${m}&c=${codeStr}`;
}

/** Render a QR code to an inline SVG string. Pure-JS, no canvas. */
function renderQrSvg(text: string): string {
  // Type 0 = auto-fit, error correction 'M' (15%) is a balance of density vs. resilience.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  // cellSize=4, margin=2 cells gives a ~140-160px QR for typical short URLs.
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

interface PeerHandleAdapterDeps {
  readonly tunnel: import('../../lib/sidecar/pairing').PairingResult['tunnel'];
  readonly peer: import('../../lib/sidecar/pairing').PairingResult['peer'];
  readonly close: () => Promise<void>;
}

function buildPeerHandle(deps: PeerHandleAdapterDeps): SidecarPeerHandle {
  const disconnectHandlers = new Set<(reason: string) => void>();
  const onState = (s: string): void => {
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      for (const h of disconnectHandlers) h(s);
    }
  };
  let unsubState: (() => void) | null = null;
  try {
    const off = deps.peer.onState?.(onState);
    unsubState = typeof off === 'function' ? off : null;
  } catch (err) {
    log.warn('peer.onState not available', { errorName: err instanceof Error ? err.name : 'Unknown' });
  }

  const sessionId = `sc-${Date.now().toString(36).slice(-6)}`;

  // Per-photo streaming send via the chunker. We accept a Uint8Array (for
  // backwards compat / small-photo path) and wrap it in a single-shot
  // ReadableStream so the chunker remains the single producer of frames.
  // Memory peak is bounded by the chunker's internal carry buffer (one
  // upstream chunk worth of bytes), not the whole photo.
  return {
    sessionId,
    async send(bytes, filename, photoIdx): Promise<void> {
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const maxChunk = Math.max(
        1024,
        SCTP_DEFAULT_MAX_BYTES - AEAD_OVERHEAD_BYTES - FRAME_HEADER_OVERHEAD_BYTES,
      );
      for await (const frame of chunkPhoto(photoIdx, filename, BigInt(bytes.byteLength), stream, { maxChunkBytes: maxChunk })) {
        const sealed = await deps.tunnel.send.seal(encodeFrame(frame));
        await deps.peer.sendFrame(sealed);
      }
    },
    async endPhoto(photoIdx): Promise<void> {
      // chunkPhoto already emits fileEnd, but the public contract of
      // SidecarPeerHandle expects a separate endPhoto call. We send a
      // standalone fileEnd here for compatibility; the receive sink is
      // idempotent against duplicate fileEnd frames.
      const endFrame = encodeFrame({ kind: 'fileEnd', photoIdx });
      const sealed = await deps.tunnel.send.seal(endFrame);
      await deps.peer.sendFrame(sealed);
    },
    async close(reason): Promise<void> {
      try { unsubState?.(); } catch { /* swallow */ }
      if (reason === 'success') {
        try {
          const endFrame = encodeFrame({ kind: 'sessionEnd' });
          const sealed = await deps.tunnel.send.seal(endFrame);
          await deps.peer.sendFrame(sealed);
        } catch (err) {
          log.warn('sessionEnd send failed', { errorName: err instanceof Error ? err.name : 'Unknown' });
        }
      }
      try { await deps.close(); } catch (err) {
        log.warn('peer close failed', { errorName: err instanceof Error ? err.name : 'Unknown' });
      }
    },
    onDisconnect(handler): () => void {
      disconnectHandlers.add(handler);
      return () => { disconnectHandlers.delete(handler); };
    },
  };
}

/**
 * Initiator-side pairing modal. Generates a 6-digit code, kicks off the
 * pairing handshake, captures msg1, renders a QR + URL the user can scan
 * on the receiving device, and awaits the responder.
 *
 * ZK-safe: the code and msg1 are visible to the user (intentional — that's
 * the pairing artifact) but never logged, never sent to the server beyond
 * the WebSocket relay (which only sees the derived roomId), and never
 * persisted.
 */
export function SidecarPairingModal(props: SidecarPairingModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [code] = useState<Uint8Array>(() => generateCode(CODE_LENGTH));
  const codeStr = useMemo(() => codeToString(code), [code]);
  const [secondsLeft, setSecondsLeft] = useState<number>(Math.ceil(PAIRING_TTL_MS / 1000));
  const [error, setError] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const prefixRef = useRef<InitiatorPrefix | null>(null);
  const startedRef = useRef(false);

  // Run the pairing handshake exactly once on mount (when open).
  useEffect((): (() => void) => {
    if (!props.open) return () => undefined;
    if (startedRef.current) return () => undefined;
    startedRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;

    const timeoutId = window.setTimeout(() => {
      ac.abort();
    }, PAIRING_TTL_MS);

    void (async (): Promise<void> => {
      try {
        const prefix = await pairSidecarInitiatorBegin({
          code,
          iceServers: buildIceServers(),
          ...(buildSignalingBaseUrl() !== undefined ? { signalingBaseUrl: buildSignalingBaseUrl()! } : {}),
          abort: ac.signal,
          timeoutMs: PAIRING_TTL_MS,
        });
        prefixRef.current = prefix;

        // Compute and render the pairing URL + QR using the freshly-emitted msg1.
        const url = buildPairUrl(prefix.msg1, codeStr);
        setPairUrl(url);
        try {
          setQrSvg(renderQrSvg(url));
        } catch (qerr) {
          log.warn('QR render failed', { errorName: qerr instanceof Error ? qerr.name : 'Unknown' });
        }

        // Now await the responder.
        const result = await prefix.resume();
        const handle = buildPeerHandle({ tunnel: result.tunnel, peer: result.peer, close: result.close });
        props.onPaired(handle, props.fallback);
      } catch (err) {
        if (ac.signal.aborted) return;
        const errCode = err instanceof PairingError ? err.code : 'Generic';
        setError(t(`download.sidecarPairing.errors.${errCode}`, { defaultValue: t('download.sidecarPairing.errors.Generic') }));
        log.warn('Pairing failed', { code: errCode });
      }
    })();

    return (): void => {
      window.clearTimeout(timeoutId);
      ac.abort();
      try { prefixRef.current?.abort(); } catch { /* swallow */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // Tick the TTL countdown.
  useEffect((): (() => void) => {
    if (!props.open) return () => undefined;
    const start = Date.now();
    const id = window.setInterval(() => {
      const remaining = Math.max(0, PAIRING_TTL_MS - (Date.now() - start));
      setSecondsLeft(Math.ceil(remaining / 1000));
      if (remaining <= 0) window.clearInterval(id);
    }, 1000);
    return (): void => { window.clearInterval(id); };
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div className="sidecar-pairing-backdrop" role="presentation">
      <div
        className="sidecar-pairing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidecar-pairing-title"
        data-testid="sidecar-pairing-modal"
      >
        <h2 id="sidecar-pairing-title">{t('download.sidecarPairing.title')}</h2>
        <p>{t('download.sidecarPairing.instructions')}</p>
        <div
          className="sidecar-pairing-code"
          data-testid="sidecar-pairing-code"
          aria-label={t('download.sidecarPairing.codeLabel')}
        >
          {formatCode(codeStr)}
        </div>
        <p className="sidecar-pairing-ttl" data-testid="sidecar-pairing-ttl">
          {t('download.sidecarPairing.expiresIn', { seconds: secondsLeft })}
        </p>
        {qrSvg !== null ? (
          <div
            className="sidecar-pairing-qr"
            data-testid="sidecar-pairing-qr"
            aria-label={t('download.sidecarPairing.qrAriaLabel')}
            // SVG produced by qrcode-generator is a static, parameter-free
            // markup string. The only dynamic input (the URL) is text-encoded
            // by the library before being placed into a <text>-free SVG.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        ) : (
          <p className="sidecar-pairing-qr-placeholder">{t('download.sidecarPairing.preparingQr')}</p>
        )}
        {pairUrl !== null ? (
          <p className="sidecar-pairing-url-hint">
            {t('download.sidecarPairing.qrHint')}{' '}
            <code data-testid="sidecar-pairing-url">{pairUrl}</code>
          </p>
        ) : null}
        {error !== null ? (
          <p className="sidecar-pairing-error" role="alert" data-testid="sidecar-pairing-error">{error}</p>
        ) : null}
        <button
          type="button"
          onClick={(): void => {
            abortRef.current?.abort();
            try { prefixRef.current?.abort(); } catch { /* swallow */ }
            props.onCancel();
          }}
          data-testid="sidecar-pairing-cancel"
        >
          {t('download.sidecarPairing.cancel')}
        </button>
      </div>
    </div>
  );
}
