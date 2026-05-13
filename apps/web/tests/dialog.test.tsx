import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/components/Shared/Dialog';

describe('Dialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalShowModal: typeof HTMLDialogElement.prototype.showModal;
  let originalClose: typeof HTMLDialogElement.prototype.close;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalShowModal = HTMLDialogElement.prototype.showModal;
    originalClose = HTMLDialogElement.prototype.close;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    HTMLDialogElement.prototype.showModal = originalShowModal;
    HTMLDialogElement.prototype.close = originalClose;
    container.remove();
  });

  it('opens with native showModal to trap focus', async () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });

    await act(async () => {
      root.render(
        createElement(Dialog, {
          isOpen: true,
          onClose: vi.fn(),
          title: 'Test dialog',
          testId: 'test-dialog',
          children: createElement('button', null, 'Focusable'),
        }),
      );
    });

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="test-dialog"]')?.hasAttribute('open'),
    ).toBe(true);
  });
});
