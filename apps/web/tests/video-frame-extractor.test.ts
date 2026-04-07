/**
 * Video Frame Extractor Tests
 *
 * Tests for formatDuration() and export validation.
 *
 * Note: extractVideoFrame() requires a real browser environment with
 * HTMLVideoElement, Canvas, and video decoding support. It cannot be
 * meaningfully tested in happy-dom. Integration/E2E tests should cover
 * the full extraction flow.
 */

import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  extractVideoFrame,
  VideoFrameError,
  type VideoMetadata,
  type VideoFrameResult,
} from '../src/lib/video-frame-extractor';

// =============================================================================
// formatDuration
// =============================================================================

describe('formatDuration', () => {
  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats single-digit seconds with padding', () => {
    expect(formatDuration(5)).toBe('0:05');
  });

  it('formats double-digit seconds', () => {
    expect(formatDuration(10)).toBe('0:10');
  });

  it('formats exact minute', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(62)).toBe('1:02');
  });

  it('formats multiple minutes', () => {
    expect(formatDuration(125)).toBe('2:05');
  });

  it('formats exact hour', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('formats large durations', () => {
    expect(formatDuration(7384)).toBe('2:03:04');
  });

  it('pads minutes in hour format', () => {
    expect(formatDuration(3605)).toBe('1:00:05');
  });

  it('handles fractional seconds (rounds down)', () => {
    expect(formatDuration(5.9)).toBe('0:05');
    expect(formatDuration(62.7)).toBe('1:02');
  });

  it('handles NaN', () => {
    expect(formatDuration(NaN)).toBe('0:00');
  });

  it('handles Infinity', () => {
    expect(formatDuration(Infinity)).toBe('0:00');
  });

  it('handles negative Infinity', () => {
    expect(formatDuration(-Infinity)).toBe('0:00');
  });

  it('handles negative numbers', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(-100)).toBe('0:00');
  });

  it('handles very small positive values', () => {
    expect(formatDuration(0.001)).toBe('0:00');
    expect(formatDuration(0.999)).toBe('0:00');
  });

  it('handles 59 seconds (no minute rollover)', () => {
    expect(formatDuration(59)).toBe('0:59');
  });

  it('handles 59 minutes 59 seconds (no hour rollover)', () => {
    expect(formatDuration(3599)).toBe('59:59');
  });
});

// =============================================================================
// Module exports
// =============================================================================

describe('video-frame-extractor exports', () => {
  it('exports extractVideoFrame function', () => {
    expect(typeof extractVideoFrame).toBe('function');
  });

  it('exports formatDuration function', () => {
    expect(typeof formatDuration).toBe('function');
  });

  it('exports VideoFrameError class', () => {
    const error = new VideoFrameError('test error');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VideoFrameError');
    expect(error.message).toBe('test error');
  });

  it('VideoFrameError preserves cause', () => {
    const cause = new Error('root cause');
    const error = new VideoFrameError('wrapper', cause);
    expect(error.cause).toBe(cause);
  });
});

// =============================================================================
// Type checks (compile-time verification)
// =============================================================================

describe('type definitions', () => {
  it('VideoMetadata has expected shape', () => {
    const metadata: VideoMetadata = {
      duration: 10,
      width: 1920,
      height: 1080,
    };
    expect(metadata.duration).toBe(10);
    expect(metadata.width).toBe(1920);
    expect(metadata.height).toBe(1080);
    expect(metadata.codec).toBeUndefined();
  });

  it('VideoMetadata accepts optional codec', () => {
    const metadata: VideoMetadata = {
      duration: 10,
      width: 1920,
      height: 1080,
      codec: 'avc1.42E01E',
    };
    expect(metadata.codec).toBe('avc1.42E01E');
  });

  it('VideoFrameResult has expected shape', () => {
    // Type-level check — runtime shape validated by extractVideoFrame
    const result: VideoFrameResult = {
      metadata: { duration: 10, width: 1920, height: 1080 },
      thumbnailBlob: new Blob(),
      thumbnailWidth: 600,
      thumbnailHeight: 338,
      embeddedThumbnail: 'data:image/jpeg;base64,...',
      embeddedWidth: 300,
      embeddedHeight: 169,
      thumbhash: 'abc123==',
    };
    expect(result.metadata.duration).toBe(10);
    expect(result.thumbnailWidth).toBe(600);
    expect(result.embeddedWidth).toBe(300);
  });
});
