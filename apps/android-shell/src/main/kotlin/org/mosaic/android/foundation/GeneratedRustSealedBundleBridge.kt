package org.mosaic.android.foundation

/**
 * Slice 0C — sealed-bundle verify-and-open with raw recipient seed.
 *
 * Drives the cross-client `tests/vectors/sealed_bundle.json` corpus test.
 * Production code paths must use the handle-based
 * `verify_and_open_bundle_with_identity_handle`; this bridge takes a raw
 * 32-byte recipient identity seed and is exclusively for the cross-client
 * differential corpus.
 *
 * `epoch_seed` returned in the result is secret-equivalent — Kotlin
 * callers MUST wipe the byte array after use.
 */
object RustSealedBundleStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_SIGNATURE_LENGTH: Int = 211
  const val INVALID_PUBLIC_KEY: Int = 212
  const val BUNDLE_SIGNATURE_INVALID: Int = 216
  const val BUNDLE_ALBUM_ID_EMPTY: Int = 217
  const val BUNDLE_ALBUM_ID_MISMATCH: Int = 218
  const val BUNDLE_EPOCH_TOO_OLD: Int = 219
  const val BUNDLE_RECIPIENT_MISMATCH: Int = 220
  const val BUNDLE_JSON_PARSE: Int = 221
  const val BUNDLE_SEAL_OPEN_FAILED: Int = 222
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class OpenedBundleCode {
  SUCCESS,
  INVALID_KEY_LENGTH,
  INVALID_SIGNATURE_LENGTH,
  INVALID_PUBLIC_KEY,
  BUNDLE_SIGNATURE_INVALID,
  BUNDLE_ALBUM_ID_EMPTY,
  BUNDLE_ALBUM_ID_MISMATCH,
  BUNDLE_EPOCH_TOO_OLD,
  BUNDLE_RECIPIENT_MISMATCH,
  BUNDLE_JSON_PARSE,
  BUNDLE_SEAL_OPEN_FAILED,
  INTERNAL_ERROR,
}

class OpenedBundleResult(
  val code: OpenedBundleCode,
  val version: Int,
  val albumId: String,
  val epochId: Int,
  recipientPubkey: ByteArray,
  val epochHandleId: ULong,
  signPublicKey: ByteArray,
) {
  init {
    val allFieldsPresent = recipientPubkey.isNotEmpty() && epochHandleId != 0UL && signPublicKey.isNotEmpty()
    require((code == OpenedBundleCode.SUCCESS) == allFieldsPresent) {
      "successful bundle opens must include all key fields and a non-zero epoch_handle_id; failures must include none"
    }
    if (code == OpenedBundleCode.SUCCESS) {
      require(version >= 0) { "bundle version must not be negative" }
      require(epochId >= 0) { "bundle epoch_id must not be negative" }
      require(recipientPubkey.size == 32) { "recipient_pubkey must be exactly 32 bytes" }
      require(signPublicKey.size == 32) { "sign_public_key must be exactly 32 bytes" }
    }
  }

  private val recipientPubkeyBytes: ByteArray = recipientPubkey.copyOf()
  private val signPublicKeyBytes: ByteArray = signPublicKey.copyOf()

  val recipientPubkey: ByteArray
    get() = recipientPubkeyBytes.copyOf()

  val signPublicKey: ByteArray
    get() = signPublicKeyBytes.copyOf()

  fun wipe() {
    recipientPubkeyBytes.fill(0)
    signPublicKeyBytes.fill(0)
  }

  override fun toString(): String =
    "OpenedBundleResult(code=$code, version=$version, albumId=<redacted-${albumId.length}-chars>, epochId=$epochId, recipientPubkey=<redacted-${recipientPubkeyBytes.size}-bytes>, epochHandleId=<redacted>, signPublicKey=<redacted-${signPublicKeyBytes.size}-bytes>)"
}

interface RustSealedBundleBridge {
  @Suppress("LongParameterList")
  fun verifyAndOpen(
    recipientIdentitySeed: ByteArray,
    sealed: ByteArray,
    signature: ByteArray,
    sharerPubkey: ByteArray,
    expectedOwnerPubkey: ByteArray,
    expectedAlbumId: String,
    expectedMinEpochId: Int,
    allowLegacyEmptyAlbumId: Boolean,
  ): OpenedBundleResult
}

