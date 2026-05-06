import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarReceivePage } from '../SidecarReceivePage';
import { render, click, requireElement } from '../../Download/__tests__/DownloadTestUtils';

vi.mock('../../../lib/sidecar/pairing', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
  return {
    ...actual,
    pairSidecar: vi.fn(),
  };
});

vi.mock('../../../lib/save-target', () => ({
  detectPerFileStrategy: (): 'fsAccessPerFile' | null => 'fsAccessPerFile',
  openPerFileSaveTarget: vi.fn(async () => ({
    openOne: vi.fn(),
    finalize: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>): string => {
      if (key === 'download.sidecarReceive.done') return 'Done. ' + String(opts?.['count']) + ' photos saved.';
      const dict: Record<string, string> = {
        'download.sidecarReceive.pageTitle': 'Receive photos',
        'download.sidecarReceive.instructions': 'Enter the 6-digit code',
        'download.sidecarReceive.connect': 'Connect',
        'download.sidecarReceive.connecting': 'Connecting',
        'download.sidecarReceive.connected': 'Connected. Receiving photos',
        'download.sidecarReceive.errors.MissingPrefill': 'This page must be opened via the QR code or pairing link.',
        'download.sidecarReceive.errors.WrongCode': 'Wrong code.',
        'download.sidecarReceive.errors.Generic': 'Connection failed.',
        'download.sidecarReceive.errors.Aborted': 'Cancelled.',
      };
      return dict[key] ?? key;
    },
  }),
}));

afterEach(() => {
  document.body.replaceChildren();
  window.location.hash = '';
});

describe('SidecarReceivePage', () => {
  it('renders the title + connect button when idle', async () => {
    const r = await render(<SidecarReceivePage />);
    expect(r.container.textContent).toContain('Receive photos');
    expect(r.container.querySelector('[data-testid="sidecar-receive-connect"]')).not.toBeNull();
    await r.unmount();
  });

  it('shows MissingPrefill error when there is no fragment', async () => {
    window.location.hash = '';
    const r = await render(<SidecarReceivePage />);
    await click(requireElement(r.container.querySelector('[data-testid="sidecar-receive-connect"]')));
    const err = r.container.querySelector('[data-testid="sidecar-receive-error"]');
    expect(err?.textContent).toContain('pairing link');
    await r.unmount();
  });

  it('calls pairSidecar with parsed code+msg1 when fragment is valid', async () => {
    const mod = await import('../../../lib/sidecar/pairing');
    const pairSidecar = mod.pairSidecar as unknown as ReturnType<typeof vi.fn>;
    pairSidecar.mockReturnValue(new Promise(() => undefined));
    window.location.hash = '#m=AAAA&c=123456';
    const r = await render(<SidecarReceivePage />);
    await click(requireElement(r.container.querySelector('[data-testid="sidecar-receive-connect"]')));
    expect(pairSidecar).toHaveBeenCalledTimes(1);
    const call = pairSidecar.mock.calls[0]?.[0] as { role: string; code: Uint8Array; msg1: Uint8Array };
    expect(call.role).toBe('responder');
    expect(Array.from(call.code)).toEqual([0x31, 0x32, 0x33, 0x34, 0x35, 0x36]);
    expect(call.msg1.byteLength).toBeGreaterThan(0);
    await r.unmount();
  });

  it('renders a localized error when pairing fails with WrongCode', async () => {
    const mod = await import('../../../lib/sidecar/pairing');
    const pairSidecar = mod.pairSidecar as unknown as ReturnType<typeof vi.fn>;
    const actual = await vi.importActual<typeof import('../../../lib/sidecar/pairing')>('../../../lib/sidecar/pairing');
    pairSidecar.mockRejectedValue(new actual.PairingError('WrongCode'));
    window.location.hash = '#m=AAAA&c=000000';
    const r = await render(<SidecarReceivePage />);
    await click(requireElement(r.container.querySelector('[data-testid="sidecar-receive-connect"]')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const err = r.container.querySelector('[data-testid="sidecar-receive-error"]');
    expect(err?.textContent).toBe('Wrong code.');
    await r.unmount();
  });
});
