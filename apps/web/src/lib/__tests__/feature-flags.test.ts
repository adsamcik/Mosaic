import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureFlagsManager,
  __resetFeatureFlagsForTests,
  __setFeatureFlagForTests,
  getFeatureFlag,
} from '../feature-flags';

const STORAGE_KEY = 'mosaic.feature-flags';
const DEFAULT_FLAGS = {
  rustCoreFinalize: false,
  rustCoreSync: false,
  rustCoreUpload: false,
  sidecar: false,
  sidecarTelemetry: false,
};

describe('feature-flags', () => {
  afterEach(() => {
    __resetFeatureFlagsForTests();
    localStorage.clear();
  });

  it('sidecar flags default to OFF in test env', () => {
    expect(getFeatureFlag('sidecar')).toBe(false);
    expect(getFeatureFlag('sidecarTelemetry')).toBe(false);
  });

  it('test override enables the flag', () => {
    __setFeatureFlagForTests('sidecar', true);

    expect(getFeatureFlag('sidecar')).toBe(true);
  });

  it('test overrides preserve other overridden flags', () => {
    __setFeatureFlagForTests('sidecar', true);
    __setFeatureFlagForTests('sidecarTelemetry', true);

    expect(getFeatureFlag('sidecar')).toBe(true);
    expect(getFeatureFlag('sidecarTelemetry')).toBe(true);
  });

  it('reset restores the default', () => {
    __setFeatureFlagForTests('sidecar', true);
    __resetFeatureFlagsForTests();

    expect(getFeatureFlag('sidecar')).toBe(false);
  });
});

describe('FeatureFlagsManager', () => {
  afterEach(() => {
    FeatureFlagsManager.resetOverride();
    localStorage.clear();
  });

  it('defaults every rollout flag to false', () => {
    expect(FeatureFlagsManager.load()).toEqual(DEFAULT_FLAGS);
  });

  it('saves and loads persisted flags', () => {
    FeatureFlagsManager.save({
      rustCoreFinalize: true,
      rustCoreSync: true,
      rustCoreUpload: true,
      sidecar: true,
      sidecarTelemetry: true,
    });

    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreFinalize: true,
      rustCoreSync: true,
      rustCoreUpload: true,
      sidecar: true,
      sidecarTelemetry: true,
    });
  });

  it('toggles one flag while preserving the others', () => {
    FeatureFlagsManager.save({
      rustCoreFinalize: false,
      rustCoreSync: true,
      rustCoreUpload: true,
      sidecar: true,
      sidecarTelemetry: false,
    });

    FeatureFlagsManager.save({ rustCoreSync: false });

    expect(FeatureFlagsManager.load()).toEqual({
      rustCoreFinalize: false,
      rustCoreSync: false,
      rustCoreUpload: true,
      sidecar: true,
      sidecarTelemetry: false,
    });
  });

  it('reset clears all persisted flags', () => {
    FeatureFlagsManager.save({ rustCoreUpload: true });

    FeatureFlagsManager.reset();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(FeatureFlagsManager.load()).toEqual(DEFAULT_FLAGS);
  });

  it('returns defaults for invalid stored JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid JSON');

    expect(FeatureFlagsManager.load()).toEqual(DEFAULT_FLAGS);
  });

  it('uses programmatic overrides without persisting them', () => {
    FeatureFlagsManager.override({ rustCoreUpload: true });

    expect(FeatureFlagsManager.load().rustCoreUpload).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
