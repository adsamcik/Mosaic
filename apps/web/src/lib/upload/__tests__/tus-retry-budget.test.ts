import { describe, it, expect } from 'vitest';
import { TUS_RETRY_DELAYS } from '../tus-upload';

/**
 * Verifies the widened Tus retry budget for v1.0.x s45-y4. The default
 * schedule MUST have at least 8 attempts spread across roughly 1.5
 * minutes so transient outages don't kill an upload after ~9s.
 */
describe('Tus retry budget (s45-y4)', () => {
  it('has at least 8 attempts in the default schedule', () => {
    expect(TUS_RETRY_DELAYS.length).toBeGreaterThanOrEqual(8);
  });

  it('reaches ~1.5min total wait across the schedule', () => {
    const total = TUS_RETRY_DELAYS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(90_000);
  });

  it('values are non-negative integers', () => {
    for (const d of TUS_RETRY_DELAYS) {
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
});
