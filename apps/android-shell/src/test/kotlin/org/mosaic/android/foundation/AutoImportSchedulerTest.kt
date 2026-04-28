package org.mosaic.android.foundation

private data class AutoImportSchedulerTestCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    AutoImportSchedulerTestCase("auto-import defaults are disabled and constrained", ::autoImportDefaultsAreDisabledAndConstrained),
    AutoImportSchedulerTestCase("enabled schedule requires durable upload-only destination", ::enabledScheduleRequiresDurableUploadOnlyDestination),
    AutoImportSchedulerTestCase("gallery decrypt handles cannot become durable scheduler state", ::galleryDecryptHandlesCannotBecomeDurableSchedulerState),
    AutoImportSchedulerTestCase("device unlock gate blocks scheduling after reboot until first unlock", ::deviceUnlockGateBlocksSchedulingAfterRebootUntilFirstUnlock),
    AutoImportSchedulerTestCase("long-running transfer requires foreground dataSync notification", ::longRunningTransferRequiresForegroundDataSyncNotification),
    AutoImportSchedulerTestCase("transfer progress cancellation and resume states are explicit", ::transferProgressCancellationAndResumeStatesAreExplicit),
    AutoImportSchedulerTestCase("auto-import strings remain privacy safe", ::autoImportStringsRemainPrivacySafe),
    AutoImportSchedulerTestCase("upload-only background capability is separate from gallery decrypt handle", ::uploadOnlyBackgroundCapabilityIsSeparateFromGalleryDecryptHandle),
  )

  var failed = 0
  for (test in tests) {
    try {
      test.body()
      println("PASS ${test.name}")
    } catch (error: Throwable) {
      failed += 1
      println("FAIL ${test.name}: ${error.message}")
    }
  }

  if (failed > 0) {
    throw IllegalStateException("$failed auto-import scheduler tests failed")
  }

  println("PASS ${tests.size} auto-import scheduler tests")
}

private fun autoImportDefaultsAreDisabledAndConstrained() {
  val defaults = AutoImportScheduleSettings.disabled()
  val plan = AutoImportSchedulerContract.evaluate(defaults)

  assertFalse(defaults.enabled)
  assertEquals(null, defaults.destination)
  assertEquals(AutoImportNetworkConstraint.WIFI_ONLY, defaults.constraints.network)
  assertTrue(defaults.constraints.requiresBatteryNotLow)
  assertFalse(defaults.constraints.requiresCharging)
  assertTrue(defaults.deviceUnlockGate.requiresDeviceUnlockedSinceBoot)
  assertEquals(AutoImportScheduleStatus.DISABLED, plan.status)
  assertFalse(plan.canSchedule)
}

private fun enabledScheduleRequiresDurableUploadOnlyDestination() {
  val missingDestination = AutoImportScheduleSettings.enabled(destination = null)
  assertEquals(
    AutoImportScheduleStatus.NEEDS_DESTINATION_ALBUM,
    AutoImportSchedulerContract.evaluate(missingDestination).status,
  )

  val destination = autoImportDestination()
  val ready = AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.enabled(destination))
  assertEquals(AutoImportScheduleStatus.READY_TO_SCHEDULE, ready.status)
  assertTrue(ready.canSchedule)
  assertEquals(AutoImportNetworkConstraint.WIFI_ONLY, ready.constraints.network)
}

