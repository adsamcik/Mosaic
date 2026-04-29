package org.mosaic.android.main

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.foundation.AccountKeyHandle
import org.mosaic.android.foundation.AccountUnlockCode
import org.mosaic.android.foundation.AccountUnlockRequest
import org.mosaic.android.foundation.GeneratedRustAccountBridge
import org.mosaic.android.foundation.HeaderParseCode
import org.mosaic.android.foundation.KdfProfile
import org.mosaic.android.foundation.unlockAccountAndWipePassword
import org.mosaic.android.main.bridge.AndroidRustAccountApi
import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import org.mosaic.android.main.bridge.AndroidRustDiagnosticsApi
import org.mosaic.android.main.bridge.AndroidRustHeaderApi

/**
 * Instrumented smoke test that proves the Rust↔Kotlin↔Android FFI is wired end-to-end
 * on a real Android device. Runs against a real `libmosaic_uniffi.so` packaged in the
 * test APK. No network. No persistent state. No user data.
 */
@RunWith(AndroidJUnit4::class)
class RustCoreSmokeTest {

  @Test
  fun libraryLoaderInitializesWithoutError() {
    // Calling warmUp() should successfully load the native library. If the .so is
    // missing or the symbol table doesn't match, this will throw before any other
    // FFI call has a chance to. We catch and rethrow with a clearer message.
    try {
      AndroidRustCoreLibraryLoader.warmUp()
      AndroidRustCoreLibraryLoader.warmUp() // idempotency check
    } catch (error: Throwable) {
      throw AssertionError("Rust core library failed to initialize: ${error.message}", error)
    }
  }

  @Test
  fun protocolVersionMatchesShellExpectation() {
    val version = AndroidRustDiagnosticsApi().protocolVersion()
    assertEquals("mosaic-v1", version)
  }

  @Test
  fun unlockAccountKeyRejectsWeakKdfProfile() {
    val bridge = GeneratedRustAccountBridge(AndroidRustAccountApi())
    val password = "mosaic-instrumented-smoke".toByteArray(Charsets.UTF_8)
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
    // Password buffer is wiped after the call.
    assertTrue("password should be wiped after unlock", password.all { it == 0.toByte() })
    // Defensive: if some future change makes this synthetic input succeed, close the handle.
    val handle: AccountKeyHandle? = result.handle
    if (handle != null) bridge.closeAccountKeyHandle(handle)
  }

  @Test
  fun parseEnvelopeHeaderRejectsTooShortBytes() {
    val bridge = AndroidRustHeaderApi()
    val result = bridge.parseEnvelopeHeader(ByteArray(8))
    assertNotEquals(0, result.code)
  }

  @Test
  fun goldenVectorSnapshotReturnsDeterministicBytes() {
    val bridge = AndroidRustDiagnosticsApi()
    val first = bridge.cryptoDomainGoldenVectorSnapshot()
    val second = bridge.cryptoDomainGoldenVectorSnapshot()
    assertEquals(first.code, second.code)
    assertEquals(first.envelopeEpochId, second.envelopeEpochId)
    assertEquals(first.envelopeShardIndex, second.envelopeShardIndex)
    assertEquals(first.envelopeTier, second.envelopeTier)
    assertTrue(first.envelopeHeader.contentEquals(second.envelopeHeader))
    assertTrue(first.envelopeNonce.contentEquals(second.envelopeNonce))
    assertTrue(first.identitySigningPubkey.contentEquals(second.identitySigningPubkey))
    assertTrue(first.identitySignature.contentEquals(second.identitySignature))
    assertNotNull(first.manifestTranscript)
  }

  @Test
  fun stateMachineSnapshotDescriptorIsNonBlank() {
    val descriptor = AndroidRustDiagnosticsApi().clientCoreStateMachineSnapshot()
    assertTrue("descriptor is non-blank", descriptor.isNotBlank())
    assertTrue(
      "descriptor includes upload + sync state machine fingerprint",
      descriptor.contains("upload") && descriptor.contains("sync"),
    )
  }
}
