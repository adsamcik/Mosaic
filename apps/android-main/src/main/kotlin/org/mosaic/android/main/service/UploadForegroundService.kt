package org.mosaic.android.main.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import org.mosaic.android.main.R

class UploadForegroundService : LifecycleService() {
  private var completedShards: Int = 0
  private var totalShards: Int = 0
  private var stateSubscription: AutoCloseable? = null

  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannel(this)
    stateSubscription = uploadController.observeUploadState { state ->
      if (state.isTerminal) {
        stopSelf()
      }
    }
    startForegroundCompat(buildNotification(completedShards, totalShards))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    super.onStartCommand(intent, flags, startId)
    when (intent?.action) {
      ACTION_CANCEL -> uploadController.requestCancellation()
      ACTION_UPDATE_PROGRESS -> updateProgress(
        intent.getIntExtra(EXTRA_COMPLETED_SHARDS, completedShards),
        intent.getIntExtra(EXTRA_TOTAL_SHARDS, totalShards),
      )
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stateSubscription?.close()
    stateSubscription = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  fun updateProgress(completed: Int, total: Int) {
    completedShards = completed.coerceAtLeast(0)
    totalShards = total.coerceAtLeast(0)
    val notification = buildNotification(completedShards, totalShards)
    val notificationManager = getSystemService(NotificationManager::class.java)
    notificationManager?.notify(NOTIFICATION_ID, notification)
  }

  internal fun buildNotification(completed: Int, total: Int): Notification =
    buildNotification(this, completed, total)

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    const val NOTIFICATION_ID: Int = 1001
    const val NOTIFICATION_CHANNEL_ID: String = "mosaic_upload"

    internal const val ACTION_CANCEL: String = "org.mosaic.android.main.service.UPLOAD_CANCEL"
    internal const val ACTION_UPDATE_PROGRESS: String = "org.mosaic.android.main.service.UPLOAD_UPDATE_PROGRESS"
    internal const val EXTRA_COMPLETED_SHARDS: String = "org.mosaic.android.main.service.COMPLETED_SHARDS"
    internal const val EXTRA_TOTAL_SHARDS: String = "org.mosaic.android.main.service.TOTAL_SHARDS"

    internal var uploadController: UploadForegroundController = NoopUploadForegroundController

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, UploadForegroundService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, UploadForegroundService::class.java))
    }

    fun progressIntent(context: Context, completed: Int, total: Int): Intent =
      Intent(context, UploadForegroundService::class.java)
        .setAction(ACTION_UPDATE_PROGRESS)
        .putExtra(EXTRA_COMPLETED_SHARDS, completed)
        .putExtra(EXTRA_TOTAL_SHARDS, total)

    internal fun ensureNotificationChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val notificationManager = context.getSystemService(NotificationManager::class.java) ?: return
      if (notificationManager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) != null) return
      notificationManager.createNotificationChannel(
        NotificationChannel(
          NOTIFICATION_CHANNEL_ID,
          context.getString(R.string.upload_notification_channel_name),
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = context.getString(R.string.upload_notification_channel_description)
        },
      )
    }

    internal fun buildNotification(context: Context, completed: Int, total: Int): Notification {
      val safeCompleted = completed.coerceAtLeast(0)
      val safeTotal = total.coerceAtLeast(0)
      val cancelIntent = PendingIntent.getService(
        context,
        0,
        Intent(context, UploadForegroundService::class.java).setAction(ACTION_CANCEL),
        PendingIntent.FLAG_UPDATE_CURRENT or pendingIntentImmutableFlag(),
      )
      return androidx.core.app.NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
        .setContentTitle(context.getString(R.string.upload_in_progress))
        .setContentText(context.getString(R.string.upload_n_of_m, safeCompleted, safeTotal))
        .setSmallIcon(R.drawable.ic_upload)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setProgress(safeTotal, safeCompleted.coerceAtMost(safeTotal), safeTotal == 0)
        .addAction(R.drawable.ic_cancel, context.getString(R.string.cancel), cancelIntent)
        .build()
    }

    internal fun resetTestHooks() {
      uploadController = NoopUploadForegroundController
    }

    private fun pendingIntentImmutableFlag(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
  }
}

interface UploadForegroundController {
  fun requestCancellation()

  fun observeUploadState(listener: (UploadForegroundState) -> Unit): AutoCloseable
}

enum class UploadForegroundState {
  RUNNING,
  FINALIZED,
  CANCELLED,
}

private val UploadForegroundState.isTerminal: Boolean
  get() = this == UploadForegroundState.FINALIZED || this == UploadForegroundState.CANCELLED

private object NoopUploadForegroundController : UploadForegroundController {
  override fun requestCancellation() = Unit

  override fun observeUploadState(listener: (UploadForegroundState) -> Unit): AutoCloseable = AutoCloseable { }
}
