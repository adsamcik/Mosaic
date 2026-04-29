package org.mosaic.android.foundation

object RustHeaderStableCode {
  const val OK: Int = 0
  const val INVALID_HEADER_LENGTH: Int = 100
  const val INVALID_MAGIC: Int = 101
  const val UNSUPPORTED_VERSION: Int = 102
  const val INVALID_TIER: Int = 103
  const val NON_ZERO_RESERVED_BYTE: Int = 104
}

enum class HeaderParseCode {
  SUCCESS,
  INVALID_HEADER_LENGTH,
  INVALID_MAGIC,
  UNSUPPORTED_VERSION,
  INVALID_TIER,
  NON_ZERO_RESERVED_BYTE,
  INTERNAL_ERROR,
}

class ParsedShardEnvelopeHeader(
  val epochId: Int,
  val shardIndex: Int,
  val tier: Int,
  nonce: ByteArray,
) {
  init {
    require(epochId >= 0) { "epoch id must not be negative" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    require(tier in MIN_TIER..MAX_TIER) { "tier must be within [$MIN_TIER, $MAX_TIER]" }
    require(nonce.size == NONCE_LENGTH) { "shard envelope nonce must be $NONCE_LENGTH bytes" }
  }

  private val nonceBytes: ByteArray = nonce.copyOf()

  val nonce: ByteArray
    get() = nonceBytes.copyOf()

  override fun toString(): String =
    "ParsedShardEnvelopeHeader(epochId=$epochId, shardIndex=$shardIndex, tier=$tier, nonce=<redacted>)"

  companion object {
    const val NONCE_LENGTH: Int = 24
    const val MIN_TIER: Int = 1
    const val MAX_TIER: Int = 3
  }
}

data class HeaderParseResult(
  val code: HeaderParseCode,
  val parsed: ParsedShardEnvelopeHeader?,
) {
  init {
    require((code == HeaderParseCode.SUCCESS) == (parsed != null)) {
      "successful header parses require a ParsedShardEnvelopeHeader; failures must not include one"
    }
  }
}

interface RustHeaderBridge {
  fun parseEnvelopeHeader(bytes: ByteArray): HeaderParseResult
}

data class RustHeaderParseFfiResult(
  val code: Int,
  val epochId: Int,
  val shardIndex: Int,
  val tier: Int,
  val nonce: ByteArray,
) {
  init {
    require(code >= 0) { "header parse code must not be negative" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    require(tier >= 0) { "tier must not be negative" }
  }

  override fun toString(): String =
    "RustHeaderParseFfiResult(code=$code, epochId=$epochId, shardIndex=$shardIndex, tier=$tier, nonce=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustHeaderParseFfiResult) return false
    return code == other.code &&
      epochId == other.epochId &&
      shardIndex == other.shardIndex &&
      tier == other.tier &&
      nonce.contentEquals(other.nonce)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + epochId
    result = 31 * result + shardIndex
    result = 31 * result + tier
    result = 31 * result + nonce.contentHashCode()
    return result
  }
}

interface GeneratedRustHeaderApi {
  fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult
}

class GeneratedRustHeaderBridge(
  private val api: GeneratedRustHeaderApi,
) : RustHeaderBridge {
  override fun parseEnvelopeHeader(bytes: ByteArray): HeaderParseResult {
    val result = api.parseEnvelopeHeader(bytes)
    return when (result.code) {
      RustHeaderStableCode.OK -> {
        val parsed = runCatching {
          ParsedShardEnvelopeHeader(
            epochId = result.epochId,
            shardIndex = result.shardIndex,
            tier = result.tier,
            nonce = result.nonce,
          )
        }.getOrNull()
        if (parsed != null) {
          HeaderParseResult(HeaderParseCode.SUCCESS, parsed)
        } else {
          HeaderParseResult(HeaderParseCode.INTERNAL_ERROR, null)
        }
      }
      RustHeaderStableCode.INVALID_HEADER_LENGTH -> HeaderParseResult(HeaderParseCode.INVALID_HEADER_LENGTH, null)
      RustHeaderStableCode.INVALID_MAGIC -> HeaderParseResult(HeaderParseCode.INVALID_MAGIC, null)
      RustHeaderStableCode.UNSUPPORTED_VERSION -> HeaderParseResult(HeaderParseCode.UNSUPPORTED_VERSION, null)
      RustHeaderStableCode.INVALID_TIER -> HeaderParseResult(HeaderParseCode.INVALID_TIER, null)
      RustHeaderStableCode.NON_ZERO_RESERVED_BYTE -> HeaderParseResult(HeaderParseCode.NON_ZERO_RESERVED_BYTE, null)
      else -> HeaderParseResult(HeaderParseCode.INTERNAL_ERROR, null)
    }
  }
}
