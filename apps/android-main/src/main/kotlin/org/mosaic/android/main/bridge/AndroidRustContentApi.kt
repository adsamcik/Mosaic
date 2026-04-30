package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustContentApi
import org.mosaic.android.foundation.RustContentDecryptFfiResult
import uniffi.mosaic_uniffi.decryptContentWithRawKey as rustDecryptContent

/**
 * Real implementation of [GeneratedRustContentApi] backed by the Rust
 * UniFFI core. Delegates to `mosaic_uniffi.decrypt_content_with_raw_key`.
 *
 * SECURITY: This adapter exposes a raw-key cross-client content decrypt
 * path. Production decrypt flows must use the handle-based
 * `decrypt_album_content_with_epoch_handle` — only Slice 0C round-trip
 * tests are permitted to reference this class.
 */
class AndroidRustContentApi : GeneratedRustContentApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun decryptContentWithRawKey(
    contentKey: ByteArray,
    nonce: ByteArray,
    ciphertext: ByteArray,
    epochId: Int,
  ): RustContentDecryptFfiResult {
    require(contentKey.size <= MAX_KEY_BYTES) {
      "content key must be at most $MAX_KEY_BYTES bytes"
    }
    require(nonce.size <= MAX_NONCE_BYTES) {
      "nonce must be at most $MAX_NONCE_BYTES bytes"
    }
    require(ciphertext.size <= MAX_CIPHERTEXT_BYTES) {
      "ciphertext must be at most $MAX_CIPHERTEXT_BYTES bytes"
    }
    require(epochId >= 0) { "epoch_id must not be negative" }
    val result = rustDecryptContent(contentKey, nonce, ciphertext, epochId.toUInt())
    return RustContentDecryptFfiResult(
      code = result.code.toInt(),
      plaintext = result.plaintext,
    )
  }

  companion object {
    private const val MAX_KEY_BYTES: Int = 64
    private const val MAX_NONCE_BYTES: Int = 64
    private const val MAX_CIPHERTEXT_BYTES: Int = 100 * 1024 * 1024
  }
}
