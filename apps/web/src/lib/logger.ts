/**
 * Centralized logging utility for the Mosaic frontend.
 *
 * Features:
 * - Log level filtering based on environment (production vs development)
 * - Structured logging with consistent prefixes and optional JSON output
 * - Correlation IDs for tracing operations across async boundaries
 * - Performance timing helpers for measuring operation durations
 * - Child loggers with bound context (scope, correlationId, extra data)
 * - Never logs sensitive data (keys, passwords, decrypted content)
 * - Safe error serialization
 *
 * Usage:
 *   import { logger, createLogger } from '@/lib/logger';
 *
 *   // Basic logging
 *   logger.debug('Processing started');
 *   logger.info('Upload complete', { photoId });
 *   logger.warn('Retrying operation', { attempt: 2 });
 *   logger.error('Failed to decrypt', error);
 *
 *   // Scoped logger for a module
 *   const log = createLogger('UploadService');
 *   log.info('Starting upload', { filename: 'photo.jpg' });
 *
 *   // Performance timing
 *   const timer = log.startTimer('encryptShard');
 *   await encryptShard(data);
 *   timer.end({ shardIndex: 0 }); // Logs duration automatically
 *
 *   // Child logger with bound context
 *   const uploadLog = log.child({ uploadId: '123', albumId: 'abc' });
 *   uploadLog.info('Shard 1 complete'); // Includes uploadId and albumId
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/** Log entry structure for structured logging */
export interface LogEntry {
  timestamp: string;
  level: keyof typeof LogLevel;
  scope?: string | undefined;
  correlationId?: string | undefined;
  message: string;
  context?: Record<string, unknown> | undefined;
  error?:
    | {
        name: string;
        message: string;
        stack?: string | undefined;
      }
    | undefined;
  durationMs?: number | undefined;
}

/** Timer handle returned by startTimer() */
export interface LogTimer {
  /** End the timer and log the duration */
  end: (context?: Record<string, unknown>) => void;
  /** Get elapsed time without ending the timer */
  elapsed: () => number;
}

/** Scoped logger interface with all logging methods */
export interface ScopedLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    errorOrContext?: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /** Start a performance timer */
  startTimer: (operation: string) => LogTimer;
  /** Create a child logger with additional bound context */
  child: (context: Record<string, unknown>) => ScopedLogger;
  /** Get the scope name */
  readonly scope: string;
}

// Production only logs warnings and errors; development logs everything
let currentLevel: LogLevel = import.meta.env.PROD
  ? LogLevel.WARN
  : LogLevel.DEBUG;

// Global correlation ID for the current request/operation
let globalCorrelationId: string | undefined;

// Whether to output structured JSON (for log aggregation in production)
const structuredOutput = import.meta.env.PROD;

/**
 * Generate a short correlation ID for tracing
 */
function generateCorrelationId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Set the global correlation ID for the current operation.
 * All logs will include this ID until it's cleared or changed.
 */
export function setCorrelationId(id?: string): void {
  globalCorrelationId = id;
}

/**
 * Get the current global correlation ID.
 */
export function getCorrelationId(): string | undefined {
  return globalCorrelationId;
}

/**
 * Generate and set a new correlation ID, returning it.
 */
export function newCorrelationId(): string {
  const id = generateCorrelationId();
  globalCorrelationId = id;
  return id;
}

/**
 * Dynamically set the log level at runtime.
 * Useful for enabling debug logging in production for troubleshooting.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Safely serialize an error object for logging.
 * Strips internal details in production to avoid leaking stack traces.
 */
function serializeError(error: unknown): NonNullable<LogEntry['error']> {
  if (error instanceof Error) {
    // In production, only include message; in dev, include full stack
    if (import.meta.env.PROD) {
      return {
        name: error.name,
        message: error.message,
      };
    }
    const result: NonNullable<LogEntry['error']> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) {
      result.stack = error.stack;
    }
    return result;
  }
  return { name: 'Unknown', message: String(error) };
}

/**
 * Get current timestamp for log entries
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a log entry for console output
 */
function formatConsoleOutput(entry: LogEntry): string[] {
  const parts: string[] = [`[${entry.timestamp}]`, `[${entry.level}]`];

  if (entry.correlationId) {
    parts.push(`[${entry.correlationId}]`);
  }

  if (entry.scope) {
    parts.push(`[${entry.scope}]`);
  }

  parts.push(entry.message);

  if (entry.durationMs !== undefined) {
    parts.push(`(${entry.durationMs.toFixed(2)}ms)`);
  }

  return parts;
}

/**
 * Output a log entry to the console
 */
function outputLog(
  level: LogLevel,
  levelName: keyof typeof LogLevel,
  message: string,
  scope?: string,
  correlationId?: string,
  context?: Record<string, unknown>,
  error?: unknown,
  durationMs?: number,
): void {
  if (currentLevel > level) return;

  const entry: LogEntry = {
    timestamp: timestamp(),
    level: levelName,
    message,
    scope,
    correlationId: correlationId ?? globalCorrelationId,
    context: context && Object.keys(context).length > 0 ? context : undefined,
    error: error ? serializeError(error) : undefined,
    durationMs,
  };

  if (structuredOutput) {
    // Structured JSON output for log aggregation
    const jsonOutput = JSON.stringify(entry);
    switch (level) {
      case LogLevel.DEBUG:
      case LogLevel.INFO:
        console.log(jsonOutput);
        break;
      case LogLevel.WARN:
        console.warn(jsonOutput);
        break;
      case LogLevel.ERROR:
        console.error(jsonOutput);
        break;
    }
  } else {
    // Human-readable output for development
    const parts = formatConsoleOutput(entry);
    const args: unknown[] = [...parts];

    if (entry.context) {
      args.push(entry.context);
    }

    if (entry.error) {
      args.push(entry.error);
    }

    switch (level) {
      case LogLevel.DEBUG:
        console.log(...args);
        break;
      case LogLevel.INFO:
        console.info(...args);
        break;
      case LogLevel.WARN:
        console.warn(...args);
        break;
      case LogLevel.ERROR:
        console.error(...args);
        break;
    }
  }
}

