package org.mosaic.android.foundation

@JvmInline
value class AutoImportCapabilityReference(val value: String) {
  init {
    require(value.isNotBlank()) { "auto-import capability reference is required" }
  }

  override fun toString(): String = "AutoImportCapabilityReference(<redacted>)"
}

@JvmInline
value class AutoImportScheduleId(val value: String) {
  init {
    require(value.isNotBlank()) { "auto-import schedule id is required" }
  }

  override fun toString(): String = "AutoImportScheduleId(<redacted>)"
}

sealed interface AutoImportCapability {
  val canDecryptForUserPresentGallery: Boolean
  val canUploadInBackground: Boolean

  data class GalleryDecryptHandle(
    val serverAccountId: ServerAccountId,
    val accountKeyHandle: AccountKeyHandle,
  ) : AutoImportCapability {
    override val canDecryptForUserPresentGallery: Boolean = true
    override val canUploadInBackground: Boolean = false

    override fun toString(): String =
      "AutoImportCapability.GalleryDecryptHandle(serverAccountId=<opaque>, accountKeyHandle=<redacted>)"
  }

  data class UploadOnly(
    val serverAccountId: ServerAccountId,
    val albumId: AlbumId,
    val reference: AutoImportCapabilityReference,
  ) : AutoImportCapability {
    override val canDecryptForUserPresentGallery: Boolean = false
    override val canUploadInBackground: Boolean = true

    override fun toString(): String =
      "AutoImportCapability.UploadOnly(serverAccountId=<opaque>, albumId=<opaque>, reference=<redacted>)"
  }
}

data class AutoImportDestinationSelection(
  val albumId: AlbumId,
  val capability: AutoImportCapability,
) {
  val uploadOnlyCapability: AutoImportCapability.UploadOnly?
    get() = capability as? AutoImportCapability.UploadOnly

  val hasAlbumBoundUploadCapability: Boolean
    get() = uploadOnlyCapability?.albumId == albumId

  override fun toString(): String =
    "AutoImportDestinationSelection(albumId=<opaque>, capability=$capability)"
}

enum class AutoImportNetworkConstraint {
  WIFI_ONLY,
}

data class AutoImportConstraints(
  val network: AutoImportNetworkConstraint,
  val requiresBatteryNotLow: Boolean,
  val requiresCharging: Boolean,
) {
  companion object {
    fun default(): AutoImportConstraints = AutoImportConstraints(
      network = AutoImportNetworkConstraint.WIFI_ONLY,
      requiresBatteryNotLow = true,
      requiresCharging = false,
    )
  }
}

data class AutoImportDeviceUnlockGate(
  val requiresDeviceUnlockedSinceBoot: Boolean,
) {
  companion object {
    fun default(): AutoImportDeviceUnlockGate = AutoImportDeviceUnlockGate(
      requiresDeviceUnlockedSinceBoot = true,
    )
  }
}

data class AutoImportRuntimeConditions(
  val deviceUnlockedSinceBoot: Boolean = true,
)

data class AutoImportForegroundNotificationPolicy(
  val required: Boolean,
  val serviceType: ForegroundServiceType,
  val userVisible: Boolean,
) {
  fun violationsForLongRunningTransfer(): List<String> {
    val violations = mutableListOf<String>()
    if (!required) {
      violations += "auto-import transfer must run as foreground work"
    }
    if (serviceType != ForegroundServiceType.DATA_SYNC) {
      violations += "auto-import transfer must declare foregroundServiceType=dataSync"
    }
    if (!userVisible) {
      violations += "auto-import transfer must show a user-visible notification"
    }
    return violations
  }

  companion object {
    fun dataSync(): AutoImportForegroundNotificationPolicy = AutoImportForegroundNotificationPolicy(
      required = true,
      serviceType = ForegroundServiceType.DATA_SYNC,
      userVisible = true,
    )
  }
}

