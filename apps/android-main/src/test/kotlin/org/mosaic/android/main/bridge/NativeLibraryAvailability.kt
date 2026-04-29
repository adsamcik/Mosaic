package org.mosaic.android.main.bridge

/**
 * Centralizes the host-built native library detection used by JVM-only adapter
 * round-trip tests. JVM tests only run if the Gradle build provided
 * `uniffi.component.mosaic_uniffi.libraryOverride` AND the file at that path
 * exists — otherwise the tests skip themselves to avoid false positives on
 * machines where the Rust artifact has not been produced.
 */
internal object NativeLibraryAvailability {
  private const val OVERRIDE_PROPERTY: String = "uniffi.component.mosaic_uniffi.libraryOverride"

  val isAvailable: Boolean by lazy {
    val path = System.getProperty(OVERRIDE_PROPERTY) ?: return@lazy false
    val file = java.io.File(path)
    file.exists() && file.length() > 0
  }

  val libraryPath: String?
    get() = System.getProperty(OVERRIDE_PROPERTY)
}
