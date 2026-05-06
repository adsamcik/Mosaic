import { afterEach, describe, expect, it } from 'vitest';
import {
  getFeatureFlag,
  __setFeatureFlagForTests,
  __resetFeatureFlagsForTests,
} from '../feature-flags';

describe('feature-flags', () => {
  afterEach(() => {
    __resetFeatureFlagsForTests();
  });

  it('sidecar flag defaults to OFF in test env', () => {
    expect(getFeatureFlag('sidecar')).toBe(false);
  });

  it('test override enables the flag', () => {
    __setFeatureFlagForTests('sidecar', true);
    expect(getFeatureFlag('sidecar')).toBe(true);
  });

  it('reset restores the default', () => {
    __setFeatureFlagForTests('sidecar', true);
    __resetFeatureFlagsForTests();
    expect(getFeatureFlag('sidecar')).toBe(false);
  });
});
