import { describe, it, expect } from 'vitest';
import { formatDuration } from '../video-frame-extractor';

describe('formatDuration', () => {
  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats seconds under a minute', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3683)).toBe('1:01:23');
    expect(formatDuration(7261)).toBe('2:01:01');
  });

  it('truncates fractional seconds (floor)', () => {
    expect(formatDuration(62.5)).toBe('1:02');
    expect(formatDuration(62.9)).toBe('1:02');
  });

  it('handles negative values gracefully', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });

  it('handles NaN and Infinity', () => {
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
    expect(formatDuration(-Infinity)).toBe('0:00');
  });

  it('pads single-digit seconds', () => {
    expect(formatDuration(61)).toBe('1:01');
  });

  it('pads minutes in hour format', () => {
    expect(formatDuration(3605)).toBe('1:00:05');
  });
});
