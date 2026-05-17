package org.mosaic.android.main

import android.app.Application
import androidx.work.Logger
import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import org.mosaic.android.main.crypto.EnvelopeLayoutMigrator
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.privacy.PrivacyAuditPeriodicWorker
import org.mosaic.android.main.service.UploadForegroundService
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
open class MosaicApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    rustCoreWarmUp()
    runCatching { ShellStubRecordMigration.clearOnFirstLaunch(this) }
      .onFailure { Logger.get().warning(TAG, "A-pre-1 cleanup failed", it) }
    runCatching { migrateEnvelopeLayout(this) }
      .onFailure { Logger.get().warning(TAG, "Envelope layout migration scheduling failed", it) }
    installAutoImportRuntime(this)
    registerUploadNotificationChannel(this)
    enqueueAutoImportIfPolicyAllows(this)
    enqueuePrivacyAuditDaily(this)
  }

  companion object {
    private const val TAG = "MosaicApplication"

    internal var rustCoreWarmUp: () -> Unit = AndroidRustCoreLibraryLoader::warmUp
    internal var migrateEnvelopeLayout: (MosaicApplication) -> Unit = { application ->
      val database = UploadQueueDatabase.create(application)
      try {
        EnvelopeLayoutMigrator.migrateIfNeeded(application, database)
      } finally {
        database.close()
      }
    }
    internal var installAutoImportRuntime: (MosaicApplication) -> Unit = { application ->
      AutoImportRuntime.installRuntimeProvider(AutoImportRuntime.systemRuntimeProvider(application))
    }
    internal var registerUploadNotificationChannel: (MosaicApplication) -> Unit = { application ->
      UploadForegroundService.ensureNotificationChannel(application)
    }
    internal var enqueueAutoImportIfPolicyAllows: (MosaicApplication) -> Unit = { application ->
      AutoImportWorkScheduler.enqueueIfPolicyAllows(application)
    }
    internal var enqueuePrivacyAuditDaily: (MosaicApplication) -> Unit = { application ->
      runCatching { PrivacyAuditPeriodicWorker.enqueueDaily(application) }
        .onFailure { Logger.get().warning(TAG, "Privacy audit daily enqueue failed", it) }
    }

    internal fun resetTestHooks() {
      rustCoreWarmUp = AndroidRustCoreLibraryLoader::warmUp
      migrateEnvelopeLayout = { application ->
        val database = UploadQueueDatabase.create(application)
        try {
          EnvelopeLayoutMigrator.migrateIfNeeded(application, database)
        } finally {
          database.close()
        }
      }
      installAutoImportRuntime = { application ->
        AutoImportRuntime.installRuntimeProvider(AutoImportRuntime.systemRuntimeProvider(application))
      }
      registerUploadNotificationChannel = { application ->
        UploadForegroundService.ensureNotificationChannel(application)
      }
      enqueueAutoImportIfPolicyAllows = { application ->
        AutoImportWorkScheduler.enqueueIfPolicyAllows(application)
      }
      enqueuePrivacyAuditDaily = { application ->
        runCatching { PrivacyAuditPeriodicWorker.enqueueDaily(application) }
          .onFailure { Logger.get().warning(TAG, "Privacy audit daily enqueue failed", it) }
      }
    }
  }
}
