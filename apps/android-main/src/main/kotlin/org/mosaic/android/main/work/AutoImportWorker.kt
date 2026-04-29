package org.mosaic.android.main.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import org.mosaic.android.foundation.AutoImportSchedulerContract
import org.mosaic.android.foundation.AutoImportTransferStatus
import org.mosaic.android.main.R

/**
 * `CoroutineWorker` implementation for the Band 6 auto-import seam. Runs as a
 * `dataSync` foreground service per ADR-007 once the schedule plan resolves to
 * `READY_TO_SCHEDULE`, and short-circuits cleanly when the auto-import
 * capability has been revoked between enqueue and execution.
 *
 * **Capability-boundary contract.** The worker re-evaluates the live schedule
 * settings inside `doWork()` rather than trusting the snapshot used at enqueue
 * time. If the user has disabled auto-import, removed the destination album,
 * or otherwise revoked the upload-only capability, the worker returns
 * `Result.success()` without promoting itself to the foreground or doing any
 * upload work. This matches the shell-side
 * `AutoImportTransferFailureReason.UPLOAD_CAPABILITY_REVOKED` semantic without
 * ever touching the network or any encryption material.
 *
 * **Foreground promotion.** When the plan is ready, the worker calls
 * `setForeground(...)` with `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` to
 * satisfy the Android 14+ requirement that long-running upload work declare
 * its service type at runtime as well as in the manifest.
 *
 * **No upload yet.** This slice wires the seam into a real WorkManager
 * worker. The actual encrypt → upload pipeline lands in a follow-up slice.
 * The worker therefore returns `Result.success()` immediately after the
 * foreground promotion. Tests assert the enqueue / dedupe / short-circuit
 * behavior; the upload payload is owned by a later band.
 */
class AutoImportWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

  override suspend fun doWork(): Result {
    val plan = AutoImportSchedulerContract.evaluate(
      AutoImportRuntime.currentSettings(),
      AutoImportRuntime.currentRuntime(),
    )
    val decision = AutoImportWorkPolicy.decide(plan)
    if (decision != AutoImportWorkPolicy.Decision.ENQUEUE) {
      // Capability revoked / settings disabled / device locked again. Treat
      // this as a benign no-op rather than a failure so WorkManager does not
      // schedule retries for an intentionally torn-down auto-import session.
      return Result.success()
    }

    val foregroundInfo = buildForegroundInfo()
    runCatching { setForeground(foregroundInfo) }
      .onFailure { return Result.success() }

    // Real encrypt / upload pipeline arrives in a follow-up slice (Band 6
    // continuation). The seam-level state machine is exercised by the
    // shell-side `AutoImportTransferState` tests; this worker just proves the
    // WorkManager wiring up to and including the foreground promotion.
    @Suppress("UNUSED_VARIABLE")
    val running = AutoImportTransferStatus.RUNNING
    return Result.success()
  }

  private fun buildForegroundInfo(): ForegroundInfo {
    val context = applicationContext
    val channelId = ensureNotificationChannel(context)
    val notification = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(context.getString(R.string.auto_import_notification_title))
      .setContentText(context.getString(R.string.auto_import_notification_text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureNotificationChannel(context: Context): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = context.getSystemService(NotificationManager::class.java)
      if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
        val name = context.getString(R.string.auto_import_notification_channel_name)
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW),
        )
      }
    }
    return CHANNEL_ID
  }

  companion object {
    /** Shared notification channel id for auto-import foreground promotions. */
    const val CHANNEL_ID: String = "mosaic.auto-import"

    /**
     * Stable notification id used by [setForeground]. WorkManager requires the
     * id be non-zero and unique within the process for the lifetime of the
     * foreground service.
     */
    const val NOTIFICATION_ID: Int = 0x6D416910 // arbitrary stable id ("mAi", 0x10)
  }
}
