import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { pairSidecar, PairingError } from '../../lib/sidecar/pairing';
import { decodeFrame } from '../../lib/sidecar/framing';
import { createSidecarReceiveSink } from '../../lib/sidecar/sink';
import { detectPerFileStrategy, openPerFileSaveTarget } from '../../lib/save-target';
import { createLogger } from '../../lib/logger';

const log = createLogger('SidecarReceivePage');

const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

type Status =
  | { readonly tag: 'idle' }
  | { readonly tag: 'connecting' }
  | { readonly tag: 'connected'; readonly received: number }
  | { readonly tag: 'done'; readonly received: number }
  | { readonly tag: 'error'; readonly message: string };

/** Parse `#m=<b64>&c=<digits>` from the URL fragment. */
function parsePrefill(): { readonly code: Uint8Array; readonly msg1: Uint8Array } | null {
  if (typeof window === 'undefined') return null;
  const frag = window.location.hash.replace(/^#/, '');
  if (frag.length === 0) return null;
  const params = new URLSearchParams(frag);
  const m = params.get('m');
  const cd = params.get('c');
  if (m === null || cd === null || !/^\d{6}$/.test(cd)) return null;
  try {
    const msg1 = base64UrlDecode(m);
    const code = new Uint8Array(6);
    for (let i = 0; i < 6; i += 1) code[i] = cd.charCodeAt(i);
    return { code, msg1 };
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Responder-side page mounted at `/pair`. Reads the prefill from the URL
 * fragment (msg1 + 6-digit code) and runs the pairing handshake. Once the
 * tunnel is open, it reads sealed frames off `peer.onFrame`, decrypts them,
 * decodes the framing layer, and pipes into a {@link SidecarReceiveSink}
 * backed by the user's per-file save target.
 *
 * If the page is opened without a prefill fragment (i.e. the user typed the
 * URL directly), it shows a "must scan QR / paste pairing link" message.
 * The 6-digit code alone is insufficient because the responder needs the
 * initiator's `msg1` to derive the same room id.
 */
export function SidecarReceivePage(): JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>({ tag: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  const start = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    const prefill = parsePrefill();
    if (prefill === null) {
      setStatus({ tag: 'error', message: t('download.sidecarReceive.errors.MissingPrefill') });
      return;
    }
    const strategy = detectPerFileStrategy();
    if (strategy === null) {
      setStatus({ tag: 'error', message: t('download.sidecarReceive.errors.Generic') });
      return;
    }
    startedRef.current = true;
    setStatus({ tag: 'connecting' });
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const result = await pairSidecar({
        role: 'responder',
        code: prefill.code,
        msg1: prefill.msg1,
        iceServers: DEFAULT_ICE_SERVERS,
        abort: ac.signal,
      });
      // Open per-file save target. We don't know the photo list ahead of
      // time, so we pass an empty `photos` array; the user will be prompted
      // per photo by `openOne` for fsAccess strategies.
      const saveTarget = await openPerFileSaveTarget(strategy, []);
      let received = 0;
      const sink = createSidecarReceiveSink({
        saveTarget,
        onPhotoComplete: (): void => {
          received += 1;
          setStatus({ tag: 'connected', received });
        },
        onSessionEnd: (): void => {
          setStatus({ tag: 'done', received });
        },
        onAbort: (): void => {
          setStatus({ tag: 'error', message: t('download.sidecarReceive.errors.Aborted') });
        },
      });
      setStatus({ tag: 'connected', received: 0 });

      result.peer.onFrame((sealed): void => {
        // Process asynchronously. Errors abort the whole receive.
        void (async (): Promise<void> => {
          try {
            const plaintext = await result.tunnel.recv.open(sealed);
            const frame = decodeFrame(plaintext);
            await sink.process(frame);
          } catch (err) {
            log.warn('frame processing failed', { errorName: err instanceof Error ? err.name : 'Unknown' });
            setStatus({ tag: 'error', message: t('download.sidecarReceive.errors.Generic') });
            await sink.close().catch(() => undefined);
            await result.close().catch(() => undefined);
          }
        })();
      });
    } catch (err) {
      const code = err instanceof PairingError ? err.code : 'Generic';
      setStatus({ tag: 'error', message: t(`download.sidecarReceive.errors.${code}`, { defaultValue: t('download.sidecarReceive.errors.Generic') }) });
      log.warn('pairing failed', { code });
    }
  }, [t]);

  useEffect((): (() => void) => {
    return (): void => { abortRef.current?.abort(); };
  }, []);

  return (
    <div className="sidecar-receive-page" data-testid="sidecar-receive-page">
      <h1>{t('download.sidecarReceive.pageTitle')}</h1>
      <p>{t('download.sidecarReceive.instructions')}</p>
      {status.tag === 'idle' ? (
        <button type="button" onClick={(): void => { void start(); }} data-testid="sidecar-receive-connect">
          {t('download.sidecarReceive.connect')}
        </button>
      ) : null}
      {status.tag === 'connecting' ? <p data-testid="sidecar-receive-status">{t('download.sidecarReceive.connecting')}</p> : null}
      {status.tag === 'connected' ? <p data-testid="sidecar-receive-status">{t('download.sidecarReceive.connected')}</p> : null}
      {status.tag === 'done' ? <p data-testid="sidecar-receive-status">{t('download.sidecarReceive.done', { count: status.received })}</p> : null}
      {status.tag === 'error' ? <p role="alert" data-testid="sidecar-receive-error">{status.message}</p> : null}
    </div>
  );
}
