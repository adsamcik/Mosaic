package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustIdentitySeedApi
import org.mosaic.android.foundation.RustIdentitySeedFfiResult
import uniffi.mosaic_uniffi.deriveIdentityFromRawSeed as rustDeriveIdentityFromRawSeed

/**
 * Real implementation of [GeneratedRustIdentitySeedApi] backed by the Rust
 * UniFFI core. Delegates to `mosaic_uniffi.derive_identity_from_raw_seed`.
 *
 * SECURITY: This adapter exposes a raw-seed cross-client crypto path.
 * This class lives in the test source set and exists only for Slice 0C
 * round-trip tests. Production builds exclude the raw-seed UniFFI symbol via
 * the `cross-client-vectors` Cargo feature gate.
 */
class AndroidRustIdentitySeedApi : GeneratedRustIdentitySeedApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun deriveIdentityFromRawSeed(
    identitySeed: ByteArray,
    message: ByteArray,
  ): RustIdentitySeedFfiResult {
    require(identitySeed.size <= MAX_SEED_BYTES) {
      "identity seed must be at most $MAX_SEED_BYTES bytes (defense-in-depth)"
    }
    require(message.size <= MAX_MESSAGE_BYTES) {
      "identity message must be at most $MAX_MESSAGE_BYTES bytes (defense-in-depth)"
    }
    val result = rustDeriveIdentityFromRawSeed(identitySeed, message)
    return RustIdentitySeedFfiResult(
      code = result.code.toInt(),
      signingPubkey = result.signingPubkey,
      encryptionPubkey = result.encryptionPubkey,
      signature = result.signature,
    )
  }

  companion object {
    private const val MAX_SEED_BYTES: Int = 64
    private const val MAX_MESSAGE_BYTES: Int = 64 * 1024
  }
}
