package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustLinkKeysApi
import org.mosaic.android.foundation.RustLinkKeysFfiResult
import uniffi.mosaic_uniffi.deriveLinkKeysFromRawSecret as rustDeriveLinkKeys

/**
 * Real implementation of [GeneratedRustLinkKeysApi] backed by the Rust
 * UniFFI core. Delegates to `mosaic_uniffi.derive_link_keys_from_raw_secret`.
 *
 * SECURITY: This adapter exposes a raw-input cross-client crypto path.
 * Production code paths must NOT instantiate or use this class — only the
 * Slice 0C round-trip tests under `apps/android-main/src/test/.../bridge`
 * are permitted to reference it. Enforcement: the architecture-guard at
 * `tests/architecture/kotlin-raw-input-ffi.{ps1,sh}` fails CI on any
 * non-test caller.
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
      wrappingKey = result.wrappingKey,
    )
  }

  companion object {
    private const val MAX_LINK_SECRET_BYTES: Int = 64
  }
}