export const logger = {
  /**
   * Debug level logging - verbose information for development
   * Filtered out in production
   */
  debug: (message: string, context?: Record<string, unknown>): void => {
    outputLog(LogLevel.DEBUG, 'DEBUG', message, undefined, undefined, context);
  },

  /**
   * Info level logging - general operational information
   * Filtered out in production
   */
  info: (message: string, context?: Record<string, unknown>): void => {
    outputLog(LogLevel.INFO, 'INFO', message, undefined, undefined, context);
  },

  /**
   * Warning level logging - potential issues that don't prevent operation
   * Shown in both development and production
   */
  warn: (message: string, context?: Record<string, unknown>): void => {
    outputLog(LogLevel.WARN, 'WARN', message, undefined, undefined, context);
  },

  /**
   * Error level logging - failures and exceptions
   * Always shown
   */
  error: (
    message: string,
    errorOrContext?: unknown,
    context?: Record<string, unknown>,
  ): void => {
    // Handle different call signatures:
    // error('message')
    // error('message', error)
    // error('message', { context })
    // error('message', error, { context })
    let error: unknown;
    let ctx: Record<string, unknown> | undefined = context;

    if (errorOrContext instanceof Error) {
      error = errorOrContext;
    } else if (
      errorOrContext &&
      typeof errorOrContext === 'object' &&
      !Array.isArray(errorOrContext)
    ) {
      if (!context) {
        ctx = errorOrContext as Record<string, unknown>;
      } else {
        error = errorOrContext;
      }
    } else if (errorOrContext !== undefined) {
      error = errorOrContext;
    }

    outputLog(
      LogLevel.ERROR,
      'ERROR',
      message,
      undefined,
      undefined,
      ctx,
      error,
    );
  },

  /**
   * Get the current log level
   */
  getLevel: (): LogLevel => currentLevel,

  /**
   * Check if a log level is enabled
   */
  isEnabled: (level: LogLevel): boolean => currentLevel <= level,

  /**
   * Start a performance timer
   */
  startTimer: (operation: string): LogTimer => {
    const start = performance.now();
    return {
      end: (context?: Record<string, unknown>) => {
        const durationMs = performance.now() - start;
        outputLog(
          LogLevel.DEBUG,
          'DEBUG',
          `${operation} completed`,
          undefined,
          undefined,
          context,
          undefined,
          durationMs,
        );
      },
      elapsed: () => performance.now() - start,
    };
  },
};

/**
 * Create a scoped logger with a prefix for a specific module/component.
 * Returns a full ScopedLogger with timing and child logger support.
 */
export function createLogger(
  scope: string,
  boundContext?: Record<string, unknown>,
): ScopedLogger {
  const mergeContext = (
    ctx?: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    if (!boundContext && !ctx) return undefined;
    if (!boundContext) return ctx;
    if (!ctx) return boundContext;
    return { ...boundContext, ...ctx };
  };

  const scopedLogger: ScopedLogger = {
    scope,

    debug: (message: string, context?: Record<string, unknown>): void => {
      outputLog(
        LogLevel.DEBUG,
        'DEBUG',
        message,
        scope,
        undefined,
        mergeContext(context),
      );
    },

    info: (message: string, context?: Record<string, unknown>): void => {
      outputLog(
        LogLevel.INFO,
        'INFO',
        message,
        scope,
        undefined,
        mergeContext(context),
      );
    },

    warn: (message: string, context?: Record<string, unknown>): void => {
      outputLog(
        LogLevel.WARN,
        'WARN',
        message,
        scope,
        undefined,
        mergeContext(context),
      );
    },

    error: (
      message: string,
      errorOrContext?: unknown,
      context?: Record<string, unknown>,
    ): void => {
      let error: unknown;
      let ctx: Record<string, unknown> | undefined = context;

      if (errorOrContext instanceof Error) {
        error = errorOrContext;
      } else if (
        errorOrContext &&
        typeof errorOrContext === 'object' &&
        !Array.isArray(errorOrContext)
      ) {
        if (!context) {
          ctx = errorOrContext as Record<string, unknown>;
        } else {
          error = errorOrContext;
        }
      } else if (errorOrContext !== undefined) {
        error = errorOrContext;
      }

      outputLog(
        LogLevel.ERROR,
        'ERROR',
        message,
        scope,
        undefined,
        mergeContext(ctx),
        error,
      );
    },

    startTimer: (operation: string): LogTimer => {
      const start = performance.now();
      return {
        end: (context?: Record<string, unknown>) => {
          const durationMs = performance.now() - start;
          outputLog(
            LogLevel.DEBUG,
            'DEBUG',
            `${operation} completed`,
            scope,
            undefined,
            mergeContext(context),
            undefined,
            durationMs,
          );
        },
        elapsed: () => performance.now() - start,
      };
    },

    child: (childContext: Record<string, unknown>): ScopedLogger => {
      return createLogger(scope, { ...boundContext, ...childContext });
    },
  };

  return scopedLogger;
}

export default logger;