private fun galleryDecryptHandlesCannotBecomeDurableSchedulerState() {
  val galleryHandleDestination = AutoImportDestinationSelection(
    albumId = AlbumId("album-1"),
    capability = AutoImportCapability.GalleryDecryptHandle(
      serverAccountId = ServerAccountId("server-account-1"),
      accountKeyHandle = AccountKeyHandle(4242),
    ),
  )

  expectThrows("gallery decrypt handle cannot convert to background scheduler destination") {
    galleryHandleDestination.toBackgroundScheduleDestination()
  }
  expectThrows("gallery decrypt handle cannot be persisted in schedule settings") {
    val durableDestination = AutoImportBackgroundDestination.fromSelection(galleryHandleDestination)
    AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.enabled(durableDestination))
  }
  expectThrows("album-mismatched upload-only capability cannot convert to scheduler destination") {
    AutoImportDestinationSelection(
      albumId = AlbumId("album-2"),
      capability = autoImportUploadCapability(albumId = AlbumId("album-1")),
    ).toBackgroundScheduleDestination()
  }

  val uploadOnlySelection = AutoImportDestinationSelection(
    albumId = AlbumId("album-1"),
    capability = autoImportUploadCapability(capabilityReference = AutoImportCapabilityReference("secret-capability-reference")),
  )
  val durableDestination = uploadOnlySelection.toBackgroundScheduleDestination()
  val settings = AutoImportScheduleSettings.enabled(durableDestination)
  val plan = AutoImportSchedulerContract.evaluate(settings)
  val equivalentDestination = AutoImportBackgroundDestination.fromUploadOnly(
    albumId = AlbumId("album-1"),
    capability = autoImportUploadCapability(capabilityReference = AutoImportCapabilityReference("secret-capability-reference")),
  )

  assertEquals(AutoImportScheduleStatus.READY_TO_SCHEDULE, plan.status)
  assertEquals(ServerAccountId("server-account-1"), durableDestination.serverAccountId)
  assertEquals(AlbumId("album-1"), durableDestination.albumId)
  assertEquals(AutoImportCapabilityReference("secret-capability-reference"), durableDestination.capabilityReference)
  assertEquals(equivalentDestination, durableDestination)
  assertEquals(equivalentDestination.hashCode(), durableDestination.hashCode())

  val durableText = listOf(
    durableDestination.toString(),
    settings.toString(),
    plan.toString(),
  ).joinToString("\n")
  val forbidden = listOf(
    "secret-capability-reference",
    "GalleryDecryptHandle",
    "AccountKeyHandle",
    "4242",
    "content://",
    "file://",
    "IMG_0001.jpg",
    "EXIF",
    "GPS",
    "caption",
    "raw key",
  )
  for (term in forbidden) {
    assertFalse(durableText.contains(term, ignoreCase = true))
  }
  assertTrue(durableText.contains("<redacted>") || durableText.contains("<opaque>"))
}

private fun deviceUnlockGateBlocksSchedulingAfterRebootUntilFirstUnlock() {
  val settings = AutoImportScheduleSettings.enabled(autoImportDestination())

  val afterReboot = AutoImportSchedulerContract.evaluate(
    settings = settings,
    runtime = AutoImportRuntimeConditions(deviceUnlockedSinceBoot = false),
  )
  assertEquals(AutoImportScheduleStatus.WAITING_FOR_DEVICE_UNLOCK, afterReboot.status)
  assertFalse(afterReboot.canSchedule)

  val afterUnlock = AutoImportSchedulerContract.evaluate(
    settings = settings,
    runtime = AutoImportRuntimeConditions(deviceUnlockedSinceBoot = true),
  )
  assertEquals(AutoImportScheduleStatus.READY_TO_SCHEDULE, afterUnlock.status)
  assertTrue(afterUnlock.canSchedule)
}

private fun longRunningTransferRequiresForegroundDataSyncNotification() {
  val running = AutoImportTransferState.running(
    scheduleId = AutoImportScheduleId("schedule-1"),
    progress = AutoImportTransferProgress(scannedItems = 3, queuedItems = 2, uploadedItems = 1, uploadedBytes = 512, totalBytes = 2048),
  )

  assertEquals(AutoImportTransferStatus.RUNNING, running.status)
  assertEquals(ForegroundServiceType.DATA_SYNC, running.foregroundNotification?.serviceType)
  assertEquals(emptyList<String>(), running.foregroundPolicyViolations())

  val invalid = running.copy(
    foregroundNotification = AutoImportForegroundNotificationPolicy(
      required = false,
      serviceType = ForegroundServiceType.NONE,
      userVisible = false,
    ),
  )
  assertEquals(
    listOf(
      "auto-import transfer must run as foreground work",
      "auto-import transfer must declare foregroundServiceType=dataSync",
      "auto-import transfer must show a user-visible notification",
    ),
    invalid.foregroundPolicyViolations(),
  )

  expectThrows("non-running foreground policy rejected") {
    AutoImportTransferState.scheduled(AutoImportScheduleId("schedule-paused")).copy(
      foregroundNotification = AutoImportForegroundNotificationPolicy.dataSync(),
    )
  }
}

