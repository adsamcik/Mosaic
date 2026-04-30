package org.mosaic.android.foundation

/**
 * Slice 0C — raw-key album content decrypt bridge.
 *
 * Drives the cross-client `tests/vectors/content_encrypt.json` byte-
 * equality test (decrypt direction; encrypt is non-deterministic due to
 * random nonce). Production code paths must use the handle-based
 * `decrypt_album_content_with_epoch_handle`.
 *
 * `plaintext` returned in the result is secret-equivalent — Kotlin
 * callers MUST wipe the byte array after use.
 */
object RustContentDecryptStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val AUTHENTICATION_FAILED: Int = 205
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class ContentDecryptCode {
  SUCCESS,
  INVALID_KEY_LENGTH,
  INVALID_INPUT_LENGTH,
  AUTHENTICATION_FAILED,
  INTERNAL_ERROR,
}

class DecryptedContentResult(
  val code: ContentDecryptCode,
  plaintext: ByteArray,
) {
  init {
    if (code == ContentDecryptCode.SUCCESS) {
      require(plaintext.isNotEmpty() || plaintext.isEmpty()) {
        "successful decrypt always returns plaintext (possibly empty)"
      }
    } else {
      require(plaintext.isEmpty()) { "non-success decrypt must not include plaintext" }
    }
  }

  private val plaintextBytes: ByteArray = plaintext.copyOf()

  val plaintext: ByteArray
    get() = plaintextBytes.copyOf()

  fun wipe() {
    plaintextBytes.fill(0)
  }

  override fun toString(): String =
    "DecryptedContentResult(code=$code, plaintext=<redacted-${plaintextBytes.size}-bytes>)"
}

interface RustContentBridge {
  fun decrypt(contentKey: ByteArray, nonce: ByteArray, ciphertext: ByteArray, epochId: Int): DecryptedContentResult
}

data class RustContentDecryptFfiResult(
  val code: Int,
  val plaintext: ByteArray,
) {
  init {
    require(code >= 0) { "decrypt code must not be negative" }
  }

  fun wipe() {
    plaintext.fill(0)
  }

  override fun toString(): String =
    "RustContentDecryptFfiResult(code=$code, plaintext=<redacted-${plaintext.size}-bytes>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustContentDecryptFfiResult) return false
    return code == other.code && plaintext.contentEquals(other.plaintext)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + plaintext.contentHashCode()
    return result
  }
}

interface GeneratedRustContentApi {
  fun decryptContentWithRawKey(
    contentKey: ByteArray,
    nonce: ByteArray,
    ciphertext: ByteArray,
    epochId: Int,
  ): RustContentDecryptFfiResult
}

class GeneratedRustContentBridge(
  private val api: GeneratedRustContentApi,
) : RustContentBridge {
  override fun decrypt(
    contentKey: ByteArray,
    nonce: ByteArray,
    ciphertext: ByteArray,
    epochId: Int,
  ): DecryptedContentResult {
    require(epochId >= 0) { "epoch_id must not be negative" }
    val result = api.decryptContentWithRawKey(contentKey, nonce, ciphertext, epochId)
    return try {
      val code = when (result.code) {
        RustContentDecryptStableCode.OK -> ContentDecryptCode.SUCCESS
        RustContentDecryptStableCode.INVALID_KEY_LENGTH -> ContentDecryptCode.INVALID_KEY_LENGTH
        RustContentDecryptStableCode.INVALID_INPUT_LENGTH -> ContentDecryptCode.INVALID_INPUT_LENGTH
        RustContentDecryptStableCode.AUTHENTICATION_FAILED -> ContentDecryptCode.AUTHENTICATION_FAILED
        else -> ContentDecryptCode.INTERNAL_ERROR
      }
      if (code == ContentDecryptCode.SUCCESS) {
        DecryptedContentResult(code, plaintext = result.plaintext)
      } else {
        DecryptedContentResult(code, plaintext = ByteArray(0))
      }
    } finally {
      result.wipe()
    }
  }
}
