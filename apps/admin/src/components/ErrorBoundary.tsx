import React, { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
}

/**
 * Default fallback UI component with i18n support
 */
function DefaultErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const { t } = useTranslation();
  
  return (
    <div className="error-boundary-fallback" style={defaultStyles.container}>
      <div style={defaultStyles.content}>
        <h2 style={defaultStyles.heading}>{t('error.somethingWentWrong')}</h2>
        <p style={defaultStyles.message}>
          {t('error.unexpectedError')}
        </p>
        <div style={defaultStyles.actions}>
          <button
            onClick={onReset}
            style={defaultStyles.button}
          >
            {t('common.tryAgain')}
          </button>
          <button
            onClick={() => window.location.reload()}
            style={defaultStyles.buttonSecondary}
          >
            {t('common.refreshPage')}
          </button>
        </div>
        {import.meta.env.DEV && (
          <details style={defaultStyles.details}>
            <summary style={defaultStyles.summary}>{t('error.technicalDetails')}</summary>
            <pre style={defaultStyles.pre}>
              {error.name}: {error.message}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary component that catches JavaScript errors in child components,
 * logs them, and displays a fallback UI instead of crashing the entire app.
 * 
 * Usage:
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 * 
 * With custom fallback:
 *   <ErrorBoundary fallback={<ErrorPage />}>
 *     <MyComponent />
 *   </ErrorBoundary>
 * 
 * With reset capability:
 *   <ErrorBoundary fallback={(error, reset) => (
 *     <div>
 *       <p>Something went wrong</p>
 *       <button onClick={reset}>Try again</button>
 *     </div>
 *   )}>
 *     <MyComponent />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log the error with component stack for debugging
    logger.error('React component error caught by ErrorBoundary', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      componentStack: errorInfo.componentStack,
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError && error) {
      // If fallback is a function, call it with error and reset handler
      if (typeof fallback === 'function') {
        return fallback(error, this.handleReset);
      }

      // If fallback is a ReactNode, render it
      if (fallback) {
        return fallback;
      }

      // Default fallback UI with i18n support
      return <DefaultErrorFallback error={error} onReset={this.handleReset} />;
    }

    return children;
  }
}

// Default styles for the fallback UI
const defaultStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '2rem',
    backgroundColor: 'var(--surface-primary, #1a1a1a)',
    color: 'var(--text-primary, #ffffff)',
  },
  content: {
    maxWidth: '500px',
    textAlign: 'center',
  },
  heading: {
    fontSize: '1.5rem',
    fontWeight: 600,
    marginBottom: '1rem',
    color: 'var(--text-primary, #ffffff)',
  },
  message: {
    fontSize: '1rem',
    marginBottom: '1.5rem',
    color: 'var(--text-secondary, #999999)',
  },
  actions: {
    display: 'flex',
    gap: '1rem',
    justifyContent: 'center',
    marginBottom: '1.5rem',
  },
  button: {
    padding: '0.75rem 1.5rem',
    fontSize: '1rem',
    fontWeight: 500,
    backgroundColor: 'var(--accent-primary, #3b82f6)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.5rem',
    cursor: 'pointer',
  },
  buttonSecondary: {
    padding: '0.75rem 1.5rem',
    fontSize: '1rem',
    fontWeight: 500,
    backgroundColor: 'transparent',
    color: 'var(--text-secondary, #999999)',
    border: '1px solid var(--border-secondary, #333333)',
    borderRadius: '0.5rem',
    cursor: 'pointer',
  },
  details: {
    textAlign: 'left',
    marginTop: '1rem',
  },
  summary: {
    cursor: 'pointer',
    color: 'var(--text-secondary, #999999)',
  },
  pre: {
    marginTop: '0.5rem',
    padding: '1rem',
    backgroundColor: 'var(--surface-secondary, #2a2a2a)',
    borderRadius: '0.5rem',
    overflow: 'auto',
    fontSize: '0.75rem',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
};

export default ErrorBoundary;
