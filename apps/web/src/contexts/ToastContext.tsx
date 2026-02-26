import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

/**
 * Toast notification types
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast action button
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Individual toast notification
 */
export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  /** Optional action button */
  action?: ToastAction;
}

/**
 * Toast context value interface
 */
interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * ToastProvider Component
 * Manages toast notifications state and provides methods to add/remove toasts.
 * 
 * @example
 * ```tsx
 * <ToastProvider>
 *   <App />
 *   <ToastContainer />
 * </ToastProvider>
 * ```
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track active timers so we can clean them up
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timerRefs.current.forEach((timer) => clearTimeout(timer));
      timerRefs.current.clear();
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    // Clear timer if exists
    const timer = timerRefs.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRefs.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...toast, id }]);

    // Auto-dismiss after duration (default 5 seconds, 0 = no auto-dismiss)
    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      const timer = setTimeout(() => {
        removeToast(id);
      }, duration);
      timerRefs.current.set(id, timer);
    }

    return id;
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

/**
 * Hook to access toast notifications.
 * Must be used within a ToastProvider.
 * 
 * @example
 * ```tsx
 * const { addToast, removeToast } = useToast();
 * 
 * // Show a success toast
 * addToast({ message: 'Saved!', type: 'success' });
 * 
 * // Show an error toast that doesn't auto-dismiss
 * addToast({ message: 'Failed to save', type: 'error', duration: 0 });
 * ```
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
