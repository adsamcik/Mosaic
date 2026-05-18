package org.mosaic.android.main.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Helpers for the runtime POST_NOTIFICATIONS permission added in Android 13
 * (API 33, `TIRAMISU`).
 *
 * The permission is declared in `AndroidManifest.xml` because the auto-import
 * foreground worker (`AutoImportWorker`) and the expedited shard workers
 * (`ShardEncryptionWorker`, `ShardUploadWorker`) post user-visible
 * notifications. On API 33+ notifications are silently dropped unless the
 * user has granted the runtime permission, so the launcher activity asks for
 * it on first start. On API <= 32 the permission is granted at install time
 * and there is nothing to do.
 *
 * No user-identifying material is read or logged by this module — only the
 * SDK version of the running device and the static permission grant state.
 */
object PostNotificationsPermission {
  const val NAME: String = Manifest.permission.POST_NOTIFICATIONS

  /**
   * Returns `true` when the activity should issue a runtime POST_NOTIFICATIONS
   * request, i.e. the device is API 33+ AND the permission is not already
   * granted. On API <= 32 this is always `false`.
   */
  fun shouldRequest(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): Boolean {
    if (sdkInt < Build.VERSION_CODES.TIRAMISU) return false
    return ContextCompat.checkSelfPermission(context, NAME) != PackageManager.PERMISSION_GRANTED
  }
}
