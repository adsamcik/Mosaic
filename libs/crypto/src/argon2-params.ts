/**
 * Mosaic Crypto Library - Argon2id Parameters
 *
 * Registration-time parameters for password hashing.
 * Target: 500-1000ms derivation time across device types.
 */

import type { Argon2Params } from './types';

declare const process:
  | {
      readonly env?: {
        readonly NODE_ENV?: string;
        readonly VITE_E2E_WEAK_KEYS?: string;
      };
    }
  | undefined;

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
  // In Vite/browser context, check import.meta.env directly.
  // IMPORTANT: Vite statically replaces `import.meta.env.XXXX` at build time,
  // but ONLY when accessed as a direct property chain — NOT through a variable.
  try {
    // Access import.meta.env directly for Vite static replacement.
    // The 'as any' cast is needed for TypeScript but preserves the direct
    // property chain that Vite's static analysis requires.
    const env = (import.meta as any).env;

    // Explicit E2E weak keys flag takes precedence — this is set intentionally
    // via build args for Docker test builds (which are production Vite builds)
    if (env?.VITE_E2E_WEAK_KEYS === 'true') {
      return true;
    }

    // Safety: Never enable in production mode unless explicitly requested above
    if (env?.PROD) {
      return false;
    }
  } catch {
    // import.meta.env may not exist in all environments
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
 * Select optimal Argon2id parameters for registering an account on the current device.
 *
 * Parameters are tuned to achieve ~500-1000ms derivation time:
 * - Desktop: 64MB memory, 3 iterations
 * - Mobile/Low-memory: 32MB memory, 4 iterations (more iterations compensate for lower memory)
 *
 * Parallelism is set to 1 for consistent behavior across devices
 * and simpler implementation (WebAssembly limitations).
 *
 * ONLY for registration. Login/unlock paths must consume the server-pinned
 * profile from the User row so every device derives the same password-rooted keys.
 *
 * @security When VITE_E2E_WEAK_KEYS=true, returns minimal parameters
 *           for fast E2E testing. NEVER enable in production.
 */
export function selectRegistrationArgon2Params(): Argon2Params {
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
      algVersion: 0x13,
    };
  }

  if (isMobileDevice() || isLowMemoryDevice()) {
    return {
      memory: 32 * 1024, // 32 MiB in KiB
      iterations: 4,
      parallelism: 1,
      algVersion: 0x13,
    };
  }

  return {
    memory: 64 * 1024, // 64 MiB in KiB
    iterations: 3,
    parallelism: 1,
    algVersion: 0x13,
  };
}

export interface ServerArgon2ParamsPayload {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
  readonly algVersion: number;
}

/**
 * Parse and validate the server-pinned Argon2id profile stored on the User row.
 * Login/unlock callers must use this instead of device-adaptive selection.
 */
export function parseServerArgon2Params(payload: ServerArgon2ParamsPayload): Argon2Params {
  if (!Number.isInteger(payload.memoryKib) || payload.memoryKib < 8 * 1024) {
    throw new Error('Invalid Argon2 memory cost');
  }
  if (!Number.isInteger(payload.iterations) || payload.iterations < 1) {
    throw new Error('Invalid Argon2 iteration count');
  }
  if (!Number.isInteger(payload.parallelism) || payload.parallelism < 1) {
    throw new Error('Invalid Argon2 parallelism');
  }
  if (payload.algVersion !== 0x13) {
    throw new Error('Unsupported Argon2 algorithm version');
  }

  return {
    memory: payload.memoryKib,
    iterations: payload.iterations,
    parallelism: payload.parallelism,
    algVersion: 0x13,
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
    algVersion: 0x13,
  },

  /** High-end desktop */
  desktopHigh: {
    memory: 128 * 1024,
    iterations: 3,
    parallelism: 1,
    algVersion: 0x13,
  },

  /** Mobile or low-memory device */
  mobile: {
    memory: 32 * 1024,
    iterations: 4,
    parallelism: 1,
    algVersion: 0x13,
  },

  /** Very constrained device */
  mobileLight: {
    memory: 16 * 1024,
    iterations: 6,
    parallelism: 1,
    algVersion: 0x13,
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
    algVersion: 0x13,
  },
} as const satisfies Record<string, Argon2Params>;
