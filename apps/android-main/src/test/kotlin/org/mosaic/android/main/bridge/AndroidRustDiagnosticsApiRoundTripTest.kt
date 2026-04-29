package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue

class AndroidRustDiagnosticsApiRoundTripTest {

  @Test
  fun protocolVersionMatchesShellExpectation() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustDiagnosticsApi()
    assertEquals("mosaic-v1", api.protocolVersion())
  }

  @Test
  fun goldenVectorIsDeterministic() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustDiagnosticsApi()
    val first = api.cryptoDomainGoldenVectorSnapshot()
    val second = api.cryptoDomainGoldenVectorSnapshot()
    assertEquals(first.code, second.code)
    assertEquals(first.envelopeEpochId, second.envelopeEpochId)
    assertEquals(first.envelopeShardIndex, second.envelopeShardIndex)
    assertEquals(first.envelopeTier, second.envelopeTier)
    assertTrue("golden envelope header bytes deterministic", first.envelopeHeader.contentEquals(second.envelopeHeader))
    assertTrue("golden nonce deterministic", first.envelopeNonce.contentEquals(second.envelopeNonce))
    assertTrue("golden manifest transcript deterministic", first.manifestTranscript.contentEquals(second.manifestTranscript))
    assertTrue("golden signing pubkey deterministic", first.identitySigningPubkey.contentEquals(second.identitySigningPubkey))
    assertTrue("golden encryption pubkey deterministic", first.identityEncryptionPubkey.contentEquals(second.identityEncryptionPubkey))
    assertTrue("golden signature deterministic", first.identitySignature.contentEquals(second.identitySignature))
  }

  @Test
  fun goldenVectorEnvelopeHeaderIsExpectedLength() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustDiagnosticsApi()
    val snapshot = api.cryptoDomainGoldenVectorSnapshot()
    // Shard envelope header is fixed at 64 bytes per the Mosaic protocol.
    assertEquals(64, snapshot.envelopeHeader.size)
    // Nonce is 24 bytes (XChaCha20).
    assertEquals(24, snapshot.envelopeNonce.size)
    // Ed25519 pubkey = 32 bytes; X25519 pubkey = 32 bytes; signature = 64 bytes.
    assertEquals(32, snapshot.identitySigningPubkey.size)
    assertEquals(32, snapshot.identityEncryptionPubkey.size)
    assertEquals(64, snapshot.identitySignature.size)
  }

  @Test
  fun stateMachineSnapshotDescriptorContainsBothMachines() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustDiagnosticsApi()
    val descriptor = api.clientCoreStateMachineSnapshot()
    assertNotNull(descriptor)
    assertTrue("descriptor non-blank", descriptor.isNotBlank())
    assertTrue("descriptor mentions upload state machine", descriptor.contains("upload"))
    assertTrue("descriptor mentions sync state machine", descriptor.contains("sync"))
    assertTrue("descriptor declares state-machine version", descriptor.contains("client-core-state-machines:"))
  }
}
