package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.AccountKeyHandle
import org.mosaic.android.foundation.AccountUnlockCode
import org.mosaic.android.foundation.AccountUnlockRequest
import org.mosaic.android.foundation.GeneratedRustAccountBridge
import org.mosaic.android.foundation.KdfProfile
import org.mosaic.android.foundation.unlockAccountAndWipePassword

/**
 * Spike: prove that the host-built `mosaic_uniffi` shared library can be
 * loaded through the generated `uniffi.mosaic_uniffi` bindings via the
 * `uniffi.component.mosaic_uniffi.libraryOverride` system property, and
 * exercise one adapter end-to-end.
 *
 * If the override property is unset or the file does not exist, every test
 * is skipped via `assumeTrue` so this suite is safe to run before CI has
 * built the host library.
 */
class AndroidRustAccountApiRoundTripTest {

  @Test
  fun protocolVersionMatchesShellExpectation() {
    assumeTrue(
      "host mosaic_uniffi library not available — set uniffi.component.mosaic_uniffi.libraryOverride",
      NativeLibraryAvailability.isAvailable,
    )

    val api = AndroidRustAccountApi()
    assertEquals("mosaic-v1", api.protocolVersion())
  }

  @Test
  fun unlockAccountKeyRejectsWeakKdfProfile() {
    assumeTrue(
      "host mosaic_uniffi library not available",
      NativeLibraryAvailability.isAvailable,
    )

    val bridge = GeneratedRustAccountBridge(AndroidRustAccountApi())
    val password = "round-trip-smoke-password".toByteArray(Charsets.UTF_8)
    val request = AccountUnlockRequest(
      userSalt = ByteArray(AccountUnlockRequest.SALT_LENGTH),
      accountSalt = ByteArray(AccountUnlockRequest.SALT_LENGTH),
      wrappedAccountKey = ByteArray(64),
      kdfProfile = KdfProfile(memoryKiB = 8, iterations = 1, parallelism = 1),
    )
    val result = bridge.unlockAccountAndWipePassword(password, request)

    // Synthetic inputs MUST NOT yield a successful unlock.
    assertNotEquals(AccountUnlockCode.SUCCESS, result.code)
    assertNull("failed unlocks must not include a handle", result.handle)
    assertTrue("password should be wiped after unlock", password.all { it == 0.toByte() })

    // Defensive: if some future change makes this synthetic input succeed, close the handle.
    val handle: AccountKeyHandle? = result.handle
    if (handle != null) bridge.closeAccountKeyHandle(handle)
  }

  @Test
  fun closeAccountKeyHandleRejectsNonExistentHandle() {
    assumeTrue(
      "host mosaic_uniffi library not available",
      NativeLibraryAvailability.isAvailable,
    )

    val api = AndroidRustAccountApi()
    // Handle 1 is unlikely to exist; any non-existent handle should yield
    // SECRET_HANDLE_NOT_FOUND (400). The exact stable code is what the Rust
    // core returns; we assert it's non-zero (failure).
    val rawCode = api.closeAccountKeyHandle(handle = 0xDEADBEEFL)
    assertNotEquals(0, rawCode)
  }

  @Test
  fun isAccountKeyHandleOpenReportsClosedForInvalidHandle() {
    assumeTrue(
      "host mosaic_uniffi library not available",
      NativeLibraryAvailability.isAvailable,
    )

    val api = AndroidRustAccountApi()
    val status = api.accountKeyHandleIsOpen(0xCAFEBABEL)
    // Either status code reports a missing handle, or isOpen is false.
    assertTrue(
      "non-existent handle should report not-open via either code or flag",
      status.code != 0 || !status.isOpen,
    )
  }
}
