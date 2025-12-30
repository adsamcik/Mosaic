/**
 * Health Check API Tests
 *
 * Basic connectivity and health check tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { api } from '../api-client';
import { waitForApi } from '../utils';

describe('Health Check', () => {
  beforeAll(async () => {
    await waitForApi(api);
  });

  it('returns healthy status', async () => {
    const response = await api.get<{ status: string; timestamp: string }>('/health');

    expect(response.status).toBe(200);
    expect(response.data.status).toBe('healthy');
    expect(response.data.timestamp).toBeDefined();
  });

  it('returns valid ISO timestamp', async () => {
    const response = await api.get<{ status: string; timestamp: string }>('/health');

    const timestamp = new Date(response.data.timestamp);
    expect(timestamp.getTime()).not.toBeNaN();
    expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 60000); // Within last minute
  });
});
