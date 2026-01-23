/**
 * Mosaic Crypto Library - Argon2id Parameters
 *
 * Device-adaptive parameters for password hashing.
 * Target: 500-1000ms derivation time across device types.
 */

import type { Argon2Params } from './types';

/**
 * Detect if running on a mobile device.
 * Uses User-Agent heuristics for simplicity.
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}

/**
 * Detect if device has limited memory.
 * Uses deviceMemory API where available.
 */
export function isLowMemoryDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  // deviceMemory API (Chrome/Edge only, returns GB)
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  if (deviceMemory !== undefined) {
    return deviceMemory < 4;
  }

  // Fall back to mobile detection
  return isMobileDevice();
}

/**
 * Check if running in E2E weak keys mode.
 * Only active when VITE_E2E_WEAK_KEYS=true is set.
 *
 * @security This MUST only be used in test environments.
 */
function isE2EWeakKeysMode(): boolean {
  // In Vite/browser context, check import.meta.env
  // Use unknown intermediate cast for TypeScript compatibility
  if (typeof import.meta !== 'undefined') {
    const meta = import.meta as unknown as {
      env?: { PROD?: boolean; VITE_E2E_WEAK_KEYS?: string; DEV?: boolean };
    };

    // Safety: Never enable in production mode
    if (meta.env?.PROD) {
      return false;
    }

    if (meta.env?.VITE_E2E_WEAK_KEYS === 'true') {
      return true;
    }
  }

  // In Node.js context (e.g., unit tests), check process.env
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    return process.env.VITE_E2E_WEAK_KEYS === 'true';
  }

  return false;
}

/**
 * Get optimal Argon2id parameters for current device.
 *
 * Parameters are tuned to achieve ~500-1000ms derivation time:
 * - Desktop: 64MB memory, 3 iterations
 * - Mobile/Low-memory: 32MB memory, 4 iterations (more iterations compensate for lower memory)
 *
 * Parallelism is set to 1 for consistent behavior across devices
 * and simpler implementation (WebAssembly limitations).
 *
 * @security When VITE_E2E_WEAK_KEYS=true, returns minimal parameters
 *           for fast E2E testing. NEVER enable in production.
 */
export function getArgon2Params(): Argon2Params {
  // Check for E2E weak keys mode first
  if (isE2EWeakKeysMode()) {
    // Log warning to ensure visibility
    if (typeof console !== 'undefined') {
      console.warn(
        '[CRYPTO] ⚠️ WEAK KEYS MODE ENABLED - Using minimal Argon2 parameters. ' +
          'This provides NO security and should ONLY be used for E2E testing.',
      );
    }
    return {
      memory: 8 * 1024, // 8 MiB - minimum practical value
      iterations: 1, // Minimum iterations
      parallelism: 1,
    };
  }

  if (isMobileDevice() || isLowMemoryDevice()) {
    return {
      memory: 32 * 1024, // 32 MiB in KiB
      iterations: 4,
      parallelism: 1,
    };
  }

  return {
    memory: 64 * 1024, // 64 MiB in KiB
    iterations: 3,
    parallelism: 1,
  };
}

/**
 * Preset configurations for benchmarking.
 */
export const ARGON2_PRESETS = {
  /** Desktop with plenty of RAM */
  desktop: {
    memory: 64 * 1024,
    iterations: 3,
    parallelism: 1,
  },

  /** High-end desktop */
  desktopHigh: {
    memory: 128 * 1024,
    iterations: 3,
    parallelism: 1,
  },

  /** Mobile or low-memory device */
  mobile: {
    memory: 32 * 1024,
    iterations: 4,
    parallelism: 1,
  },

  /** Very constrained device */
  mobileLight: {
    memory: 16 * 1024,
    iterations: 6,
    parallelism: 1,
  },

  /**
   * E2E testing mode - INSECURE, FOR TESTING ONLY.
   * Uses absolute minimum parameters for near-instant derivation.
   *
   * @security NEVER enable in production - provides no meaningful protection.
   */
  e2eTest: {
    memory: 8 * 1024, // 8 MiB - minimum practical value
    iterations: 1, // Minimum iterations
    parallelism: 1,
  },
} as const satisfies Record<string, Argon2Params>;

/**
 * Benchmark Argon2id with given parameters.
 * Returns median time from multiple runs.
 *
 * @param sodium - Initialized libsodium instance
 * @param params - Argon2id parameters to test
 * @param runs - Number of benchmark runs (default: 3)
 * @returns Median execution time in milliseconds
 */
export async function benchmarkArgon2(
  sodium: typeof import('libsodium-wrappers'),
  params: Argon2Params,
  runs: number = 3,
): Promise<number> {
  const times: number[] = [];
  const testPassword = 'benchmark-password-test';
  const testSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);

  for (let i = 0; i < runs; i++) {
    const start = performance.now();

    sodium.crypto_pwhash(
      32,
      testPassword,
      testSalt,
      params.iterations,
      params.memory * 1024, // Convert KiB to bytes
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );

    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  // Return median
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

/**
 * Benchmark result for a single configuration.
 */
export interface BenchmarkResult {
  params: Argon2Params;
  medianMs: number;
  allTimesMs: number[];
}

/**
 * Run benchmarks for all preset configurations.
 *
 * @param sodium - Initialized libsodium instance
 * @param runs - Number of runs per configuration
 * @returns Array of benchmark results
 */
export async function benchmarkAllPresets(
  sodium: typeof import('libsodium-wrappers'),
  runs: number = 3,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const [_name, params] of Object.entries(ARGON2_PRESETS)) {
    const times: number[] = [];
    const testPassword = 'benchmark-password-test';
    const testSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);

    for (let i = 0; i < runs; i++) {
      const start = performance.now();

      sodium.crypto_pwhash(
        32,
        testPassword,
        testSalt,
        params.iterations,
        params.memory * 1024,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );

      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);

    results.push({
      params,
      medianMs: times[Math.floor(times.length / 2)] ?? 0,
      allTimesMs: times,
    });
  }

  return results;
}
