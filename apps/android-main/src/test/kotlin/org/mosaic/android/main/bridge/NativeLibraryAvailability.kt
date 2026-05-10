package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue

/**
 * Centralizes the host-built native library detection used by JVM-only adapter
 * round-trip tests. JVM tests only run if the Gradle build provided
 * `uniffi.component.mosaic_uniffi.libraryOverride` AND the file at that path
 * exists. Local runs skip themselves to avoid false positives on machines
 * where the Rust artifact has not been produced; CI fails hard instead.
 */
internal object NativeLibraryAvailability {
  private const val OVERRIDE_PROPERTY: String = "uniffi.component.mosaic_uniffi.libraryOverride"
  private const val CI_SKIP_FAILURE_MESSAGE: String =
    "JNI library failed to load in CI; cross-client-vectors corpus would be silently skipped"

  val isAvailable: Boolean by lazy {
    val path = System.getProperty(OVERRIDE_PROPERTY) ?: return@lazy false
    val file = java.io.File(path)
    file.exists() && file.length() > 0
  }

  val libraryPath: String?
    get() = System.getProperty(OVERRIDE_PROPERTY)

  fun assumeAvailableOrFailInCi(message: String = "host mosaic_uniffi library not available") {
    val isCi = System.getenv("CI") == "true"
    if (isCi) {
      check(isAvailable) { CI_SKIP_FAILURE_MESSAGE }
    } else {
      assumeTrue(message, isAvailable)
    }
  }
}
