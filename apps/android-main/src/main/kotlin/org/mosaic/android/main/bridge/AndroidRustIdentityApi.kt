package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustIdentityApi
import org.mosaic.android.foundation.RustBytesFfiResult
import org.mosaic.android.foundation.RustIdentityHandleFfiResult
import uniffi.mosaic_uniffi.closeIdentityHandle as rustCloseIdentityHandle
import uniffi.mosaic_uniffi.createIdentityHandle as rustCreateIdentityHandle
import uniffi.mosaic_uniffi.identityEncryptionPubkey as rustIdentityEncryptionPubkey
import uniffi.mosaic_uniffi.identitySigningPubkey as rustIdentitySigningPubkey
import uniffi.mosaic_uniffi.openIdentityHandle as rustOpenIdentityHandle
import uniffi.mosaic_uniffi.signManifestWithIdentity as rustSignManifestWithIdentity

/** Real implementation of [GeneratedRustIdentityApi] backed by the Rust UniFFI core. */
class AndroidRustIdentityApi : GeneratedRustIdentityApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun createIdentityHandle(accountKeyHandle: Long): RustIdentityHandleFfiResult {
    val result = rustCreateIdentityHandle(accountKeyHandle.toULong())
    return RustIdentityHandleFfiResult(
      code = result.code.toInt(),
      handle = result.handle.toLong(),
      signingPubkey = result.signingPubkey,
      encryptionPubkey = result.encryptionPubkey,
      wrappedSeed = result.wrappedSeed,
    )
  }

  override fun openIdentityHandle(wrappedSeed: ByteArray, accountKeyHandle: Long): RustIdentityHandleFfiResult {
    val result = rustOpenIdentityHandle(wrappedSeed, accountKeyHandle.toULong())
    return RustIdentityHandleFfiResult(
      code = result.code.toInt(),
      handle = result.handle.toLong(),
      signingPubkey = result.signingPubkey,
      encryptionPubkey = result.encryptionPubkey,
      wrappedSeed = result.wrappedSeed,
    )
  }

  override fun identitySigningPubkey(handle: Long): RustBytesFfiResult {
    val result = rustIdentitySigningPubkey(handle.toULong())
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun identityEncryptionPubkey(handle: Long): RustBytesFfiResult {
    val result = rustIdentityEncryptionPubkey(handle.toULong())
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun signManifestWithIdentity(handle: Long, transcriptBytes: ByteArray): RustBytesFfiResult {
    require(transcriptBytes.isNotEmpty()) { "manifest transcript must not be empty" }
    require(transcriptBytes.size <= MAX_TRANSCRIPT_BYTES) {
      "manifest transcript must be at most $MAX_TRANSCRIPT_BYTES bytes"
    }
    val result = rustSignManifestWithIdentity(handle.toULong(), transcriptBytes)
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun closeIdentityHandle(handle: Long): Int =
    rustCloseIdentityHandle(handle.toULong()).toInt()

  companion object {
    // 64 KiB is generous: real manifest transcripts for a single album are
    // ~hundreds of bytes per shard, with a hard cap on the manifest entries
    // count enforced server-side. This bound is defense-in-depth before
    // crossing the FFI; the Rust side independently rejects oversize input.
    private const val MAX_TRANSCRIPT_BYTES: Int = 64 * 1024
  }
}