class AutoImportScheduleSettings private constructor(
  val enabled: Boolean,
  val destination: AutoImportDestinationSelection?,
  val constraints: AutoImportConstraints,
  val deviceUnlockGate: AutoImportDeviceUnlockGate,
) {
  override fun toString(): String =
    "AutoImportScheduleSettings(enabled=$enabled, destination=${if (destination == null) "<none>" else "<redacted>"}, " +
      "constraints=$constraints, deviceUnlockGate=$deviceUnlockGate)"

  companion object {
    fun disabled(
      constraints: AutoImportConstraints = AutoImportConstraints.default(),
      deviceUnlockGate: AutoImportDeviceUnlockGate = AutoImportDeviceUnlockGate.default(),
    ): AutoImportScheduleSettings = AutoImportScheduleSettings(
      enabled = false,
      destination = null,
      constraints = constraints,
      deviceUnlockGate = deviceUnlockGate,
    )

    fun enabled(
      destination: AutoImportDestinationSelection?,
      constraints: AutoImportConstraints = AutoImportConstraints.default(),
      deviceUnlockGate: AutoImportDeviceUnlockGate = AutoImportDeviceUnlockGate.default(),
      prohibited: ProhibitedQueuePayload = ProhibitedQueuePayload.None,
    ): AutoImportScheduleSettings {
      prohibited.validateEmpty()
      return AutoImportScheduleSettings(
        enabled = true,
        destination = destination,
        constraints = constraints,
        deviceUnlockGate = deviceUnlockGate,
      )
    }
  }
}

enum class AutoImportScheduleStatus {
  DISABLED,
  NEEDS_DESTINATION_ALBUM,
  NEEDS_UPLOAD_ONLY_CAPABILITY,
  WAITING_FOR_DEVICE_UNLOCK,
  READY_TO_SCHEDULE,
}

data class AutoImportSchedulePlan(
  val status: AutoImportScheduleStatus,
  val destination: AutoImportDestinationSelection?,
  val constraints: AutoImportConstraints,
  val deviceUnlockGate: AutoImportDeviceUnlockGate,
  val foregroundNotification: AutoImportForegroundNotificationPolicy,
) {
  val canSchedule: Boolean
    get() = status == AutoImportScheduleStatus.READY_TO_SCHEDULE

  override fun toString(): String =
    "AutoImportSchedulePlan(status=$status, destination=${if (destination == null) "<none>" else "<redacted>"}, " +
      "constraints=$constraints, deviceUnlockGate=$deviceUnlockGate, foregroundNotification=$foregroundNotification)"
}

object AutoImportSchedulerContract {
  fun evaluate(
    settings: AutoImportScheduleSettings,
    runtime: AutoImportRuntimeConditions = AutoImportRuntimeConditions(),
  ): AutoImportSchedulePlan {
    val status = when {
      !settings.enabled -> AutoImportScheduleStatus.DISABLED
      settings.destination == null -> AutoImportScheduleStatus.NEEDS_DESTINATION_ALBUM
      !settings.destination.hasAlbumBoundUploadCapability -> AutoImportScheduleStatus.NEEDS_UPLOAD_ONLY_CAPABILITY
      settings.deviceUnlockGate.requiresDeviceUnlockedSinceBoot && !runtime.deviceUnlockedSinceBoot ->
        AutoImportScheduleStatus.WAITING_FOR_DEVICE_UNLOCK
      else -> AutoImportScheduleStatus.READY_TO_SCHEDULE
    }

    return AutoImportSchedulePlan(
      status = status,
      destination = settings.destination,
      constraints = settings.constraints,
      deviceUnlockGate = settings.deviceUnlockGate,
      foregroundNotification = AutoImportForegroundNotificationPolicy.dataSync(),
    )
  }
}

enum class AutoImportTransferStatus {
  SCHEDULED,
  RUNNING,
  PAUSED_WAITING_FOR_CONSTRAINTS,
  CANCELLATION_REQUESTED,
  CANCELLED,
  COMPLETED,
  FAILED,
}

