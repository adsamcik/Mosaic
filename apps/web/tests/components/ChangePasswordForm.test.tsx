/**
 * ChangePasswordForm Tests (v1.0.x sweep38, Item 3)
 *
 * Covers:
 *  - Mismatch shows inline error and does not call rotatePassword
 *  - Same as current shows inline error
 *  - Successful submit calls rotatePassword with the correct payload
 *    and shows the success toast
 *  - Bad-current reason maps to errorBadCurrent message
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  rotatePassword: vi.fn(),
}));

vi.mock('../../src/lib/password-rotation', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/password-rotation')
  >('../../src/lib/password-rotation');
  return {
    ...actual,
    rotatePassword: mocks.rotatePassword,
  };
});

import { ChangePasswordForm } from '../../src/components/Settings/ChangePasswordForm';
import {
  PasswordRotationError,
  estimatePasswordStrength,
} from '../../src/lib/password-rotation';

interface RenderResult {
  container: HTMLDivElement;
  cleanup: () => void;
}

async function renderForm(): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChangePasswordForm));
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function fillField(
  container: HTMLElement,
  testId: string,
  value: string,
) {
  const input = container.querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ChangePasswordForm (sweep38)', () => {
  beforeEach(() => {
    mocks.rotatePassword.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows mismatch error when confirmation does not match', async () => {
    const r = await renderForm();
    try {
      await fillField(r.container, 'change-password-current', 'oldpassword!!');
      await fillField(r.container, 'change-password-new', 'NewPassword12!');
      await fillField(
        r.container,
        'change-password-confirm',
        'DifferentPwd99!',
      );
      const form = r.container.querySelector(
        '[data-testid="change-password-form"]',
      ) as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });
      const err = r.container.querySelector(
        '[data-testid="change-password-error"]',
      );
      expect(err?.textContent).toContain('settings.password.mismatchError');
      expect(mocks.rotatePassword).not.toHaveBeenCalled();
    } finally {
      r.cleanup();
    }
  });

  it('rejects when new password equals current', async () => {
    const r = await renderForm();
    try {
      const pwd = 'SamePassword12!';
      await fillField(r.container, 'change-password-current', pwd);
      await fillField(r.container, 'change-password-new', pwd);
      await fillField(r.container, 'change-password-confirm', pwd);
      const form = r.container.querySelector(
        '[data-testid="change-password-form"]',
      ) as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });
      const err = r.container.querySelector(
        '[data-testid="change-password-error"]',
      );
      expect(err?.textContent).toContain(
        'settings.password.sameAsCurrentError',
      );
      expect(mocks.rotatePassword).not.toHaveBeenCalled();
    } finally {
      r.cleanup();
    }
  });

  it('calls rotatePassword and shows success toast on success', async () => {
    mocks.rotatePassword.mockResolvedValueOnce({ revokedSessions: 2 });
    const r = await renderForm();
    try {
      await fillField(r.container, 'change-password-current', 'oldpassword12');
      await fillField(r.container, 'change-password-new', 'NewPassword12!');
      await fillField(r.container, 'change-password-confirm', 'NewPassword12!');
      const form = r.container.querySelector(
        '[data-testid="change-password-form"]',
      ) as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mocks.rotatePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpassword12',
        newPassword: 'NewPassword12!',
      });
      const success = r.container.querySelector(
        '[data-testid="change-password-success"]',
      );
      expect(success).toBeTruthy();
    } finally {
      r.cleanup();
    }
  });

  it('maps PasswordRotationError(bad-current) to errorBadCurrent', async () => {
    mocks.rotatePassword.mockRejectedValueOnce(
      new PasswordRotationError('nope', 'bad-current', 401),
    );
    const r = await renderForm();
    try {
      await fillField(r.container, 'change-password-current', 'wrongpassword');
      await fillField(r.container, 'change-password-new', 'NewPassword12!');
      await fillField(r.container, 'change-password-confirm', 'NewPassword12!');
      const form = r.container.querySelector(
        '[data-testid="change-password-form"]',
      ) as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const err = r.container.querySelector(
        '[data-testid="change-password-error"]',
      );
      expect(err?.textContent).toContain('settings.password.errorBadCurrent');
    } finally {
      r.cleanup();
    }
  });

  it('strength heuristic classifies passwords', () => {
    expect(estimatePasswordStrength('short')).toBe('weak');
    expect(estimatePasswordStrength('alllowercase')).toBe('weak');
    expect(estimatePasswordStrength('Mixedcase123')).toBe('ok');
    expect(estimatePasswordStrength('LongMixedCase123!')).toBe('strong');
  });
});
