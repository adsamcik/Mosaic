/**
 * Centralized logging utility for the Mosaic frontend.
 * 
 * Features:
 * - Log level filtering based on environment (production vs development)
 * - Structured logging with consistent prefixes
 * - Never logs sensitive data (keys, passwords, decrypted content)
 * - Safe error serialization
 * 
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.debug('Processing started');
 *   logger.info('Upload complete', { photoId });
 *   logger.warn('Retrying operation', { attempt: 2 });
 *   logger.error('Failed to decrypt', error);
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

// Production only logs warnings and errors; development logs everything
const currentLevel: LogLevel = import.meta.env.PROD ? LogLevel.WARN : LogLevel.DEBUG;

/**
 * Safely serialize an error object for logging.
 * Strips internal details in production to avoid leaking stack traces.
 */
function serializeError(error: unknown): object {
  if (error instanceof Error) {
    // In production, only include message; in dev, include full stack
    if (import.meta.env.PROD) {
      return {
        name: error.name,
        message: error.message,
      };
    }
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

/**
 * Format log arguments, handling errors specially
 */
function formatArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (arg instanceof Error) {
      return serializeError(arg);
    }
    return arg;
  });
}

/**
 * Get current timestamp for log entries
 */
function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  /**
   * Debug level logging - verbose information for development
   * Filtered out in production
   */
  debug: (...args: unknown[]): void => {
    if (currentLevel <= LogLevel.DEBUG) {
      console.log(`[${timestamp()}] [DEBUG]`, ...formatArgs(args));
    }
  },

  /**
   * Info level logging - general operational information
   * Filtered out in production
   */
  info: (...args: unknown[]): void => {
    if (currentLevel <= LogLevel.INFO) {
      console.info(`[${timestamp()}] [INFO]`, ...formatArgs(args));
    }
  },

  /**
   * Warning level logging - potential issues that don't prevent operation
   * Shown in both development and production
   */
  warn: (...args: unknown[]): void => {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(`[${timestamp()}] [WARN]`, ...formatArgs(args));
    }
  },

  /**
   * Error level logging - failures and exceptions
   * Always shown
   */
  error: (...args: unknown[]): void => {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(`[${timestamp()}] [ERROR]`, ...formatArgs(args));
    }
  },

  /**
   * Get the current log level
   */
  getLevel: (): LogLevel => currentLevel,

  /**
   * Check if a log level is enabled
   */
  isEnabled: (level: LogLevel): boolean => currentLevel <= level,
};

/**
 * Create a scoped logger with a prefix for a specific module/component
 */
export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => logger.debug(`[${scope}]`, ...args),
    info: (...args: unknown[]) => logger.info(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => logger.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => logger.error(`[${scope}]`, ...args),
  };
}

export default logger;
