import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logger, safeReason } from './lib/logger';
import { registerServiceWorker } from './lib/service-worker-registration';

// Initialize i18n - must be imported before any components that use translations
import './lib/i18n';

export function mountApp(container: HTMLElement): void {
  // Global error handler for uncaught errors. The browser may attach
  // arbitrary values to `event.error` (including promise wrappers around
  // crypto plaintext), so we coerce through `safeReason` rather than
  // forwarding the raw object — see lib/logger.ts:safeReason for rationale.
  window.addEventListener('error', (event) => {
    logger.error('Uncaught error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: safeReason(event.error),
    });
  });

  // Global handler for unhandled promise rejections. `event.reason` can
  // be ANY value the rejecting code chose to throw — must not be passed
  // verbatim to the logger.
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('Unhandled promise rejection', {
      reason: safeReason(event.reason),
    });
    // Dev / E2E diagnostic: surface the specific Comlink-proxy-release
    // race that the P0-IDENTITY-STRESS validation gate hunts so future
    // regressions are immediately attributable. Strictly opt-in via
    // VITE_E2E_WEAK_KEYS (already used to gate weak-KDF builds) or DEV
    // mode; not enabled in production logs.
    if (import.meta.env.DEV || import.meta.env.VITE_E2E_WEAK_KEYS === 'true') {
      const reason = event.reason as { message?: unknown; stack?: unknown } | null | undefined;
      const message = typeof reason?.message === 'string' ? reason.message : '';
      if (message.includes('rawValue.apply')) {
        // Use console.error so the stack survives logger redaction.
        // eslint-disable-next-line no-console
        console.error('[unhandledrejection rawValue.apply]', message,
          typeof reason?.stack === 'string' ? reason.stack : undefined);
      }
    }
  });

  // Best-effort SW registration: enables Background Fetch on Chromium browsers
  // (especially Android) so large downloads survive tab close / OS suspension.
  // No-op on Firefox/Safari and in dev (unless VITE_ENABLE_SW=1).
  void registerServiceWorker();

  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
