package org.mosaic.android.main.privacy

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import org.mosaic.android.main.R
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.staging.AppPrivateStagingManager

class PrivacyAuditPeriodicWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val db = UploadQueueDatabase.create(applicationContext)
    return try {
      val auditor = PrivacyAuditor(
        staging = AppPrivateStagingManager(applicationContext),
        database = db,
        logTail = AndroidLogTailReader(),
      )
      val report = auditor.runAudit()
      if (!report.isClean) {
        emitFindingNotification(report)
      }
      Result.success()
    } catch (_: RuntimeException) {
      Result.retry()
    } finally {
      db.close()
    }
  }

  private fun emitFindingNotification(report: PrivacyAuditReport) {
    val context = applicationContext
    val channelId = ensureNotificationChannel(context)
    val findingCount = report.staleStaging.size +
      report.plaintextInDb.size +
      report.plaintextInLogs.size +
      if (report.cleanupRecency.recentEnough) 0 else 1
    val notification = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Mosaic privacy audit")
      .setContentText("Privacy audit found $findingCount issue(s).")
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    context.getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification)
  }

  private fun ensureNotificationChannel(context: Context): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val notificationManager = context.getSystemService(NotificationManager::class.java)
      if (notificationManager != null && notificationManager.getNotificationChannel(CHANNEL_ID) == null) {
        notificationManager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Mosaic privacy audit", NotificationManager.IMPORTANCE_LOW).apply {
            setSound(null, null)
            enableVibration(false)
          },
        )
      }
    }
    return CHANNEL_ID
  }

  companion object {
    const val UNIQUE_WORK_NAME: String = "mosaic.privacy-audit.periodic"
    const val CHANNEL_ID: String = "mosaic.privacy-audit"
    const val NOTIFICATION_ID: Int = 0x6D507276

    fun enqueueDaily(context: Context): Boolean {
      val request = PeriodicWorkRequestBuilder<PrivacyAuditPeriodicWorker>(1, TimeUnit.DAYS)
        .build()
      return runCatching {
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
          UNIQUE_WORK_NAME,
          ExistingPeriodicWorkPolicy.KEEP,
          request,
        )
      }.isSuccess
    }
  }
}
