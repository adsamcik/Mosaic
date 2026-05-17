package org.mosaic.android.main.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import org.mosaic.android.main.R

/**
 * Shared notification channel + foreground-info builder for shard-pipeline
 * workers (encryption + tus upload).
 *
 * `WorkManager.setExpedited(RUN_AS_NON_EXPEDITED_WORK_REQUEST)` requires every
 * `CoroutineWorker.getForegroundInfo()` implementation to return a valid
 * `ForegroundInfo` so the platform can promote the worker on devices where
 * expedited quota is available. The fallback policy means: if quota is
 * exhausted the worker still executes — just as standard, non-expedited work.
 *
 * Privacy invariant: the notification content is generic ("Uploading album to
 * the cloud") and MUST NOT include album names, photo identifiers, file paths,
 * or any other user-identifying material. Channel importance is `IMPORTANCE_LOW`
 * so background work never plays sound or vibrates the device.
 *
 * Each worker uses a distinct notification id so a concurrent encrypt+upload
 * pair does not overwrite the other's notification within the same process.
 */
internal object ShardWorkerForegroundInfo {
  const val CHANNEL_ID: String = "mosaic.shard-upload"

  /** Stable notification id for `ShardEncryptionWorker.getForegroundInfo()`. */
  const val ENCRYPTION_NOTIFICATION_ID: Int = 0x6D536845 // 'mShE'

  /** Stable notification id for `ShardUploadWorker.getForegroundInfo()`. */
  const val UPLOAD_NOTIFICATION_ID: Int = 0x6D536855 // 'mShU'

  fun forEncryption(context: Context): ForegroundInfo =
    buildForegroundInfo(context, ENCRYPTION_NOTIFICATION_ID)

  fun forUpload(context: Context): ForegroundInfo =
    buildForegroundInfo(context, UPLOAD_NOTIFICATION_ID)

  private fun buildForegroundInfo(context: Context, notificationId: Int): ForegroundInfo {
    ensureNotificationChannel(context)
    val notification = buildNotification(context)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(notificationId, notification)
    }
  }

  private fun buildNotification(context: Context): Notification =
    NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_upload)
      .setContentTitle(context.getString(R.string.shard_upload_notification_text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()

  private fun ensureNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    nm.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        context.getString(R.string.shard_upload_notification_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ),
    )
  }
}
