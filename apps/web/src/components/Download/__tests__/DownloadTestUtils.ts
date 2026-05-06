import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface RenderResult {
  readonly container: HTMLDivElement;
  readonly rerender: (element: ReactElement) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

export async function render(element: ReactElement): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });
  return {
    container,
    rerender: async (nextElement: ReactElement): Promise<void> => {
      await act(async () => {
        root.render(nextElement);
        await flushMicrotasks();
      });
    },
    unmount: async (): Promise<void> => {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

export async function keyDown(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await flushMicrotasks();
  });
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function requireElement<T extends Element = Element>(element: T | null): T {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  return element;
}

export function textContent(container: ParentNode): string {
  return container.textContent ?? '';
}

export function element(type: string): ReactElement {
  return createElement(type);
}
