package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustDiagnosticsApi
import org.mosaic.android.foundation.RustDiagnosticsGoldenVectorFfi
import uniffi.mosaic_uniffi.clientCoreStateMachineSnapshot as rustClientCoreStateMachineSnapshot
import uniffi.mosaic_uniffi.cryptoDomainGoldenVectorSnapshot as rustCryptoDomainGoldenVectorSnapshot
import uniffi.mosaic_uniffi.protocolVersion as rustProtocolVersion

/**
 * Real implementation of [GeneratedRustDiagnosticsApi] backed by the Rust UniFFI core.
 * Returns protocol metadata, deterministic golden vectors, and state-machine
 * descriptors. Outputs never carry plaintext media, passwords, raw keys, or
 * user-identifying material.
 */
class AndroidRustDiagnosticsApi : GeneratedRustDiagnosticsApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun protocolVersion(): String = rustProtocolVersion()

  override fun cryptoDomainGoldenVectorSnapshot(): RustDiagnosticsGoldenVectorFfi {
    val snapshot = rustCryptoDomainGoldenVectorSnapshot()
    return RustDiagnosticsGoldenVectorFfi(
      code = snapshot.code.toInt(),
      envelopeHeader = snapshot.envelopeHeader,
      envelopeEpochId = snapshot.envelopeEpochId.toInt(),
      envelopeShardIndex = snapshot.envelopeShardIndex.toInt(),
      envelopeTier = snapshot.envelopeTier.toInt(),
      envelopeNonce = snapshot.envelopeNonce,
      manifestTranscript = snapshot.manifestTranscript,
      identityMessage = snapshot.identityMessage,
      identitySigningPubkey = snapshot.identitySigningPubkey,
      identityEncryptionPubkey = snapshot.identityEncryptionPubkey,
      identitySignature = snapshot.identitySignature,
    )
  }

  override fun clientCoreStateMachineSnapshot(): String = rustClientCoreStateMachineSnapshot()
}
