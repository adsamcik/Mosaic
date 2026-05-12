package org.mosaic.android.main.net.manifest

import java.security.MessageDigest
import java.util.Base64
import org.mosaic.android.main.net.dto.ShardId
import org.mosaic.android.main.net.dto.UploadJobId
import uniffi.mosaic_uniffi.finalizeIdempotencyKey

object MosaicIdempotencyKeys {
  /**
   * ADR-022 format is delegated to the canonical Rust implementation so Android,
   * Web/WASM, and client-core stay byte-for-byte aligned.
   */
  fun forManifestFinalize(jobId: UploadJobId): String = finalizeIdempotencyKey(jobId.value)

  /**
   * Local key — backend treats opaque, parity TBD. No UniFFI export exists yet
   * for TUS shard PATCH idempotency, so Android derives a stable per-shard key
   * from the upload job and shard identifiers until the canonical Rust helper is
   * available.
   */
  fun forTusShardPatch(jobId: UploadJobId, shardId: ShardId): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest("tus-patch\u0000${jobId.value}\u0000${shardId.value}".toByteArray(Charsets.UTF_8))
    val token = Base64.getUrlEncoder().withoutPadding().encodeToString(digest.copyOfRange(0, 18))
    return "mosaic-tus-patch-$token"
  }
}
