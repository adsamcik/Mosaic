package org.mosaic.android.main.net.manifest

import org.mosaic.android.main.net.dto.UploadJobId
import uniffi.mosaic_uniffi.finalizeIdempotencyKey

object MosaicIdempotencyKeys {
  /**
   * ADR-022 format is delegated to the canonical Rust implementation so Android,
   * Web/WASM, and client-core stay byte-for-byte aligned.
   */
  fun forManifestFinalize(jobId: UploadJobId): String = finalizeIdempotencyKey(jobId.value)
}
