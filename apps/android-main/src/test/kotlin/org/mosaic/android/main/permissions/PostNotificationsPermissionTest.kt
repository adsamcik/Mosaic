package org.mosaic.android.main.permissions

import android.Manifest
import android.app.Application
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Verifies the [PostNotificationsPermission.shouldRequest] decision matrix:
 *
 *   API < 33                -> false (permission is install-time)
 *   API 33+, not granted    -> true  (must runtime-request)
 *   API 33+, granted        -> false (no-op)
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
class PostNotificationsPermissionTest {
  private val context: Application = ApplicationProvider.getApplicationContext()

  @After
  fun resetPermissionGrants() {
    shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
  }

  @Test
  fun returnsFalseOnApiBelowTiramisu() {
    // API 32 (Android 12L) — permission is granted at install time so there
    // is nothing to runtime-request.
    assertFalse(
      "POST_NOTIFICATIONS must not be runtime-requested on API < 33",
      PostNotificationsPermission.shouldRequest(context, sdkInt = Build.VERSION_CODES.S_V2),
    )
  }

  @Test
  fun returnsFalseOnApi26Baseline() {
    // The module's `minSdk` is 26 — the lowest supported runtime. Ensure
    // even older devices in the supported range short-circuit cleanly.
    assertFalse(
      "POST_NOTIFICATIONS must not be runtime-requested at minSdk = 26",
      PostNotificationsPermission.shouldRequest(context, sdkInt = Build.VERSION_CODES.O),
    )
  }

  @Test
  fun returnsTrueOnTiramisuWhenPermissionMissing() {
    shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(
      "API 33+ without the granted permission must runtime-request",
      PostNotificationsPermission.shouldRequest(context, sdkInt = Build.VERSION_CODES.TIRAMISU),
    )
  }

  @Test
  fun returnsTrueOnApi34WhenPermissionMissing() {
    // Spot-check API 34 (UPSIDE_DOWN_CAKE) so the predicate is not pinned
    // to a single API level.
    shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(
      "API 34 without the granted permission must runtime-request",
      PostNotificationsPermission.shouldRequest(context, sdkInt = Build.VERSION_CODES.UPSIDE_DOWN_CAKE),
    )
  }

  @Test
  fun returnsFalseOnTiramisuWhenPermissionAlreadyGranted() {
    shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertFalse(
      "API 33+ with the granted permission must not re-request",
      PostNotificationsPermission.shouldRequest(context, sdkInt = Build.VERSION_CODES.TIRAMISU),
    )
  }
}
