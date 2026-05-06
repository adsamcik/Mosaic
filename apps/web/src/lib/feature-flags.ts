export interface FeatureFlags {
  readonly rustCoreUpload: boolean;
  readonly rustCoreSync: boolean;
  readonly rustCoreFinalize: boolean;
}

type FeatureFlagName = keyof FeatureFlags;
type MutableFeatureFlagPatch = {
  -readonly [K in FeatureFlagName]?: FeatureFlags[K];
};

const STORAGE_KEY = 'mosaic.feature-flags';

const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.freeze({
  rustCoreUpload: false,
  rustCoreSync: false,
  rustCoreFinalize: false,
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
