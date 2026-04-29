package org.mosaic.android.main

import android.app.Application
import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader

/**
 * Application entry point. Eagerly initializes the UniFFI library loader so the
 * native `libmosaic_uniffi.so` is available before any UI thread interaction
 * with the Rust core. Logs only the protocol version; never logs key material,
 * handles, file paths, or user identifiers.
 */
class MosaicApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    AndroidRustCoreLibraryLoader.warmUp()
  }
}
