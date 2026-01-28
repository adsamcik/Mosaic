/**
 * Toast Context and Components Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '../src/contexts/ToastContext';
import { ToastContainer } from '../src/components/Toast/ToastContainer';
import { useErrorToast } from '../src/hooks/useErrorToast';

// Test component that exposes toast methods
function TestToastConsumer({ onMount }: { onMount: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  onMount(api);
  return null;
}

// Test component for useErrorToast
function TestErrorToastConsumer({ onMount }: { onMount: (api: ReturnType<typeof useErrorToast>) => void }) {
  const api = useErrorToast();
  onMount(api);
  return null;
}

describe('ToastContext', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should throw when useToast is used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    expect(() => {
      act(() => {
        root.render(createElement(TestToastConsumer, { onMount: () => {} }));
      });
    }).toThrow('useToast must be used within ToastProvider');
    
    consoleSpy.mockRestore();
  });

  it('should provide toast context when inside provider', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    expect(api).not.toBeNull();
    expect(api!.toasts).toEqual([]);
    expect(typeof api!.addToast).toBe('function');
    expect(typeof api!.removeToast).toBe('function');
  });

  it('should add and remove toasts', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    let toastId: string = '';
    
    act(() => {
      toastId = api!.addToast({ message: 'Test message', type: 'success', duration: 0 });
    });
    
    expect(api!.toasts).toHaveLength(1);
    expect(api!.toasts[0]).toEqual({
      id: toastId,
      message: 'Test message',
      type: 'success',
      duration: 0,
    });
    
    act(() => {
      api!.removeToast(toastId);
    });
    
    expect(api!.toasts).toHaveLength(0);
  });

  it('should auto-dismiss toasts after duration', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Auto dismiss', type: 'info', duration: 3000 });
    });
    
    expect(api!.toasts).toHaveLength(1);
    
    // Advance timers by 3 seconds
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    
    expect(api!.toasts).toHaveLength(0);
  });

  it('should not auto-dismiss when duration is 0', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Persistent', type: 'error', duration: 0 });
    });
    
    expect(api!.toasts).toHaveLength(1);
    
    // Advance timers by a long time
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    
    // Still there
    expect(api!.toasts).toHaveLength(1);
  });

  it('should use default duration of 5000ms', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Default duration', type: 'success' });
    });
    
    expect(api!.toasts).toHaveLength(1);
    
    // Before 5 seconds
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(api!.toasts).toHaveLength(1);
    
    // After 5 seconds
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(api!.toasts).toHaveLength(0);
  });
});

describe('ToastContainer', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should render nothing when no toasts', () => {
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(ToastContainer)
        )
      );
    });
    
    expect(container.querySelector('[data-testid="toast-container"]')).toBeNull();
  });

  it('should render toasts with correct testids', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } }),
          createElement(ToastContainer)
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Success!', type: 'success', duration: 0 });
      api!.addToast({ message: 'Error!', type: 'error', duration: 0 });
      api!.addToast({ message: 'Warning!', type: 'warning', duration: 0 });
      api!.addToast({ message: 'Info!', type: 'info', duration: 0 });
    });
    
    expect(container.querySelector('[data-testid="toast-container"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toast-success"]')?.textContent).toContain('Success!');
    expect(container.querySelector('[data-testid="toast-error"]')?.textContent).toContain('Error!');
    expect(container.querySelector('[data-testid="toast-warning"]')?.textContent).toContain('Warning!');
    expect(container.querySelector('[data-testid="toast-info"]')?.textContent).toContain('Info!');
  });

  it('should dismiss toast when clicking dismiss button', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } }),
          createElement(ToastContainer)
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Dismissable', type: 'info', duration: 0 });
    });
    
    expect(container.textContent).toContain('Dismissable');
    
    const dismissButton = container.querySelector('[data-testid="toast-dismiss"]') as HTMLButtonElement;
    expect(dismissButton).not.toBeNull();
    
    act(() => {
      dismissButton.click();
    });
    
    expect(container.textContent).not.toContain('Dismissable');
  });

  it('should have accessible role and aria-live', () => {
    let api: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestToastConsumer, { onMount: (a) => { api = a; } }),
          createElement(ToastContainer)
        )
      );
    });
    
    act(() => {
      api!.addToast({ message: 'Accessible toast', type: 'success', duration: 0 });
    });
    
    const toast = container.querySelector('[role="alert"]');
    expect(toast).not.toBeNull();
    expect(toast?.getAttribute('aria-live')).toBe('assertive');
  });
});

describe('useErrorToast', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should provide showError, showSuccess, showWarning, showInfo methods', () => {
    let api: ReturnType<typeof useErrorToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { api = a; } })
        )
      );
    });
    
    expect(typeof api!.showError).toBe('function');
    expect(typeof api!.showSuccess).toBe('function');
    expect(typeof api!.showWarning).toBe('function');
    expect(typeof api!.showInfo).toBe('function');
    expect(typeof api!.withErrorToast).toBe('function');
  });

  it('should show error toast with default 8 second duration', () => {
    let errorApi: ReturnType<typeof useErrorToast> | null = null;
    let toastApi: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { errorApi = a; } }),
          createElement(TestToastConsumer, { onMount: (a) => { toastApi = a; } })
        )
      );
    });
    
    act(() => {
      errorApi!.showError('Test error');
    });
    
    expect(toastApi!.toasts).toHaveLength(1);
    expect(toastApi!.toasts[0].type).toBe('error');
    expect(toastApi!.toasts[0].message).toBe('Test error');
    
    // Before 8 seconds
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(toastApi!.toasts).toHaveLength(1);
    
    // After 8 seconds
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toastApi!.toasts).toHaveLength(0);
  });

  it('should show success toast with default 4 second duration', () => {
    let errorApi: ReturnType<typeof useErrorToast> | null = null;
    let toastApi: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { errorApi = a; } }),
          createElement(TestToastConsumer, { onMount: (a) => { toastApi = a; } })
        )
      );
    });
    
    act(() => {
      errorApi!.showSuccess('Success message');
    });
    
    expect(toastApi!.toasts).toHaveLength(1);
    expect(toastApi!.toasts[0].type).toBe('success');
    
    // After 4 seconds
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(toastApi!.toasts).toHaveLength(0);
  });

  it('withErrorToast should catch errors and show toast', async () => {
    let errorApi: ReturnType<typeof useErrorToast> | null = null;
    let toastApi: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { errorApi = a; } }),
          createElement(TestToastConsumer, { onMount: (a) => { toastApi = a; } }),
          createElement(ToastContainer)
        )
      );
    });
    
    const failingFn = async () => {
      throw new Error('Something went wrong');
    };
    
    const wrapped = errorApi!.withErrorToast(failingFn);
    
    await act(async () => {
      const result = await wrapped();
      expect(result).toBeUndefined();
    });
    
    expect(toastApi!.toasts).toHaveLength(1);
    expect(toastApi!.toasts[0].type).toBe('error');
    expect(toastApi!.toasts[0].message).toBe('Something went wrong');
  });

  it('withErrorToast should include prefix in error message', async () => {
    let errorApi: ReturnType<typeof useErrorToast> | null = null;
    let toastApi: ReturnType<typeof useToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { errorApi = a; } }),
          createElement(TestToastConsumer, { onMount: (a) => { toastApi = a; } })
        )
      );
    });
    
    const failingFn = async () => {
      throw new Error('Network timeout');
    };
    
    const wrapped = errorApi!.withErrorToast(failingFn, 'Failed to save');
    
    await act(async () => {
      await wrapped();
    });
    
    expect(toastApi!.toasts[0].message).toBe('Failed to save: Network timeout');
  });

  it('withErrorToast should return value on success', async () => {
    let errorApi: ReturnType<typeof useErrorToast> | null = null;
    
    act(() => {
      root.render(
        createElement(ToastProvider, null,
          createElement(TestErrorToastConsumer, { onMount: (a) => { errorApi = a; } })
        )
      );
    });
    
    const successFn = async () => {
      return { data: 'test' };
    };
    
    const wrapped = errorApi!.withErrorToast(successFn);
    
    let result: { data: string } | undefined;
    await act(async () => {
      result = await wrapped();
    });
    
    expect(result).toEqual({ data: 'test' });
  });
});
