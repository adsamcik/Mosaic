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

/* eslint-disable @typescript-eslint/no-explicit-any */
const env: FeatureFlagEnv =
  typeof import.meta !== 'undefined' && (import.meta as any).env
    ? ((import.meta as any).env as FeatureFlagEnv)
    : {};
/* eslint-enable @typescript-eslint/no-explicit-any */

const initialFlags = {
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
};

const flags: { -readonly [K in keyof typeof initialFlags]: boolean } = { ...initialFlags };

export type FeatureFlagName = keyof typeof initialFlags;

export function getFeatureFlag(name: FeatureFlagName): boolean {
  return flags[name];
}

/** Test-only override. Reset by passing the original value in `afterEach`. */
export function __setFeatureFlagForTests(name: FeatureFlagName, value: boolean): void {
  flags[name] = value;
}

/** Test-only reset to env-derived defaults. */
export function __resetFeatureFlagsForTests(): void {
  for (const k of Object.keys(initialFlags) as FeatureFlagName[]) {
    flags[k] = initialFlags[k];
  }
}
