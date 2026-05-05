package org.mosaic.android.main

import android.app.Application
import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import org.mosaic.android.main.work.AutoImportRuntime
import org.mosaic.android.main.work.AutoImportWorkScheduler
import org.mosaic.android.main.work.ShellStubRecordMigration

/**
 * Application entry point. Eagerly initializes the UniFFI library loader so the
 * native `libmosaic_uniffi.so` is available before any UI thread interaction
 * with the Rust core. Logs only the protocol version; never logs key material,
 * handles, file paths, or user identifiers.
 *
 * Auto-import wiring (Band 6, ADR-007):
 * - Installs the platform `UserManager`-backed runtime provider so the
 *   schedule plan can observe the device-unlock gate.
 * - Calls [AutoImportWorkScheduler.enqueueIfPolicyAllows], which short-circuits
 *   on default settings (`AutoImportScheduleSettings.disabled()`). The
 *   enqueue is therefore *policy-conditional* — onCreate never eagerly enqueues
 *   work in the absence of explicit user opt-in.
 */
class MosaicApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    AndroidRustCoreLibraryLoader.warmUp()
    ShellStubRecordMigration.clearOnFirstLaunch(this)
    AutoImportRuntime.installRuntimeProvider(AutoImportRuntime.systemRuntimeProvider(this))
    AutoImportWorkScheduler.enqueueIfPolicyAllows(this)
  }
}