private fun transferProgressCancellationAndResumeStatesAreExplicit() {
  val scheduled = AutoImportTransferState.scheduled(AutoImportScheduleId("schedule-1"))
  val running = scheduled.markRunning()
    .withProgress(
      AutoImportTransferProgress(scannedItems = 10, queuedItems = 6, uploadedItems = 3, uploadedBytes = 1024, totalBytes = 4096),
    )
  assertEquals(AutoImportTransferStatus.RUNNING, running.status)
  assertEquals(3, running.progress.uploadedItems)
  assertEquals(AutoImportCancellationState.NONE, running.cancellationState)

  val cancellationRequested = running.requestCancellation()
  assertEquals(AutoImportTransferStatus.CANCELLATION_REQUESTED, cancellationRequested.status)
  assertEquals(AutoImportCancellationState.REQUESTED, cancellationRequested.cancellationState)
  assertEquals(running.progress, cancellationRequested.progress)

  val cancelled = cancellationRequested.markCancelled()
  assertEquals(AutoImportTransferStatus.CANCELLED, cancelled.status)
  assertEquals(AutoImportCancellationState.CANCELLED, cancelled.cancellationState)

  val resumed = cancelled.resume()
  assertEquals(AutoImportTransferStatus.SCHEDULED, resumed.status)
  assertEquals(AutoImportCancellationState.NONE, resumed.cancellationState)
  assertEquals(cancelled.progress, resumed.progress)

  val paused = running.markPausedWaitingForConstraints()
  assertEquals(AutoImportTransferStatus.PAUSED_WAITING_FOR_CONSTRAINTS, paused.status)
  assertEquals(null, paused.foregroundNotification)
  assertEquals(AutoImportCancellationState.NONE, paused.cancellationState)

  val pausedCancellation = paused.requestCancellation()
  assertEquals(AutoImportTransferStatus.CANCELLATION_REQUESTED, pausedCancellation.status)
  assertEquals(AutoImportCancellationState.REQUESTED, pausedCancellation.cancellationState)
  assertEquals(null, pausedCancellation.foregroundNotification)
  assertEquals(emptyList<String>(), pausedCancellation.foregroundPolicyViolations())

  val resumedFromPause = paused.resume()
  assertEquals(AutoImportTransferStatus.SCHEDULED, resumedFromPause.status)
  assertEquals(AutoImportCancellationState.NONE, resumedFromPause.cancellationState)

  val completed = running.markCompleted()
  assertEquals(AutoImportTransferStatus.COMPLETED, completed.status)
  assertEquals(null, completed.foregroundNotification)
  assertEquals(null, completed.failureReason)

  val failed = running.markFailed(AutoImportTransferFailureReason.UPLOAD_CAPABILITY_REVOKED)
  assertEquals(AutoImportTransferStatus.FAILED, failed.status)
  assertEquals(AutoImportTransferFailureReason.UPLOAD_CAPABILITY_REVOKED, failed.failureReason)
  assertEquals(null, failed.foregroundNotification)
}

