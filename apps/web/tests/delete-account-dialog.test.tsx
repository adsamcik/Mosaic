/**
 * DeleteAccountConfirmationDialog tests (v1.0.1 s15 — GDPR Art.17).
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteAccountConfirmationDialog } from '../src/components/Settings/DeleteAccountConfirmationDialog';

// ── Hoisted mocks ────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file, so any reference inside its
// factory must also be hoisted via vi.hoisted.
const h = vi.hoisted(() => {
  return {
    deleteCurrentUser: vi.fn<(req: unknown) => Promise<void>>(() => Promise.resolve()),
    sessionLogout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    clearAllLocalState: vi.fn(() => Promise.resolve({ allOk: true, steps: [] })),
    closeDbClient: vi.fn(() => Promise.resolve()),
    initAuth: vi.fn(() =>
      Promise.resolve({
        challengeId: 'chal-123',
        challenge: btoa('challenge-bytes'),
        timestamp: 1700000000000,
        userSalt: 'salt',
        kdfMemoryKib: 65536,
        kdfIterations: 3,
        kdfParallelism: 1,
        kdfAlgVersion: 0x13,
      }),
    ),
    isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
    signAuthChallenge: vi.fn(() =>
      Promise.resolve(new Uint8Array(64).fill(0x42)),
    ),
  };
});

vi.mock('../src/lib/api', () => ({
  getApi: () => ({ deleteCurrentUser: h.deleteCurrentUser }),
  toBase64: (data: Uint8Array) =>
    btoa(String.fromCharCode(...Array.from(data))),
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

vi.mock('../src/lib/session', () => ({
  session: { logout: h.sessionLogout },
}));

vi.mock('../src/lib/local-purge-all', () => ({
  clearAllLocalState: h.clearAllLocalState,
}));

vi.mock('../src/lib/db-client', () => ({
  closeDbClient: h.closeDbClient,
}));

vi.mock('../src/lib/local-auth', () => ({
  initAuth: h.initAuth,
  isLocalAuthMode: h.isLocalAuthMode,
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () =>
    Promise.resolve({ signAuthChallenge: h.signAuthChallenge }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

// ── Tests ────────────────────────────────────────────────────────────

describe('DeleteAccountConfirmationDialog', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let onClose: ReturnType<typeof vi.fn>;
  let onDeleted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
    onDeleted = vi.fn();
    h.deleteCurrentUser.mockReset().mockResolvedValue();
    h.sessionLogout.mockReset().mockResolvedValue();
    h.clearAllLocalState.mockReset().mockResolvedValue({ allOk: true, steps: [] });
    h.closeDbClient.mockReset().mockResolvedValue();
    h.isLocalAuthMode.mockReset().mockResolvedValue(false);
    h.initAuth.mockReset().mockResolvedValue({
      challengeId: 'chal-123',
      challenge: btoa('challenge-bytes'),
      timestamp: 1700000000000,
      userSalt: 'salt',
      kdfMemoryKib: 65536,
      kdfIterations: 3,
      kdfParallelism: 1,
      kdfAlgVersion: 0x13,
    });
    h.signAuthChallenge.mockReset().mockResolvedValue(new Uint8Array(64).fill(0x42));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (username = 'alice') => {
    await act(async () => {
      root.render(
        createElement(DeleteAccountConfirmationDialog, {
          username,
          onClose,
          onDeleted,
        }),
      );
      await Promise.resolve();
    });
  };

  const typeInto = async (text: string) => {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="delete-account-confirm-input"]',
    )!;
    await act(async () => {
      // React tracks the previous value on the DOM node — set via the
      // descriptor so the synthetic onChange actually fires.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const clickConfirm = async () => {
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="delete-account-confirm-button"]',
    )!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  };

  it('keeps the confirm button disabled until typed text matches the username', async () => {
    await render('alice');
    const confirmBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="delete-account-confirm-button"]',
    )!;
    expect(confirmBtn.disabled).toBe(true);

    await typeInto('bob');
    expect(confirmBtn.disabled).toBe(true);

    await typeInto('alice');
    expect(confirmBtn.disabled).toBe(false);
  });

  it('calls deleteCurrentUser without signature in ProxyAuth mode and purges local state on success', async () => {
    h.isLocalAuthMode.mockResolvedValue(false);
    await render('alice');
    await typeInto('alice');
    await clickConfirm();

    expect(h.deleteCurrentUser).toHaveBeenCalledTimes(1);
    const body = h.deleteCurrentUser.mock.calls[0]![0] as {
      confirmationText: string;
      challengeId?: string;
    };
    expect(body.confirmationText).toBe('alice');
    expect(body.challengeId).toBeUndefined();

    expect(h.clearAllLocalState).toHaveBeenCalled();
    expect(h.sessionLogout).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('attaches a fresh challengeId + signature + timestamp in LocalAuth mode', async () => {
    h.isLocalAuthMode.mockResolvedValue(true);
    await render('alice');
    await typeInto('alice');
    await clickConfirm();

    expect(h.initAuth).toHaveBeenCalledWith('alice');
    expect(h.signAuthChallenge).toHaveBeenCalled();
    const body = h.deleteCurrentUser.mock.calls[0]![0] as {
      challengeId?: string;
      confirmationSignature?: string;
      timestamp?: number;
    };
    expect(body.challengeId).toBe('chal-123');
    expect(body.timestamp).toBe(1700000000000);
    expect(body.confirmationSignature).toBeTruthy();
  });

  it('shows a fresh-auth error if signing fails in LocalAuth mode', async () => {
    h.isLocalAuthMode.mockResolvedValue(true);
    h.signAuthChallenge.mockRejectedValueOnce(new Error('no auth key'));
    await render('alice');
    await typeInto('alice');
    await clickConfirm();

    expect(h.deleteCurrentUser).not.toHaveBeenCalled();
    const err = container.querySelector('[data-testid="delete-account-error"]');
    expect(err?.textContent).toContain('errorFreshAuth');
  });

  it('surfaces a generic error when the API rejects and keeps the dialog open', async () => {
    h.deleteCurrentUser.mockRejectedValueOnce(new Error('server boom'));
    await render('alice');
    await typeInto('alice');
    await clickConfirm();

    const err = container.querySelector('[data-testid="delete-account-error"]');
    expect(err?.textContent).toContain('errorGeneric');
    expect(h.sessionLogout).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

