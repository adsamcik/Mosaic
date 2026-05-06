/**
 * Tiny feature-flag module. Flags default OFF and are read once at module
 * load from `import.meta.env`. Production builds bake the value in; for
 * dev, set `VITE_FEATURE_<NAME>=1` in `.env.local`.
 *
 * To force a flag on at runtime in tests, use `__setFeatureFlagForTests`.
 */

interface FeatureFlagEnv {
  readonly VITE_FEATURE_SIDECAR?: string;
  readonly VITE_FEATURE_SIDECAR_TELEMETRY?: string;
}

export interface FeatureFlags {
  readonly rustCoreFinalize: boolean;
  readonly rustCoreSync: boolean;
  readonly rustCoreUpload: boolean;
  readonly sidecar: boolean;
  readonly sidecarTelemetry: boolean;
}

export type FeatureFlagName = keyof FeatureFlags;
type MutableFeatureFlagPatch = {
  -readonly [K in FeatureFlagName]?: FeatureFlags[K];
};

const STORAGE_KEY = 'mosaic.feature-flags';

/* eslint-disable @typescript-eslint/no-explicit-any */
const env: FeatureFlagEnv =
  typeof import.meta !== 'undefined' && (import.meta as any).env
    ? ((import.meta as any).env as FeatureFlagEnv)
    : {};
/* eslint-enable @typescript-eslint/no-explicit-any */

const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.freeze({
  rustCoreFinalize: false,
  rustCoreSync: false,
  rustCoreUpload: false,
  /**
   * Sidecar Beacon — "Send to my phone" download output mode + /pair receive page.
   * Beta. Default OFF. Enable for dev with `VITE_FEATURE_SIDECAR=1`.
   */
  sidecar: env.VITE_FEATURE_SIDECAR === '1',
  /**
   * Sidecar Beacon telemetry — coarse, ZK-safe counters. Default OFF.
   * Enable with `VITE_FEATURE_SIDECAR_TELEMETRY=1` AND `VITE_FEATURE_SIDECAR=1`.
   * The telemetry collector self-checks BOTH flags at runtime.
   */
  sidecarTelemetry: env.VITE_FEATURE_SIDECAR_TELEMETRY === '1',
});

let programmaticOverride: Partial<FeatureFlags> | null = null;

export const FeatureFlagsManager = Object.freeze({
  storageKey: STORAGE_KEY,

  defaults(): FeatureFlags {
    return { ...DEFAULT_FEATURE_FLAGS };
  },

  load(): FeatureFlags {
    const persisted = readStoredFlags();
    return programmaticOverride === null
      ? persisted
      : { ...persisted, ...programmaticOverride };
  },

  save(partial: Partial<FeatureFlags>): FeatureFlags {
    const next = { ...readStoredFlags(), ...sanitizePartialFlags(partial) };
    writeStoredFlags(next);
    return programmaticOverride === null
      ? next
      : { ...next, ...programmaticOverride };
  },

  reset(): void {
    getLocalStorage()?.removeItem(STORAGE_KEY);
    programmaticOverride = null;
  },

  override(partial: Partial<FeatureFlags>): FeatureFlags {
    programmaticOverride = { ...sanitizePartialFlags(partial) };
    return this.load();
  },

  resetOverride(): void {
    programmaticOverride = null;
  },
});

export function getFeatureFlag(name: FeatureFlagName): boolean {
  return FeatureFlagsManager.load()[name];
}

/** Test-only override. Reset with `__resetFeatureFlagsForTests` in `afterEach`. */
export function __setFeatureFlagForTests(name: FeatureFlagName, value: boolean): void {
  programmaticOverride = { ...programmaticOverride, [name]: value };
}

/** Test-only reset to env-derived defaults. */
export function __resetFeatureFlagsForTests(): void {
  FeatureFlagsManager.reset();
}

declare global {
  interface Window {
    mosaicFeatureFlags?: typeof FeatureFlagsManager;
  }
}

if (typeof window !== 'undefined') {
  window.mosaicFeatureFlags = FeatureFlagsManager;
}

function readStoredFlags(): FeatureFlags {
  const storage = getLocalStorage();
  if (storage === null) {
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { ...DEFAULT_FEATURE_FLAGS };
    }
    return { ...DEFAULT_FEATURE_FLAGS, ...sanitizePartialFlags(parsed) };
  } catch {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}

function writeStoredFlags(flags: FeatureFlags): void {
  const storage = getLocalStorage();
  if (storage === null) {
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(flags));
}

function sanitizePartialFlags(value: Partial<FeatureFlags> | Record<string, unknown>): MutableFeatureFlagPatch {
  const sanitized: MutableFeatureFlagPatch = {};
  for (const key of Object.keys(DEFAULT_FEATURE_FLAGS) as FeatureFlagName[]) {
    if (typeof value[key] === 'boolean') {
      sanitized[key] = value[key];
    }
  }
  return sanitized;
}

function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
