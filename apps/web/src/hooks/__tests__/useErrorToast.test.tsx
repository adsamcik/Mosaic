import { act, createElement, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../../components/Toast/ToastContainer';
import { ToastProvider } from '../../contexts/ToastContext';
import { ApiError } from '../../lib/api';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../../workers/types';
import { useErrorToast } from '../useErrorToast';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { id?: string; defaultValue?: string }) =>
      options?.id !== undefined ? `Reference: ${options.id}` : options?.defaultValue,
  }),
}));

async function renderHarness(
  trigger: (api: ReturnType<typeof useErrorToast>) => void | Promise<void>,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent(): null {
    const api = useErrorToast();
    const triggered = useRef(false);
    useEffect(() => {
      if (triggered.current) {
        return;
      }
      triggered.current = true;
      void trigger(api);
    }, [api]);
    return null;
  }

  await act(async () => {
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(TestComponent),
        createElement(ToastContainer),
      ),
    );
  });

  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useErrorToast', () => {
  it('shows WorkerCryptoError code 207 as the curated message instead of raw worker text', async () => {
    const { container, root } = await renderHarness((api) => {
      api.showError(
        new WorkerCryptoError(
          WorkerCryptoErrorCode.WrappedKeyTooShort,
          'wrapped key too short: raw thiserror text',
        ),
      );
    });

    expect(container.textContent).toContain(
      'Security key error. Please try logging in again.',
    );
    expect(container.textContent).not.toContain('raw thiserror text');

    await act(async () => root.unmount());
  });

  it('surfaces ApiError ProblemDetails detail and selectable correlation reference', async () => {
    const { container, root } = await renderHarness((api) => {
      api.showError(
        new ApiError(
          409,
          'Conflict',
          undefined,
          {
            title: 'Conflict',
            status: 409,
            detail:
              'The resource was modified by another request. Please reload and try again.',
            correlationId: 'toast-correlation-id',
          },
          'toast-correlation-id',
        ),
      );
    });

    const toast = container.querySelector('[data-testid="toast-error"]');
    expect(toast?.textContent).toContain(
      'The resource was modified by another request. Please reload and try again.',
    );
    expect(toast?.textContent).toContain('Reference: toast-correlation-id');
    expect(toast?.textContent).not.toContain('This item already exists');

    await act(async () => root.unmount());
  });
});
