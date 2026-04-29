package org.mosaic.android.foundation

/**
 * Diagnostics surface exposed by the Rust core for cross-platform parity proofs and
 * state-machine introspection. NOT for production photo flows. Used by:
 *   - cross-client contract fixtures to verify Rust is the canonical source of truth;
 *   - state-machine reducer audits;
 *   - dev-mode UI that shows protocol version and core readiness.
 *
 * Outputs are protocol metadata, golden vectors, and state-machine descriptors. They
 * never carry plaintext media, passwords, raw keys, or user-identifying material.
 */
interface RustDiagnosticsBridge {
  fun protocolVersion(): String

  fun cryptoDomainGoldenVector(): CryptoDomainGoldenVectorSnapshot

  fun clientCoreStateMachineSnapshot(): String
}

class CryptoDomainGoldenVectorSnapshot(
  val code: Int,
  envelopeHeader: ByteArray,
  val envelopeEpochId: Int,
  val envelopeShardIndex: Int,
  val envelopeTier: Int,
  envelopeNonce: ByteArray,
  manifestTranscript: ByteArray,
  identityMessage: ByteArray,
  identitySigningPubkey: ByteArray,
  identityEncryptionPubkey: ByteArray,
  identitySignature: ByteArray,
) {
  init {
    require(code >= 0) { "diagnostics code must not be negative" }
    require(envelopeEpochId >= 0) { "envelope epoch id must not be negative" }
    require(envelopeShardIndex >= 0) { "envelope shard index must not be negative" }
    require(envelopeTier >= 0) { "envelope tier must not be negative" }
  }

  private val envelopeHeaderBytes: ByteArray = envelopeHeader.copyOf()
  private val envelopeNonceBytes: ByteArray = envelopeNonce.copyOf()
  private val manifestTranscriptBytes: ByteArray = manifestTranscript.copyOf()
  private val identityMessageBytes: ByteArray = identityMessage.copyOf()
  private val identitySigningPubkeyBytes: ByteArray = identitySigningPubkey.copyOf()
  private val identityEncryptionPubkeyBytes: ByteArray = identityEncryptionPubkey.copyOf()
  private val identitySignatureBytes: ByteArray = identitySignature.copyOf()

  val envelopeHeader: ByteArray
    get() = envelopeHeaderBytes.copyOf()

  val envelopeNonce: ByteArray
    get() = envelopeNonceBytes.copyOf()

  val manifestTranscript: ByteArray
    get() = manifestTranscriptBytes.copyOf()

  val identityMessage: ByteArray
    get() = identityMessageBytes.copyOf()

  val identitySigningPubkey: ByteArray
    get() = identitySigningPubkeyBytes.copyOf()

  val identityEncryptionPubkey: ByteArray
    get() = identityEncryptionPubkeyBytes.copyOf()

  val identitySignature: ByteArray
    get() = identitySignatureBytes.copyOf()

  override fun toString(): String =
    "CryptoDomainGoldenVectorSnapshot(code=$code, envelopeEpochId=$envelopeEpochId, " +
      "envelopeShardIndex=$envelopeShardIndex, envelopeTier=$envelopeTier, " +
      "envelopeHeader=<opaque>, envelopeNonce=<opaque>, manifestTranscript=<opaque>, " +
      "identityMessage=<opaque>, identitySigningPubkey=<opaque>, identityEncryptionPubkey=<opaque>, " +
      "identitySignature=<opaque>)"
}

data class RustDiagnosticsGoldenVectorFfi(
  val code: Int,
  val envelopeHeader: ByteArray,
  val envelopeEpochId: Int,
  val envelopeShardIndex: Int,
  val envelopeTier: Int,
  val envelopeNonce: ByteArray,
  val manifestTranscript: ByteArray,
  val identityMessage: ByteArray,
  val identitySigningPubkey: ByteArray,
  val identityEncryptionPubkey: ByteArray,
  val identitySignature: ByteArray,
) {
  init {
    require(code >= 0) { "diagnostics code must not be negative" }
  }

  fun wipe() {
    envelopeHeader.fill(0)
    envelopeNonce.fill(0)
    manifestTranscript.fill(0)
    identityMessage.fill(0)
    identitySigningPubkey.fill(0)
    identityEncryptionPubkey.fill(0)
    identitySignature.fill(0)
  }

  override fun toString(): String =
    "RustDiagnosticsGoldenVectorFfi(code=$code, envelopeEpochId=$envelopeEpochId, " +
      "envelopeShardIndex=$envelopeShardIndex, envelopeTier=$envelopeTier, ...=<opaque>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustDiagnosticsGoldenVectorFfi) return false
    return code == other.code &&
      envelopeEpochId == other.envelopeEpochId &&
      envelopeShardIndex == other.envelopeShardIndex &&
      envelopeTier == other.envelopeTier &&
      envelopeHeader.contentEquals(other.envelopeHeader) &&
      envelopeNonce.contentEquals(other.envelopeNonce) &&
      manifestTranscript.contentEquals(other.manifestTranscript) &&
      identityMessage.contentEquals(other.identityMessage) &&
      identitySigningPubkey.contentEquals(other.identitySigningPubkey) &&
      identityEncryptionPubkey.contentEquals(other.identityEncryptionPubkey) &&
      identitySignature.contentEquals(other.identitySignature)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + envelopeEpochId
    result = 31 * result + envelopeShardIndex
    result = 31 * result + envelopeTier
    result = 31 * result + envelopeHeader.contentHashCode()
    result = 31 * result + envelopeNonce.contentHashCode()
    result = 31 * result + manifestTranscript.contentHashCode()
    result = 31 * result + identityMessage.contentHashCode()
    result = 31 * result + identitySigningPubkey.contentHashCode()
    result = 31 * result + identityEncryptionPubkey.contentHashCode()
    result = 31 * result + identitySignature.contentHashCode()
    return result
  }
}

interface GeneratedRustDiagnosticsApi {
  fun protocolVersion(): String

  fun cryptoDomainGoldenVectorSnapshot(): RustDiagnosticsGoldenVectorFfi

  fun clientCoreStateMachineSnapshot(): String
}

class GeneratedRustDiagnosticsBridge(
  private val api: GeneratedRustDiagnosticsApi,
) : RustDiagnosticsBridge {
  override fun protocolVersion(): String {
    val version = api.protocolVersion()
    require(version.isNotBlank()) { "Rust protocol version is required" }
    return version
  }

  override fun cryptoDomainGoldenVector(): CryptoDomainGoldenVectorSnapshot {
    val ffi = api.cryptoDomainGoldenVectorSnapshot()
    return try {
      CryptoDomainGoldenVectorSnapshot(
        code = ffi.code,
        envelopeHeader = ffi.envelopeHeader,
        envelopeEpochId = ffi.envelopeEpochId,
        envelopeShardIndex = ffi.envelopeShardIndex,
        envelopeTier = ffi.envelopeTier,
        envelopeNonce = ffi.envelopeNonce,
        manifestTranscript = ffi.manifestTranscript,
        identityMessage = ffi.identityMessage,
        identitySigningPubkey = ffi.identitySigningPubkey,
        identityEncryptionPubkey = ffi.identityEncryptionPubkey,
        identitySignature = ffi.identitySignature,
      )
    } finally {
      ffi.wipe()
    }
  }

  override fun clientCoreStateMachineSnapshot(): String {
    val descriptor = api.clientCoreStateMachineSnapshot()
    require(descriptor.isNotBlank()) { "client-core state machine descriptor is required" }
    return descriptor
  }
}
