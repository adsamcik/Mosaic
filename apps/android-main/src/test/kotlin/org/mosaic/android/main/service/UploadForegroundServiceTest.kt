package org.mosaic.android.main.service

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.R
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [34])
class UploadForegroundServiceTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  @After
  fun resetHooks() {
    UploadForegroundService.resetTestHooks()
  }

  @Test
  fun serviceStartsForegroundAndUnsubscribesOnDestroy() {
    val controller = RecordingUploadController()
    UploadForegroundService.uploadController = controller
    val serviceController = Robolectric.buildService(UploadForegroundService::class.java)
    val service = serviceController.create().get()

    val shadowService = shadowOf(service)
    assertEquals(UploadForegroundService.NOTIFICATION_ID, shadowService.lastForegroundNotificationId)
    assertNotNull(shadowService.lastForegroundNotification)
    assertEquals(1, controller.listenerCount)

    serviceController.destroy()

    assertEquals(0, controller.listenerCount)
  }

  @Test
  fun notificationContainsProgressAndCancelAction() {
    val notification = UploadForegroundService.buildNotification(context, completed = 2, total = 5)

    assertEquals(
      context.getString(R.string.upload_in_progress),
      notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString(),
    )
    assertEquals(
      context.getString(R.string.upload_n_of_m, 2, 5),
      notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
    )
    assertEquals(1, notification.actions.size)
    assertEquals(context.getString(R.string.cancel), notification.actions.single().title.toString())
  }

  @Test
  fun updateProgressRepostsNotificationWithLatestCounts() {
    val serviceController = Robolectric.buildService(UploadForegroundService::class.java)
    val service = serviceController.create().get()

    service.updateProgress(completed = 3, total = 7)

    val notificationManager = context.getSystemService(NotificationManager::class.java)
    val posted = notificationManager.activeNotifications
      .first { it.id == UploadForegroundService.NOTIFICATION_ID }
      .notification
    assertEquals(
      context.getString(R.string.upload_n_of_m, 3, 7),
      posted.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
    )

    serviceController.destroy()
  }

  @Test
  fun cancelActionRequestsReducerCancellation() {
    val controller = RecordingUploadController()
    UploadForegroundService.uploadController = controller
    val serviceController = Robolectric.buildService(UploadForegroundService::class.java)
    val service = serviceController.create().get()

    service.onStartCommand(
      Intent(context, UploadForegroundService::class.java)
        .setAction(UploadForegroundService.ACTION_CANCEL),
      0,
      1,
    )

    assertEquals(1, controller.cancellationRequests)
    serviceController.destroy()
  }

  @Test
  fun finalizedReducerStateStopsService() {
    val controller = RecordingUploadController()
    UploadForegroundService.uploadController = controller
    val serviceController = Robolectric.buildService(UploadForegroundService::class.java)
    val service = serviceController.create().get()

    controller.emit(UploadForegroundState.FINALIZED)

    assertTrue(shadowOf(service).isStoppedBySelf)
    serviceController.destroy()
  }

  @Test
  fun cancelledReducerStateStopsService() {
    val controller = RecordingUploadController()
    UploadForegroundService.uploadController = controller
    val serviceController = Robolectric.buildService(UploadForegroundService::class.java)
    val service = serviceController.create().get()

    controller.emit(UploadForegroundState.CANCELLED)

    assertTrue(shadowOf(service).isStoppedBySelf)
    serviceController.destroy()
  }

  @Test
  fun uploadNotificationChannelRegistrationIsIdempotent() {
    UploadForegroundService.ensureNotificationChannel(context)
    val notificationManager = context.getSystemService(NotificationManager::class.java)
    val channel = notificationManager.getNotificationChannel(UploadForegroundService.NOTIFICATION_CHANNEL_ID)
    assertNotNull(channel)
    assertEquals(context.getString(R.string.upload_notification_channel_name), channel.name.toString())

    UploadForegroundService.ensureNotificationChannel(context)
    assertEquals(
      channel,
      notificationManager.getNotificationChannel(UploadForegroundService.NOTIFICATION_CHANNEL_ID),
    )
  }

  private class RecordingUploadController : UploadForegroundController {
    var cancellationRequests: Int = 0
      private set

    private val listeners = linkedSetOf<(UploadForegroundState) -> Unit>()

    val listenerCount: Int
      get() = listeners.size

    override fun requestCancellation() {
      cancellationRequests += 1
    }

    override fun observeUploadState(listener: (UploadForegroundState) -> Unit): AutoCloseable {
      listeners += listener
      return AutoCloseable { listeners -= listener }
    }

    fun emit(state: UploadForegroundState) {
      listeners.toList().forEach { listener -> listener(state) }
    }
  }
}
