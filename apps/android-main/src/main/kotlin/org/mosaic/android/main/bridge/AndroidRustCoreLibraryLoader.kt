package org.mosaic.android.main.bridge

import uniffi.mosaic_uniffi.uniffiEnsureInitialized

/**
 * Centralizes UniFFI library initialization for the Mosaic Android module.
 *
 * The generated `uniffi.mosaic_uniffi` bindings load the native `libmosaic_uniffi.so`
 * via JNA the first time any binding class is touched. This object exposes a single
 * `warmUp()` entry point that the `MosaicApplication` calls during `onCreate`, so the
 * native library is ready before any UI thread interaction. Internally it calls the
 * generated `uniffiEnsureInitialized()` which performs both a JNA library load and a
 * UniFFI checksum verification against the native library's exported function table.
 *
 * Tests on a JVM runner can override the library path by setting the system property
 * `uniffi.component.mosaic_uniffi.libraryOverride` BEFORE this object is referenced.
 * Once a UniFFI class is initialized the library override has no effect.
 *
 * This object never logs paths, handles, or key material.
 */
object AndroidRustCoreLibraryLoader {
  @Volatile
  private var initialized: Boolean = false

  /**
   * Forces the generated UniFFI bindings to load the native library and verify its
   * exported function table. Idempotent. Safe to call from any thread; the first
   * call performs work, subsequent calls are no-ops.
   *
   * Throws `uniffi.mosaic_uniffi.InternalException` if the native library is missing
   * or the function table checksum does not match. The exception is intentionally
   * propagated so the caller can fail fast and surface a clean "FFI unavailable"
   * error rather than crashing later in an unrelated code path.
   */
  fun warmUp() {
    if (initialized) return
    synchronized(this) {
      if (initialized) return
      uniffiEnsureInitialized()
      initialized = true
    }
  }
}