enum class AutoImportCancellationState {
  NONE,
  REQUESTED,
  CANCELLED,
}

enum class AutoImportTransferFailureReason {
  CONSTRAINT_TIMEOUT,
  UPLOAD_CAPABILITY_REVOKED,
  INTERNAL_ERROR,
}

data class AutoImportTransferProgress(
  val scannedItems: Int,
  val queuedItems: Int,
  val uploadedItems: Int,
  val uploadedBytes: Long,
  val totalBytes: Long?,
) {
  init {
    require(scannedItems >= 0) { "scanned item count must not be negative" }
    require(queuedItems >= 0) { "queued item count must not be negative" }
    require(uploadedItems >= 0) { "uploaded item count must not be negative" }
    require(uploadedBytes >= 0) { "uploaded byte count must not be negative" }
    require(totalBytes == null || totalBytes >= 0) { "total byte count must not be negative" }
    require(uploadedItems <= queuedItems) { "uploaded items must not exceed queued items" }
    require(queuedItems <= scannedItems) { "queued items must not exceed scanned items" }
    require(totalBytes == null || uploadedBytes <= totalBytes) { "uploaded bytes must not exceed total bytes" }
  }

  companion object {
    fun empty(): AutoImportTransferProgress = AutoImportTransferProgress(
      scannedItems = 0,
      queuedItems = 0,
      uploadedItems = 0,
      uploadedBytes = 0,
      totalBytes = null,
    )
  }
}

