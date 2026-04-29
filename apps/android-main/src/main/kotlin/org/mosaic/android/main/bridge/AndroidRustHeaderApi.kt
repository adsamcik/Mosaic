package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustHeaderApi
import org.mosaic.android.foundation.RustHeaderParseFfiResult
import uniffi.mosaic_uniffi.parseEnvelopeHeader as rustParseEnvelopeHeader

/** Real implementation of [GeneratedRustHeaderApi] backed by the Rust UniFFI core. */
class AndroidRustHeaderApi : GeneratedRustHeaderApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult {
    val result = rustParseEnvelopeHeader(bytes)
    return RustHeaderParseFfiResult(
      code = result.code.toInt(),
      epochId = result.epochId.toInt(),
      shardIndex = result.shardIndex.toInt(),
      tier = result.tier.toInt(),
      nonce = result.nonce,
    )
  }
}
