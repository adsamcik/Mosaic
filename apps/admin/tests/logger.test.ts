import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  logger,
  createLogger,
  LogLevel,
  setLogLevel,
  setCorrelationId,
  getCorrelationId,
  newCorrelationId,
  type ScopedLogger,
} from '../src/lib/logger';

describe('logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset log level to DEBUG for tests
    setLogLevel(LogLevel.DEBUG);
    // Clear correlation ID
    setCorrelationId(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic logging', () => {
    it('logs debug messages', () => {
      logger.debug('Test debug message');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0].join(' ')).toContain('[DEBUG]');
      expect(consoleLogSpy.mock.calls[0].join(' ')).toContain(
        'Test debug message',
      );
    });

    it('logs info messages', () => {
      logger.info('Test info message');
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(consoleInfoSpy.mock.calls[0].join(' ')).toContain('[INFO]');
      expect(consoleInfoSpy.mock.calls[0].join(' ')).toContain(
        'Test info message',
      );
    });

    it('logs warn messages', () => {
      logger.warn('Test warn message');
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0].join(' ')).toContain('[WARN]');
      expect(consoleWarnSpy.mock.calls[0].join(' ')).toContain(
        'Test warn message',
      );
    });

    it('logs error messages', () => {
      logger.error('Test error message');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0].join(' ')).toContain('[ERROR]');
      expect(consoleErrorSpy.mock.calls[0].join(' ')).toContain(
        'Test error message',
      );
    });

    it('logs with context object', () => {
      logger.info('Upload started', { filename: 'photo.jpg', size: 1024 });
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      const args = consoleInfoSpy.mock.calls[0];
      expect(
        args.some(
          (arg: unknown) =>
            typeof arg === 'object' &&
            arg !== null &&
            'filename' in arg &&
            (arg as { filename: string }).filename === 'photo.jpg',
        ),
      ).toBe(true);
    });

    it('logs errors with Error object', () => {
      const error = new Error('Something went wrong');
      logger.error('Operation failed', error);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const args = consoleErrorSpy.mock.calls[0];
      expect(
        args.some(
          (arg: unknown) =>
            typeof arg === 'object' &&
            arg !== null &&
            'name' in arg &&
            (arg as { name: string }).name === 'Error',
        ),
      ).toBe(true);
    });

    it('logs errors with context', () => {
      const error = new Error('Failed');
      logger.error('Operation failed', error, { operationId: '123' });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('log level filtering', () => {
    it('filters debug when level is INFO', () => {
      setLogLevel(LogLevel.INFO);
      logger.debug('Should not appear');
      logger.info('Should appear');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    });

    it('filters debug and info when level is WARN', () => {
      setLogLevel(LogLevel.WARN);
      logger.debug('Should not appear');
      logger.info('Should not appear');
      logger.warn('Should appear');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('only logs errors when level is ERROR', () => {
      setLogLevel(LogLevel.ERROR);
      logger.debug('No');
      logger.info('No');
      logger.warn('No');
      logger.error('Yes');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('logs nothing when level is NONE', () => {
      setLogLevel(LogLevel.NONE);
      logger.debug('No');
      logger.info('No');
      logger.warn('No');
      logger.error('No');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('getLevel returns current level', () => {
      setLogLevel(LogLevel.WARN);
      expect(logger.getLevel()).toBe(LogLevel.WARN);
    });

    it('isEnabled checks if level is active', () => {
      setLogLevel(LogLevel.WARN);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isEnabled(LogLevel.INFO)).toBe(false);
      expect(logger.isEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
    });
  });

  describe('correlation IDs', () => {
    it('sets and gets correlation ID', () => {
      expect(getCorrelationId()).toBeUndefined();
      setCorrelationId('test-123');
      expect(getCorrelationId()).toBe('test-123');
    });

    it('generates new correlation ID', () => {
      const id = newCorrelationId();
      expect(id).toBeDefined();
      expect(id.length).toBe(8);
      expect(getCorrelationId()).toBe(id);
    });

    it('includes correlation ID in log output', () => {
      setCorrelationId('corr-456');
      logger.info('Test message');
      const output = consoleInfoSpy.mock.calls[0].join(' ');
      expect(output).toContain('[corr-456]');
    });

    it('clears correlation ID when set to undefined', () => {
      setCorrelationId('temp-id');
      expect(getCorrelationId()).toBe('temp-id');
      setCorrelationId(undefined);
      expect(getCorrelationId()).toBeUndefined();
    });
  });

  describe('performance timing', () => {
    it('logs duration with startTimer', async () => {
      const timer = logger.startTimer('testOperation');

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));

      timer.end();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = consoleLogSpy.mock.calls[0].join(' ');
      expect(output).toContain('testOperation completed');
      // Check that duration is logged (should be at least 10ms)
      expect(output).toMatch(/\(\d+\.\d+ms\)/);
    });

    it('includes context in timer end', () => {
      const timer = logger.startTimer('upload');
      timer.end({ shardIndex: 0, size: 1024 });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const args = consoleLogSpy.mock.calls[0];
      expect(
        args.some(
          (arg: unknown) =>
            typeof arg === 'object' && arg !== null && 'shardIndex' in arg,
        ),
      ).toBe(true);
    });

    it('elapsed returns current duration without ending', async () => {
      const timer = logger.startTimer('longOp');

      await new Promise((resolve) => setTimeout(resolve, 5));
      const elapsed1 = timer.elapsed();

      await new Promise((resolve) => setTimeout(resolve, 5));
      const elapsed2 = timer.elapsed();

      expect(elapsed2).toBeGreaterThan(elapsed1);
      expect(consoleLogSpy).not.toHaveBeenCalled(); // Not ended yet

      timer.end();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('createLogger scoped logger', () => {
    let scopedLog: ScopedLogger;

    beforeEach(() => {
      scopedLog = createLogger('TestModule');
    });

    it('includes scope in log output', () => {
      scopedLog.info('Scoped message');
      const output = consoleInfoSpy.mock.calls[0].join(' ');
      expect(output).toContain('[TestModule]');
      expect(output).toContain('Scoped message');
    });

    it('exposes scope property', () => {
      expect(scopedLog.scope).toBe('TestModule');
    });

    it('logs all levels with scope', () => {
      scopedLog.debug('debug');
      scopedLog.info('info');
      scopedLog.warn('warn');
      scopedLog.error('error');

      expect(consoleLogSpy.mock.calls[0].join(' ')).toContain('[TestModule]');
      expect(consoleInfoSpy.mock.calls[0].join(' ')).toContain('[TestModule]');
      expect(consoleWarnSpy.mock.calls[0].join(' ')).toContain('[TestModule]');
      expect(consoleErrorSpy.mock.calls[0].join(' ')).toContain('[TestModule]');
    });

    it('supports startTimer on scoped logger', () => {
      const timer = scopedLog.startTimer('scopedOp');
      timer.end();

      const output = consoleLogSpy.mock.calls[0].join(' ');
      expect(output).toContain('[TestModule]');
      expect(output).toContain('scopedOp completed');
    });
  });

  describe('child loggers', () => {
    it('creates child logger with bound context', () => {
      const parentLog = createLogger('Upload');
      const childLog = parentLog.child({ uploadId: 'upload-123' });

      childLog.info('Shard completed');

      const args = consoleInfoSpy.mock.calls[0];
      expect(
        args.some(
          (arg: unknown) =>
            typeof arg === 'object' &&
            arg !== null &&
            'uploadId' in arg &&
            (arg as { uploadId: string }).uploadId === 'upload-123',
        ),
      ).toBe(true);
    });

    it('child logger inherits scope', () => {
      const parentLog = createLogger('CryptoWorker');
      const childLog = parentLog.child({ operationId: 'op-456' });

      expect(childLog.scope).toBe('CryptoWorker');

      childLog.debug('Child message');
      const output = consoleLogSpy.mock.calls[0].join(' ');
      expect(output).toContain('[CryptoWorker]');
    });

    it('child logger merges context with parent', () => {
      const parentLog = createLogger('Service', { serviceId: 'svc-1' });
      const childLog = parentLog.child({ requestId: 'req-1' });

      childLog.info('Processing');

      const args = consoleInfoSpy.mock.calls[0];
      const contextArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' && arg !== null && 'serviceId' in arg,
      ) as Record<string, string> | undefined;

      expect(contextArg).toBeDefined();
      expect(contextArg?.serviceId).toBe('svc-1');
      expect(contextArg?.requestId).toBe('req-1');
    });

    it('child context overrides parent context on conflict', () => {
      const parentLog = createLogger('Test', { value: 'parent' });
      const childLog = parentLog.child({ value: 'child' });

      childLog.info('Test');

      const args = consoleInfoSpy.mock.calls[0];
      const contextArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' && arg !== null && 'value' in arg,
      ) as Record<string, string> | undefined;

      expect(contextArg?.value).toBe('child');
    });

    it('nested child loggers accumulate context', () => {
      const log1 = createLogger('Service');
      const log2 = log1.child({ level1: 'a' });
      const log3 = log2.child({ level2: 'b' });

      log3.info('Deep message');

      const args = consoleInfoSpy.mock.calls[0];
      const contextArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' && arg !== null && 'level1' in arg,
      ) as Record<string, string> | undefined;

      expect(contextArg?.level1).toBe('a');
      expect(contextArg?.level2).toBe('b');
    });
  });

  describe('error serialization', () => {
    it('serializes Error objects with name and message', () => {
      const error = new Error('Test error');
      logger.error('Failed', error);

      const args = consoleErrorSpy.mock.calls[0];
      const errorArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' &&
          arg !== null &&
          'name' in arg &&
          'message' in arg,
      ) as { name: string; message: string } | undefined;

      expect(errorArg?.name).toBe('Error');
      expect(errorArg?.message).toBe('Test error');
    });

    it('serializes custom error types', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const error = new CustomError('Custom failure');
      logger.error('Custom error occurred', error);

      const args = consoleErrorSpy.mock.calls[0];
      const errorArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' && arg !== null && 'name' in arg,
      ) as { name: string } | undefined;

      expect(errorArg?.name).toBe('CustomError');
    });

    it('handles non-Error thrown values', () => {
      logger.error('Strange error', 'string error');

      const args = consoleErrorSpy.mock.calls[0];
      const errorArg = args.find(
        (arg: unknown) =>
          typeof arg === 'object' &&
          arg !== null &&
          'name' in arg &&
          'message' in arg,
      ) as { name: string; message: string } | undefined;

      expect(errorArg?.name).toBe('Unknown');
      expect(errorArg?.message).toBe('string error');
    });
  });

  describe('timestamp format', () => {
    it('includes ISO timestamp in logs', () => {
      logger.info('Test');
      const output = consoleInfoSpy.mock.calls[0].join(' ');
      // ISO format: 2025-12-28T10:30:00.000Z
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });
  });
});