data class RustOpenedBundleFfiResult(
  val code: Int,
  val version: Int,
  val albumId: String,
  val epochId: Int,
  val recipientPubkey: ByteArray,
  val epochHandleId: ULong,
  val signPublicKey: ByteArray,
) {
  init {
    require(code >= 0) { "opened-bundle code must not be negative" }
    require(version >= 0) { "version must not be negative" }
    require(epochId >= 0) { "epoch_id must not be negative" }
  }

  fun wipe() {
    recipientPubkey.fill(0)
    signPublicKey.fill(0)
  }

  override fun toString(): String =
    "RustOpenedBundleFfiResult(code=$code, version=$version, albumId=<redacted-${albumId.length}-chars>, epochId=$epochId, recipientPubkey=<redacted-${recipientPubkey.size}-bytes>, epochHandleId=<redacted>, signPublicKey=<redacted-${signPublicKey.size}-bytes>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustOpenedBundleFfiResult) return false
    return code == other.code &&
      version == other.version &&
      albumId == other.albumId &&
      epochId == other.epochId &&
      recipientPubkey.contentEquals(other.recipientPubkey) &&
      epochHandleId == other.epochHandleId &&
      signPublicKey.contentEquals(other.signPublicKey)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + version
    result = 31 * result + albumId.hashCode()
    result = 31 * result + epochId
    result = 31 * result + recipientPubkey.contentHashCode()
    result = 31 * result + epochHandleId.hashCode()
    result = 31 * result + signPublicKey.contentHashCode()
    return result
  }
}

interface GeneratedRustSealedBundleApi {
  @Suppress("LongParameterList")
  fun verifyAndOpenBundleWithRecipientSeed(
    recipientIdentitySeed: ByteArray,
    sealed: ByteArray,
    signature: ByteArray,
    sharerPubkey: ByteArray,
    expectedOwnerPubkey: ByteArray,
    expectedAlbumId: String,
    expectedMinEpochId: Int,
    allowLegacyEmptyAlbumId: Boolean,
  ): RustOpenedBundleFfiResult
}

class GeneratedRustSealedBundleBridge(
  private val api: GeneratedRustSealedBundleApi,
) : RustSealedBundleBridge {
  override fun verifyAndOpen(
    recipientIdentitySeed: ByteArray,
    sealed: ByteArray,
    signature: ByteArray,
    sharerPubkey: ByteArray,
    expectedOwnerPubkey: ByteArray,
    expectedAlbumId: String,
    expectedMinEpochId: Int,
    allowLegacyEmptyAlbumId: Boolean,
  ): OpenedBundleResult {
    require(expectedMinEpochId >= 0) { "expectedMinEpochId must not be negative" }
    val result = api.verifyAndOpenBundleWithRecipientSeed(
      recipientIdentitySeed,
      sealed,
      signature,
      sharerPubkey,
      expectedOwnerPubkey,
      expectedAlbumId,
      expectedMinEpochId,
      allowLegacyEmptyAlbumId,
    )
    return try {
      val code = when (result.code) {
        RustSealedBundleStableCode.OK -> OpenedBundleCode.SUCCESS
        RustSealedBundleStableCode.INVALID_KEY_LENGTH -> OpenedBundleCode.INVALID_KEY_LENGTH
        RustSealedBundleStableCode.INVALID_SIGNATURE_LENGTH -> OpenedBundleCode.INVALID_SIGNATURE_LENGTH
        RustSealedBundleStableCode.INVALID_PUBLIC_KEY -> OpenedBundleCode.INVALID_PUBLIC_KEY
        RustSealedBundleStableCode.BUNDLE_SIGNATURE_INVALID -> OpenedBundleCode.BUNDLE_SIGNATURE_INVALID
        RustSealedBundleStableCode.BUNDLE_ALBUM_ID_EMPTY -> OpenedBundleCode.BUNDLE_ALBUM_ID_EMPTY
        RustSealedBundleStableCode.BUNDLE_ALBUM_ID_MISMATCH -> OpenedBundleCode.BUNDLE_ALBUM_ID_MISMATCH
        RustSealedBundleStableCode.BUNDLE_EPOCH_TOO_OLD -> OpenedBundleCode.BUNDLE_EPOCH_TOO_OLD
        RustSealedBundleStableCode.BUNDLE_RECIPIENT_MISMATCH -> OpenedBundleCode.BUNDLE_RECIPIENT_MISMATCH
        RustSealedBundleStableCode.BUNDLE_JSON_PARSE -> OpenedBundleCode.BUNDLE_JSON_PARSE
        RustSealedBundleStableCode.BUNDLE_SEAL_OPEN_FAILED -> OpenedBundleCode.BUNDLE_SEAL_OPEN_FAILED
        else -> OpenedBundleCode.INTERNAL_ERROR
      }
      if (code == OpenedBundleCode.SUCCESS) {
        OpenedBundleResult(
          code,
          version = result.version,
          albumId = result.albumId,
          epochId = result.epochId,
          recipientPubkey = result.recipientPubkey,
          epochHandleId = result.epochHandleId,
          signPublicKey = result.signPublicKey,
        )
      } else {
        OpenedBundleResult(
          code,
          version = 0,
          albumId = "",
          epochId = 0,
          recipientPubkey = ByteArray(0),
          epochHandleId = 0UL,
          signPublicKey = ByteArray(0),
        )
      }
    } finally {
      result.wipe()
    }
  }
}