private fun autoImportStringsRemainPrivacySafe() {
  val destination = autoImportDestination(
    albumId = AlbumId("private-album"),
    capabilityReference = AutoImportCapabilityReference("secret-capability-reference"),
  )
  val settings = AutoImportScheduleSettings.enabled(destination)
  val plan = AutoImportSchedulerContract.evaluate(settings)
  val transfer = AutoImportTransferState.running(
    scheduleId = AutoImportScheduleId("secret-schedule-id"),
    progress = AutoImportTransferProgress(scannedItems = 1, queuedItems = 1, uploadedItems = 0, uploadedBytes = 0, totalBytes = 4096),
  ).requestCancellation()

  val safeText = listOf(
    destination.toString(),
    destination.capabilityReference.toString(),
    settings.toString(),
    plan.toString(),
    transfer.toString(),
  ).joinToString("\n")

  val forbidden = listOf(
    "private-album",
    "secret-capability-reference",
    "secret-schedule-id",
    "content://",
    "file://",
    "IMG_0001.jpg",
    "EXIF",
    "GPS",
    "camera",
    "decrypted",
    "raw key",
    "4242",
  )
  for (term in forbidden) {
    assertFalse(safeText.contains(term, ignoreCase = true))
  }
  assertTrue(safeText.contains("<redacted>") || safeText.contains("<opaque>"))

  expectThrows("auto-import schedule rejects plaintext metadata") {
    AutoImportScheduleSettings.enabled(
      destination = destination,
      prohibited = ProhibitedQueuePayload(
        filename = "IMG_0001.jpg",
        exif = mapOf("Model" to "camera"),
        gps = "50.087,14.421",
        rawKeys = listOf(byteArrayOf(1, 2, 3)),
        decryptedMetadata = mapOf("caption" to "secret"),
        rawUri = "content://media/external/images/1",
      ),
    )
  }
}

private fun uploadOnlyBackgroundCapabilityIsSeparateFromGalleryDecryptHandle() {
  val galleryHandle = AutoImportCapability.GalleryDecryptHandle(
    serverAccountId = ServerAccountId("server-account-1"),
    accountKeyHandle = AccountKeyHandle(4242),
  )
  val uploadOnly = autoImportUploadCapability()

  assertTrue(galleryHandle.canDecryptForUserPresentGallery)
  assertFalse(galleryHandle.canUploadInBackground)
  assertFalse(uploadOnly.canDecryptForUserPresentGallery)
  assertTrue(uploadOnly.canUploadInBackground)

  val selected = AutoImportDestinationSelection(
    albumId = AlbumId("album-1"),
    capability = uploadOnly,
  )
  val durableDestination = selected.toBackgroundScheduleDestination()
  val plan = AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.enabled(durableDestination))
  assertEquals(AutoImportScheduleStatus.READY_TO_SCHEDULE, plan.status)
  assertEquals(uploadOnly.serverAccountId, durableDestination.serverAccountId)
  assertEquals(uploadOnly.albumId, durableDestination.albumId)
  assertEquals(uploadOnly.reference, durableDestination.capabilityReference)
  assertFalse(plan.toString().contains("4242"))
}

private fun autoImportDestination(
  albumId: AlbumId = AlbumId("album-1"),
  capabilityReference: AutoImportCapabilityReference = AutoImportCapabilityReference("upload-capability-1"),
): AutoImportBackgroundDestination =
  AutoImportDestinationSelection(
    albumId = albumId,
    capability = autoImportUploadCapability(albumId = albumId, capabilityReference = capabilityReference),
  ).toBackgroundScheduleDestination()

private fun autoImportUploadCapability(
  albumId: AlbumId = AlbumId("album-1"),
  capabilityReference: AutoImportCapabilityReference = AutoImportCapabilityReference("upload-capability-1"),
): AutoImportCapability.UploadOnly = AutoImportCapability.UploadOnly(
  serverAccountId = ServerAccountId("server-account-1"),
  albumId = albumId,
  reference = capabilityReference,
)

private fun assertTrue(value: Boolean) {
  if (!value) {
    throw AssertionError("Expected true")
  }
}

private fun assertFalse(value: Boolean) {
  if (value) {
    throw AssertionError("Expected false")
  }
}

private fun <T> assertEquals(expected: T, actual: T) {
  if (expected != actual) {
    throw AssertionError("Expected <$expected> but was <$actual>")
  }
}

private fun expectThrows(label: String, body: () -> Unit) {
  try {
    body()
  } catch (_: IllegalArgumentException) {
    return
  }
  throw AssertionError("Expected IllegalArgumentException for $label")
}
