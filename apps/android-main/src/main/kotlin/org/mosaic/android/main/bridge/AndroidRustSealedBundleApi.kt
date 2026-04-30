package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustSealedBundleApi
import org.mosaic.android.foundation.RustOpenedBundleFfiResult
import uniffi.mosaic_uniffi.verifyAndOpenBundleWithRecipientSeed as rustVerifyAndOpen

/**
 * Real implementation of [GeneratedRustSealedBundleApi] backed by the Rust
 * UniFFI core. Delegates to
 * `mosaic_uniffi.verify_and_open_bundle_with_recipient_seed`.
 *
 * SECURITY: This adapter exposes a raw-seed cross-client sealed-bundle
 * path. Production code must use the handle-based
 * `verify_and_open_bundle_with_identity_handle` so the per-epoch manifest
 * signing secret stays inside the registry. Only Slice 0C round-trip tests
 * are permitted to reference this class.
 */
class AndroidRustSealedBundleApi : GeneratedRustSealedBundleApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  @Suppress("LongParameterList")
  override fun verifyAndOpenBundleWithRecipientSeed(
    recipientIdentitySeed: ByteArray,
    sealed: ByteArray,
    signature: ByteArray,
    sharerPubkey: ByteArray,
    expectedOwnerPubkey: ByteArray,
    expectedAlbumId: String,
    expectedMinEpochId: Int,
    allowLegacyEmptyAlbumId: Boolean,
  ): RustOpenedBundleFfiResult {
    require(recipientIdentitySeed.size <= MAX_SEED_BYTES) {
      "recipient identity seed must be at most $MAX_SEED_BYTES bytes"
    }
    require(sealed.size <= MAX_SEALED_BYTES) {
      "sealed payload must be at most $MAX_SEALED_BYTES bytes"
    }
    require(signature.size <= MAX_SIGNATURE_BYTES) {
      "signature must be at most $MAX_SIGNATURE_BYTES bytes"
    }
    require(sharerPubkey.size <= MAX_PUBLIC_KEY_BYTES && expectedOwnerPubkey.size <= MAX_PUBLIC_KEY_BYTES) {
      "pubkeys must be at most $MAX_PUBLIC_KEY_BYTES bytes"
    }
    require(expectedAlbumId.length <= MAX_ALBUM_ID_CHARS) {
      "expected_album_id must be at most $MAX_ALBUM_ID_CHARS characters"
    }
    require(expectedMinEpochId >= 0) { "expected_min_epoch_id must not be negative" }

    val result = rustVerifyAndOpen(
      recipientIdentitySeed,
      sealed,
      signature,
      sharerPubkey,
      expectedOwnerPubkey,
      expectedAlbumId,
      expectedMinEpochId.toUInt(),
      allowLegacyEmptyAlbumId,
    )
    return RustOpenedBundleFfiResult(
      code = result.code.toInt(),
      version = result.version.toInt(),
      albumId = result.albumId,
      epochId = result.epochId.toInt(),
      recipientPubkey = result.recipientPubkey,
      epochSeed = result.epochSeed,
      signPublicKey = result.signPublicKey,
    )
  }

  companion object {
    private const val MAX_SEED_BYTES: Int = 64
    private const val MAX_SEALED_BYTES: Int = 16 * 1024
    private const val MAX_SIGNATURE_BYTES: Int = 128
    private const val MAX_PUBLIC_KEY_BYTES: Int = 64
    private const val MAX_ALBUM_ID_CHARS: Int = 128
  }
}
