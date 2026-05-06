import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { pairSidecar, PairingError } from '../../lib/sidecar/pairing';
import type { SidecarFallbackKind, SidecarPeerHandle } from '../../workers/types';
import { createLogger } from '../../lib/logger';

const log = createLogger('SidecarPairingModal');

const PAIRING_TTL_MS = 90_000;
const CODE_LENGTH = 6;
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

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
 * Avoids modulo bias: any random byte >= 250 (= 25 * 10) is rejected so each
 * accepted byte maps to one of {0..9} uniformly.
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

function buildSignalingBaseUrl(): string | undefined {
  // Default: same-origin WSS. Override via VITE_SIDECAR_SIGNAL_URL.
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
 * Build the responder pairing URL. The responder needs `msg1` to derive the
 * roomId; we pass it in the URL fragment (never sent to the server) along
 * with the 6-digit code. The receive page parses both from the fragment.
 */
function buildPairUrl(_codeStr: string): string {
  // We don't have msg1 yet at this point — a future iteration can wire the
  // pairing API to expose msg1 ahead of the handshake so we can render a
  // QR with both. For now we return the bare /pair URL; the user types
  // the 6-digit code AND the sender shows a QR with msg1+code (TODO).
  if (typeof window === 'undefined') return '/pair';
  return `${window.location.origin}/pair`;
}

interface PeerHandleAdapterDeps {
  readonly tunnel: import('../../lib/sidecar/pairing').PairingResult['tunnel'];
  readonly peer: import('../../lib/sidecar/pairing').PairingResult['peer'];
  readonly close: () => Promise<void>;
}

function buildPeerHandle(deps: PeerHandleAdapterDeps): SidecarPeerHandle {
  const disconnectHandlers = new Set<(reason: string) => void>();
  // Bridge the underlying peer-connection state to onDisconnect listeners.
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

  return {
    sessionId,
    async send(bytes, _filename, _photoIdx): Promise<void> {
      // The tunnel encrypts; the framing layer chunks. For Phase 4D we send
      // the photo as a single AEAD-sealed message; the receive sink (Phase
      // 4C) reassembles by photoIdx ordering. A future iteration plugs the
      // chunker module here for streaming sends.
      const sealed = await deps.tunnel.send.seal(bytes);
      await deps.peer.sendFrame(sealed);
    },
    async endPhoto(_photoIdx): Promise<void> {
      // No-op for the single-shot send. With chunked sends, this would
      // flush the trailing frame.
    },
    async close(_reason): Promise<void> {
      try { unsubState?.(); } catch { /* swallow */ }
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
 * Initiator-side pairing modal. Generates a 6-digit code, displays it with
 * a TTL countdown, and runs {@link pairSidecar} in the role of initiator.
 * On success it builds a {@link SidecarPeerHandle} and hands it to the
 * caller via `onPaired`. ZK-safe: the code is never logged.
 */
export function SidecarPairingModal(props: SidecarPairingModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [code] = useState<Uint8Array>(() => generateCode(CODE_LENGTH));
  const codeStr = useMemo(() => codeToString(code), [code]);
  const [secondsLeft, setSecondsLeft] = useState<number>(Math.ceil(PAIRING_TTL_MS / 1000));
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
        const result = await pairSidecar({
          role: 'initiator',
          code,
          iceServers: buildIceServers(),
          ...(buildSignalingBaseUrl() !== undefined ? { signalingBaseUrl: buildSignalingBaseUrl()! } : {}),
          abort: ac.signal,
          timeoutMs: PAIRING_TTL_MS,
        });
        const handle = buildPeerHandle({ tunnel: result.tunnel, peer: result.peer, close: result.close });
        props.onPaired(handle, props.fallback);
      } catch (err) {
        if (ac.signal.aborted) return;
        const code = err instanceof PairingError ? err.code : 'Generic';
        setError(t(`download.sidecarPairing.errors.${code}`, { defaultValue: t('download.sidecarPairing.errors.Generic') }));
        log.warn('Pairing failed', { code });
      }
    })();

    return (): void => {
      window.clearTimeout(timeoutId);
      ac.abort();
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

  const pairUrl = buildPairUrl(codeStr);

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
        <p className="sidecar-pairing-url-hint">
          {t('download.sidecarPairing.qrHint')} <code>{pairUrl}</code>
        </p>
        {error !== null ? (
          <p className="sidecar-pairing-error" role="alert" data-testid="sidecar-pairing-error">{error}</p>
        ) : null}
        <button
          type="button"
          onClick={(): void => { abortRef.current?.abort(); props.onCancel(); }}
          data-testid="sidecar-pairing-cancel"
        >
          {t('download.sidecarPairing.cancel')}
        </button>
      </div>
    </div>
  );
}
