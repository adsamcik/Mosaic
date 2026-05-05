import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logger } from './lib/logger';
import { registerServiceWorker } from './lib/service-worker-registration';

// Initialize i18n - must be imported before any components that use translations
import './lib/i18n';

// Global error handler for uncaught errors
window.addEventListener('error', (event) => {
  logger.error('Uncaught error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
  });
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled promise rejection', {
    reason: event.reason,
  });
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

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
