package org.mosaic.android.foundation

/**
 * Slice 0C — link-key derivation bridge.
 *
 * This bridge exists exclusively to drive the cross-client corpus tests for
 * `tests/vectors/link_keys.json`. Production code paths must use the
 * high-level link-sharing helpers, not the raw-secret bridge added here.
 */
object RustLinkKeysStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class LinkKeysCode {
  SUCCESS,
  INVALID_KEY_LENGTH,
  INTERNAL_ERROR,
}

class LinkKeysResult(
  val code: LinkKeysCode,
  linkId: ByteArray,
  val linkHandleId: ULong,
) {
  init {
    require((code == LinkKeysCode.SUCCESS) == (linkId.isNotEmpty() && linkHandleId != 0UL)) {
      "successful link-key derivations must include both 16-byte link_id and a non-zero link_handle_id; failures must include neither"
    }
    if (code == LinkKeysCode.SUCCESS) {
      require(linkId.size == LINK_ID_BYTES) { "link_id must be exactly $LINK_ID_BYTES bytes" }
    }
  }

  private val linkIdBytes: ByteArray = linkId.copyOf()

  val linkId: ByteArray
    get() = linkIdBytes.copyOf()

  fun wipe() {
    linkIdBytes.fill(0)
  }

  override fun toString(): String =
    "LinkKeysResult(code=$code, linkId=<redacted-${linkIdBytes.size}-bytes>, linkHandleId=<redacted>)"

  companion object {
    const val LINK_ID_BYTES: Int = 16
  }
}

interface RustLinkKeysBridge {
  fun deriveLinkKeys(linkSecret: ByteArray): LinkKeysResult
}

data class RustLinkKeysFfiResult(
  val code: Int,
  val linkId: ByteArray,
  val linkHandleId: ULong,
) {
  init {
    require(code >= 0) { "link keys code must not be negative" }
  }

  fun wipe() {
    linkId.fill(0)
  }

  override fun toString(): String =
    "RustLinkKeysFfiResult(code=$code, linkId=<redacted-${linkId.size}-bytes>, linkHandleId=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustLinkKeysFfiResult) return false
    return code == other.code &&
      linkId.contentEquals(other.linkId) &&
      linkHandleId == other.linkHandleId
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + linkId.contentHashCode()
    result = 31 * result + linkHandleId.hashCode()
    return result
  }
}

interface GeneratedRustLinkKeysApi {
  fun deriveLinkKeysFromRawSecret(linkSecret: ByteArray): RustLinkKeysFfiResult
}

class GeneratedRustLinkKeysBridge(
  private val api: GeneratedRustLinkKeysApi,
) : RustLinkKeysBridge {
  override fun deriveLinkKeys(linkSecret: ByteArray): LinkKeysResult {
    val result = api.deriveLinkKeysFromRawSecret(linkSecret)
    return try {
      val code = when (result.code) {
        RustLinkKeysStableCode.OK -> LinkKeysCode.SUCCESS
        RustLinkKeysStableCode.INVALID_KEY_LENGTH -> LinkKeysCode.INVALID_KEY_LENGTH
        else -> LinkKeysCode.INTERNAL_ERROR
      }
      if (code == LinkKeysCode.SUCCESS) {
        LinkKeysResult(code, linkId = result.linkId, linkHandleId = result.linkHandleId)
      } else {
        LinkKeysResult(code, linkId = ByteArray(0), linkHandleId = 0UL)
      }
    } finally {
      result.wipe()
    }
  }
}
