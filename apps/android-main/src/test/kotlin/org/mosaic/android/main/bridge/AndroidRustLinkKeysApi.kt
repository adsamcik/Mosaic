package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustLinkKeysApi
import org.mosaic.android.foundation.RustLinkKeysFfiResult
import uniffi.mosaic_uniffi.deriveLinkKeysFromRawSecret as rustDeriveLinkKeys

/**
 * Real implementation of [GeneratedRustLinkKeysApi] backed by the Rust
 * UniFFI core. Delegates to `mosaic_uniffi.derive_link_keys_from_raw_secret`.
 *
 * SECURITY: This adapter exposes a raw-input cross-client crypto path.
 * This class lives in the test source set and exists only for Slice 0C
 * round-trip tests. Production builds exclude the raw-input UniFFI symbol via
 * the `cross-client-vectors` Cargo feature gate.
 */
class AndroidRustLinkKeysApi : GeneratedRustLinkKeysApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun deriveLinkKeysFromRawSecret(linkSecret: ByteArray): RustLinkKeysFfiResult {
    require(linkSecret.size <= MAX_LINK_SECRET_BYTES) {
      "link secret must be at most $MAX_LINK_SECRET_BYTES bytes (defense-in-depth)"
    }
    val result = rustDeriveLinkKeys(linkSecret)
    return RustLinkKeysFfiResult(
      code = result.code.toInt(),
      linkId = result.linkId,
      linkHandleId = result.linkHandleId,
    )
  }

  companion object {
    private const val MAX_LINK_SECRET_BYTES: Int = 64
  }
}
