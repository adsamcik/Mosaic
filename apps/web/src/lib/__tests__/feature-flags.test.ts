import { afterEach, describe, expect, it } from 'vitest';
import { FeatureFlagsManager } from '../feature-flags';

const STORAGE_KEY = 'mosaic.feature-flags';

describe('FeatureFlagsManager', () => {
  afterEach(() => {
    FeatureFlagsManager.resetOverride();
    localStorage.clear();
  });

  it('defaults every Rust-core rollout flag to false', () => {
    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreUpload: false,
      rustCoreSync: false,
      rustCoreFinalize: false,
    });
  });

  it('saves and loads persisted flags', () => {
    FeatureFlagsManager.save({
      rustCoreUpload: true,
      rustCoreSync: true,
      rustCoreFinalize: true,
    });

    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreUpload: true,
      rustCoreSync: true,
      rustCoreFinalize: true,
    });
  });

  it('toggles one flag while preserving the others', () => {
    FeatureFlagsManager.save({
      rustCoreUpload: true,
      rustCoreSync: true,
      rustCoreFinalize: false,
    });

    FeatureFlagsManager.save({ rustCoreSync: false });

    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreUpload: true,
      rustCoreSync: false,
      rustCoreFinalize: false,
    });
  });

  it('reset clears all persisted flags', () => {
    FeatureFlagsManager.save({ rustCoreUpload: true });

    FeatureFlagsManager.reset();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreUpload: false,
      rustCoreSync: false,
      rustCoreFinalize: false,
    });
  });

  it('returns defaults for invalid stored JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid JSON');

    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreUpload: false,
      rustCoreSync: false,
      rustCoreFinalize: false,
    });
  });

  it('uses programmatic overrides without persisting them', () => {
    FeatureFlagsManager.override({ rustCoreUpload: true });

    expect(FeatureFlagsManager.load().rustCoreUpload).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
