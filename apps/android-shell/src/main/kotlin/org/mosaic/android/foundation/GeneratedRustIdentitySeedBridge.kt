package org.mosaic.android.foundation

/**
 * Slice 0C — raw-seed identity derivation bridge.
 *
 * Drives the cross-client `tests/vectors/identity.json` byte-equality
 * test. Production code paths must use the handle-based identity bridge,
 * not this raw-seed bridge.
 */
object RustIdentitySeedStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class IdentityFromSeedCode {
  SUCCESS,
  INVALID_KEY_LENGTH,
  INTERNAL_ERROR,
}

class IdentityFromSeedResult(
  val code: IdentityFromSeedCode,
  signingPubkey: ByteArray,
  encryptionPubkey: ByteArray,
  signature: ByteArray,
) {
  init {
    val allPresent = signingPubkey.isNotEmpty() && encryptionPubkey.isNotEmpty() && signature.isNotEmpty()
    require((code == IdentityFromSeedCode.SUCCESS) == allPresent) {
      "successful identity derivation must include signing+encryption pubkeys and signature; failures must include none"
    }
    if (code == IdentityFromSeedCode.SUCCESS) {
      require(signingPubkey.size == ED25519_PUBLIC_KEY_BYTES) { "signing_pubkey must be exactly $ED25519_PUBLIC_KEY_BYTES bytes" }
      require(encryptionPubkey.size == X25519_PUBLIC_KEY_BYTES) { "encryption_pubkey must be exactly $X25519_PUBLIC_KEY_BYTES bytes" }
      require(signature.size == ED25519_SIGNATURE_BYTES) { "signature must be exactly $ED25519_SIGNATURE_BYTES bytes" }
    }
  }

  private val signingPubkeyBytes: ByteArray = signingPubkey.copyOf()
  private val encryptionPubkeyBytes: ByteArray = encryptionPubkey.copyOf()
  private val signatureBytes: ByteArray = signature.copyOf()

  val signingPubkey: ByteArray
    get() = signingPubkeyBytes.copyOf()

  val encryptionPubkey: ByteArray
    get() = encryptionPubkeyBytes.copyOf()

  val signature: ByteArray
    get() = signatureBytes.copyOf()

  override fun toString(): String =
    "IdentityFromSeedResult(code=$code, signingPubkey=<redacted-${signingPubkeyBytes.size}-bytes>, encryptionPubkey=<redacted-${encryptionPubkeyBytes.size}-bytes>, signature=<redacted-${signatureBytes.size}-bytes>)"

  companion object {
    const val ED25519_PUBLIC_KEY_BYTES: Int = 32
    const val X25519_PUBLIC_KEY_BYTES: Int = 32
    const val ED25519_SIGNATURE_BYTES: Int = 64
  }
}

interface RustIdentitySeedBridge {
  fun deriveFromSeed(identitySeed: ByteArray, message: ByteArray): IdentityFromSeedResult
}

data class RustIdentitySeedFfiResult(
  val code: Int,
  val signingPubkey: ByteArray,
  val encryptionPubkey: ByteArray,
  val signature: ByteArray,
) {
  init {
    require(code >= 0) { "identity-from-seed code must not be negative" }
  }

  fun wipe() {
    signingPubkey.fill(0)
    encryptionPubkey.fill(0)
    signature.fill(0)
  }

  override fun toString(): String =
    "RustIdentitySeedFfiResult(code=$code, signingPubkey=<redacted-${signingPubkey.size}-bytes>, encryptionPubkey=<redacted-${encryptionPubkey.size}-bytes>, signature=<redacted-${signature.size}-bytes>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustIdentitySeedFfiResult) return false
    return code == other.code &&
      signingPubkey.contentEquals(other.signingPubkey) &&
      encryptionPubkey.contentEquals(other.encryptionPubkey) &&
      signature.contentEquals(other.signature)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + signingPubkey.contentHashCode()
    result = 31 * result + encryptionPubkey.contentHashCode()
    result = 31 * result + signature.contentHashCode()
    return result
  }
}

interface GeneratedRustIdentitySeedApi {
  fun deriveIdentityFromRawSeed(identitySeed: ByteArray, message: ByteArray): RustIdentitySeedFfiResult
}

class GeneratedRustIdentitySeedBridge(
  private val api: GeneratedRustIdentitySeedApi,
) : RustIdentitySeedBridge {
  override fun deriveFromSeed(identitySeed: ByteArray, message: ByteArray): IdentityFromSeedResult {
    val result = api.deriveIdentityFromRawSeed(identitySeed, message)
    return try {
      val code = when (result.code) {
        RustIdentitySeedStableCode.OK -> IdentityFromSeedCode.SUCCESS
        RustIdentitySeedStableCode.INVALID_KEY_LENGTH -> IdentityFromSeedCode.INVALID_KEY_LENGTH
        else -> IdentityFromSeedCode.INTERNAL_ERROR
      }
      if (code == IdentityFromSeedCode.SUCCESS) {
        IdentityFromSeedResult(
          code,
          signingPubkey = result.signingPubkey,
          encryptionPubkey = result.encryptionPubkey,
          signature = result.signature,
        )
      } else {
        IdentityFromSeedResult(
          code,
          signingPubkey = ByteArray(0),
          encryptionPubkey = ByteArray(0),
          signature = ByteArray(0),
        )
      }
    } finally {
      result.wipe()
    }
  }
}