data class AutoImportTransferState(
  val scheduleId: AutoImportScheduleId,
  val status: AutoImportTransferStatus,
  val progress: AutoImportTransferProgress,
  val cancellationState: AutoImportCancellationState,
  val foregroundNotification: AutoImportForegroundNotificationPolicy?,
  val failureReason: AutoImportTransferFailureReason?,
) {
  init {
    require((status == AutoImportTransferStatus.CANCELLATION_REQUESTED) == (cancellationState == AutoImportCancellationState.REQUESTED)) {
      "cancellation-requested transfers must carry requested cancellation state"
    }
    require((status == AutoImportTransferStatus.CANCELLED) == (cancellationState == AutoImportCancellationState.CANCELLED)) {
      "cancelled transfers must carry cancelled cancellation state"
    }
    require(status != AutoImportTransferStatus.RUNNING || foregroundNotification != null) {
      "running auto-import transfers require foreground notification policy"
    }
    require(status == AutoImportTransferStatus.RUNNING ||
      status == AutoImportTransferStatus.CANCELLATION_REQUESTED ||
      foregroundNotification == null
    ) {
      "only active auto-import transfers can hold foreground notification policy"
    }
    require((status == AutoImportTransferStatus.FAILED) == (failureReason != null)) {
      "failed auto-import transfers require a failure reason; non-failed transfers must not include one"
    }
  }

  fun markRunning(): AutoImportTransferState {
    require(status == AutoImportTransferStatus.SCHEDULED || status == AutoImportTransferStatus.PAUSED_WAITING_FOR_CONSTRAINTS) {
      "only scheduled or paused auto-import transfers can become running"
    }
    return copy(
      status = AutoImportTransferStatus.RUNNING,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = AutoImportForegroundNotificationPolicy.dataSync(),
      failureReason = null,
    )
  }

  fun withProgress(progress: AutoImportTransferProgress): AutoImportTransferState {
    require(status == AutoImportTransferStatus.RUNNING || status == AutoImportTransferStatus.CANCELLATION_REQUESTED) {
      "only active auto-import transfers can accept progress updates"
    }
    return copy(progress = progress)
  }

  fun requestCancellation(): AutoImportTransferState {
    require(
      status == AutoImportTransferStatus.RUNNING ||
        status == AutoImportTransferStatus.SCHEDULED ||
        status == AutoImportTransferStatus.PAUSED_WAITING_FOR_CONSTRAINTS,
    ) {
      "only scheduled, running, or paused auto-import transfers can request cancellation"
    }
    return copy(
      status = AutoImportTransferStatus.CANCELLATION_REQUESTED,
      cancellationState = AutoImportCancellationState.REQUESTED,
      foregroundNotification = if (status == AutoImportTransferStatus.RUNNING) foregroundNotification else null,
    )
  }

  fun markCancelled(): AutoImportTransferState {
    require(status == AutoImportTransferStatus.CANCELLATION_REQUESTED) {
      "only cancellation-requested auto-import transfers can become cancelled"
    }
    return copy(
      status = AutoImportTransferStatus.CANCELLED,
      cancellationState = AutoImportCancellationState.CANCELLED,
      foregroundNotification = null,
      failureReason = null,
    )
  }

  fun markPausedWaitingForConstraints(): AutoImportTransferState {
    require(status == AutoImportTransferStatus.RUNNING || status == AutoImportTransferStatus.SCHEDULED) {
      "only scheduled or running auto-import transfers can pause for constraints"
    }
    return copy(
      status = AutoImportTransferStatus.PAUSED_WAITING_FOR_CONSTRAINTS,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = null,
      failureReason = null,
    )
  }

  fun markCompleted(): AutoImportTransferState {
    require(status == AutoImportTransferStatus.RUNNING) {
      "only running auto-import transfers can complete"
    }
    return copy(
      status = AutoImportTransferStatus.COMPLETED,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = null,
      failureReason = null,
    )
  }

  fun markFailed(reason: AutoImportTransferFailureReason): AutoImportTransferState {
    require(status != AutoImportTransferStatus.COMPLETED && status != AutoImportTransferStatus.CANCELLED) {
      "completed or cancelled auto-import transfers cannot fail"
    }
    return copy(
      status = AutoImportTransferStatus.FAILED,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = null,
      failureReason = reason,
    )
  }

  fun resume(): AutoImportTransferState {
    require(status == AutoImportTransferStatus.CANCELLED || status == AutoImportTransferStatus.PAUSED_WAITING_FOR_CONSTRAINTS) {
      "only cancelled or paused auto-import transfers can be explicitly resumed"
    }
    return copy(
      status = AutoImportTransferStatus.SCHEDULED,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = null,
      failureReason = null,
    )
  }

  fun foregroundPolicyViolations(): List<String> =
    if (status == AutoImportTransferStatus.RUNNING ||
      (status == AutoImportTransferStatus.CANCELLATION_REQUESTED && foregroundNotification != null)
    ) {
      foregroundNotification?.violationsForLongRunningTransfer()
        ?: AutoImportForegroundNotificationPolicy(
          required = false,
          serviceType = ForegroundServiceType.NONE,
          userVisible = false,
        ).violationsForLongRunningTransfer()
    } else {
      emptyList()
    }

  override fun toString(): String =
    "AutoImportTransferState(scheduleId=<redacted>, status=$status, progress=$progress, " +
      "cancellationState=$cancellationState, foregroundNotification=$foregroundNotification, failureReason=$failureReason)"

  companion object {
    fun scheduled(scheduleId: AutoImportScheduleId): AutoImportTransferState = AutoImportTransferState(
      scheduleId = scheduleId,
      status = AutoImportTransferStatus.SCHEDULED,
      progress = AutoImportTransferProgress.empty(),
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = null,
      failureReason = null,
    )

    fun running(
      scheduleId: AutoImportScheduleId,
      progress: AutoImportTransferProgress = AutoImportTransferProgress.empty(),
    ): AutoImportTransferState = AutoImportTransferState(
      scheduleId = scheduleId,
      status = AutoImportTransferStatus.RUNNING,
      progress = progress,
      cancellationState = AutoImportCancellationState.NONE,
      foregroundNotification = AutoImportForegroundNotificationPolicy.dataSync(),
      failureReason = null,
    )
  }
}
