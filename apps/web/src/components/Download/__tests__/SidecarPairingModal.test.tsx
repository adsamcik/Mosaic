import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarPairingModal } from '../SidecarPairingModal';
import { render, click, requireElement } from './DownloadTestUtils';

const pairingMocks = vi.hoisted(() => ({
  pairSidecar: vi.fn(),
}));

vi.mock('../../../lib/sidecar/pairing', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
  return {
    ...actual,
    pairSidecar: pairingMocks.pairSidecar,
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
        'download.sidecarPairing.errors.WrongCode': 'Wrong code or no peer joined.',
        'download.sidecarPairing.errors.Generic': 'Pairing failed.',
      };
      return dict[key] ?? key;
    },
  }),
}));

describe('SidecarPairingModal', () => {
  afterEach(() => {
    document.body.replaceChildren();
    pairingMocks.pairSidecar.mockReset();
  });

  it('renders a 6-digit code with a TTL countdown and the cancel button', async () => {
    pairingMocks.pairSidecar.mockReturnValue(new Promise(() => undefined)); // never resolves
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

  it('cancel button aborts the handshake and fires onCancel', async () => {
    let capturedAbort: AbortSignal | undefined;
    pairingMocks.pairSidecar.mockImplementation((opts: { abort?: AbortSignal }) => {
      capturedAbort = opts.abort;
      return new Promise(() => undefined);
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

  it('uniformly distributes generated digits (smoke test, 1000 samples)', async () => {
    // Statistical sanity check that the rejection sampler does not bias one digit.
    pairingMocks.pairSidecar.mockReturnValue(new Promise(() => undefined));
    const counts = new Array(10).fill(0) as number[];
    for (let i = 0; i < 200; i += 1) {
      const r = await render(<SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />);
      const codeEl = requireElement(r.container.querySelector('[data-testid="sidecar-pairing-code"]'));
      const txt = (codeEl.textContent ?? '').replace(/\s+/g, '');
      for (const ch of txt) counts[Number(ch)] = (counts[Number(ch)] ?? 0) + 1;
      await r.unmount();
    }
    // No bucket should be more than 4x the smallest (extremely lax bound).
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    expect(min).toBeGreaterThan(0);
    expect(max / Math.max(1, min)).toBeLessThan(4);
  });

  it('renders a localized error when pairing throws PairingError(WrongCode)', async () => {
    const { PairingError } = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
    pairingMocks.pairSidecar.mockRejectedValue(new PairingError('WrongCode'));
    const r = await render(
      <SidecarPairingModal open fallback="zip" onPaired={vi.fn()} onCancel={vi.fn()} />,
    );
    // Wait a microtask for the rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const err = r.container.querySelector('[data-testid="sidecar-pairing-error"]');
    expect(err?.textContent).toBe('Wrong code or no peer joined.');
    await r.unmount();
  });
});
