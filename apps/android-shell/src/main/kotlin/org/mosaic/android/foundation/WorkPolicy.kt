package org.mosaic.android.foundation

enum class WorkKind {
  UPLOAD_QUEUE_DRAIN,
}

enum class ForegroundServiceType {
  NONE,
  DATA_SYNC,
}

data class AndroidWorkPolicy(
  val kind: WorkKind,
  val requiresForegroundService: Boolean,
  val foregroundServiceType: ForegroundServiceType,
  val requiresUserVisibleNotification: Boolean,
  val requestsBroadStorageAccess: Boolean,
) {
  fun staticPolicyViolations(): List<String> {
    if (kind != WorkKind.UPLOAD_QUEUE_DRAIN) {
      return emptyList()
    }

    val violations = mutableListOf<String>()
    if (!requiresForegroundService) {
      violations += "upload queue drain must run as foreground work"
    }
    if (foregroundServiceType != ForegroundServiceType.DATA_SYNC) {
      violations += "upload queue drain must declare foregroundServiceType=dataSync"
    }
    if (!requiresUserVisibleNotification) {
      violations += "upload queue drain must show a user-visible notification"
    }
    if (requestsBroadStorageAccess) {
      violations += "upload queue drain must not request broad storage access"
    }
    return violations
  }
}

object AndroidWorkPolicies {
  val uploadDrainPolicy: AndroidWorkPolicy = AndroidWorkPolicy(
    kind = WorkKind.UPLOAD_QUEUE_DRAIN,
    requiresForegroundService = true,
    foregroundServiceType = ForegroundServiceType.DATA_SYNC,
    requiresUserVisibleNotification = true,
    requestsBroadStorageAccess = false,
  )
}
