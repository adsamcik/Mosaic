import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarPairingModal } from '../SidecarPairingModal';
import { render, click, requireElement } from './DownloadTestUtils';

const pairingMocks = vi.hoisted(() => ({
  pairSidecarInitiatorBegin: vi.fn(),
}));

vi.mock('../../../lib/sidecar/pairing', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
  return {
    ...actual,
    pairSidecarInitiatorBegin: pairingMocks.pairSidecarInitiatorBegin,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>): string => {
      if (key === 'download.sidecarPairing.expiresIn') return `expires in ${opts?.['seconds']}s`;
      const dict: Record<string, string> = {
        'download.sidecarPairing.title': 'Send to my phone',
        'download.sidecarPairing.instructions': 'Open Mosaic on your phone',
        'download.sidecarPairing.codeLabel': 'Pairing code',
        'download.sidecarPairing.cancel': 'Cancel',
        'download.sidecarPairing.qrHint': 'Or scan the QR code',
        'download.sidecarPairing.qrAriaLabel': 'Pairing QR code',
        'download.sidecarPairing.preparingQr': 'Preparing QR…',
        'download.sidecarPairing.errors.WrongCode': 'Wrong code or no peer joined.',
        'download.sidecarPairing.errors.Generic': 'Pairing failed.',
      };
      return dict[key] ?? key;
    },
  }),
}));

interface FakePrefix {
  msg1: Uint8Array;
  resume: () => Promise<unknown>;
  abort: () => void;
}

function makePrefix(opts: { msg1?: Uint8Array; resume?: () => Promise<unknown> } = {}): FakePrefix {
  return {
    msg1: opts.msg1 ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    resume: opts.resume ?? ((): Promise<unknown> => new Promise(() => undefined)),
    abort: vi.fn(),
  };
}

describe('SidecarPairingModal', () => {
  afterEach(() => {
    document.body.replaceChildren();
    pairingMocks.pairSidecarInitiatorBegin.mockReset();
  });

  it('renders a 6-digit code with a TTL countdown and the cancel button', async () => {
    pairingMocks.pairSidecarInitiatorBegin.mockResolvedValue(makePrefix());
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />,
    );
    const codeEl = requireElement(r.container.querySelector('[data-testid="sidecar-pairing-code"]'));
    const text = (codeEl.textContent ?? '').replace(/\s+/g, '');
    expect(text).toMatch(/^[0-9]{6}$/);
    const ttl = requireElement(r.container.querySelector('[data-testid="sidecar-pairing-ttl"]'));
    expect(ttl.textContent ?? '').toMatch(/expires in \d+s/);
    expect(r.container.querySelector('[data-testid="sidecar-pairing-cancel"]')).not.toBeNull();
    await r.unmount();
  });

  it('renders a /pair#m=...&c=... URL once msg1 is available', async () => {
    pairingMocks.pairSidecarInitiatorBegin.mockResolvedValue(makePrefix({
      msg1: new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]),
    }));
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />,
    );
    // Wait a microtask for begin()
    await new Promise((resolve) => setTimeout(resolve, 10));
    const url = r.container.querySelector('[data-testid="sidecar-pairing-url"]');
    expect(url?.textContent ?? '').toMatch(/\/pair#m=[A-Za-z0-9_-]+&c=\d{6}$/);
    await r.unmount();
  });

  it('renders a QR code as inline SVG', async () => {
    pairingMocks.pairSidecarInitiatorBegin.mockResolvedValue(makePrefix());
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const qr = r.container.querySelector('[data-testid="sidecar-pairing-qr"]');
    expect(qr).not.toBeNull();
    // qrcode-generator emits an <svg> element.
    expect(qr?.querySelector('svg')).not.toBeNull();
    await r.unmount();
  });

  it('completes pairing when resume() resolves and fires onPaired', async () => {
    const fakeResult = {
      tunnel: { send: { seal: async (b: Uint8Array): Promise<Uint8Array> => b }, recv: { open: async (b: Uint8Array): Promise<Uint8Array> => b }, close: async (): Promise<void> => undefined },
      peer: {
        ready: async (): Promise<void> => undefined,
        sendFrame: async (): Promise<void> => undefined,
        onFrame: () => () => {},
        onState: () => () => {},
        close: async (): Promise<void> => undefined,
      },
      signaling: { state: 'open', send: async (): Promise<void> => undefined, onFrame: () => () => {}, onClose: () => () => {}, onError: () => () => {}, close: () => undefined },
      close: async (): Promise<void> => undefined,
    };
    pairingMocks.pairSidecarInitiatorBegin.mockResolvedValue(makePrefix({
      resume: async () => fakeResult,
    }));
    const onPaired = vi.fn();
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={onPaired} onCancel={vi.fn()} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onPaired.mock.calls[0]?.[1]).toBe('zip');
    await r.unmount();
  });

  it('cancel button aborts the handshake and fires onCancel', async () => {
    let capturedAbort: AbortSignal | undefined;
    pairingMocks.pairSidecarInitiatorBegin.mockImplementation((opts: { abort?: AbortSignal }) => {
      capturedAbort = opts.abort;
      return Promise.resolve(makePrefix());
    });
    const onCancel = vi.fn();
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={onCancel} />,
    );
    await click(requireElement(r.container.querySelector('[data-testid="sidecar-pairing-cancel"]')));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(capturedAbort?.aborted).toBe(true);
    await r.unmount();
  });

  it('uniformly distributes generated digits (smoke test)', async () => {
    pairingMocks.pairSidecarInitiatorBegin.mockResolvedValue(makePrefix());
    const counts = new Array(10).fill(0) as number[];
    for (let i = 0; i < 200; i += 1) {
      const r = await render(<SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />);
      const codeEl = requireElement(r.container.querySelector('[data-testid="sidecar-pairing-code"]'));
      const txt = (codeEl.textContent ?? '').replace(/\s+/g, '');
      for (const ch of txt) counts[Number(ch)] = (counts[Number(ch)] ?? 0) + 1;
      await r.unmount();
    }
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    expect(min).toBeGreaterThan(0);
    expect(max / Math.max(1, min)).toBeLessThan(4);
  });

  it('renders a localized error when pairing throws PairingError(WrongCode)', async () => {
    const { PairingError } = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
    pairingMocks.pairSidecarInitiatorBegin.mockRejectedValue(new PairingError('WrongCode'));
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const err = r.container.querySelector('[data-testid="sidecar-pairing-error"]');
    expect(err?.textContent).toBe('Wrong code or no peer joined.');
    await r.unmount();
  });
});
