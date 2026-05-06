package org.mosaic.android.main.net.manifest

import org.mosaic.android.main.net.dto.UploadJobId

object MosaicIdempotencyKeys {
  /**
   * ADR-022 format: the Idempotency-Key header is the persisted upload-job UUIDv7 string,
   * unprefixed, so manifest-finalize retries replay the same server-side cache entry.
   */
  fun forManifestFinalize(jobId: UploadJobId): String = jobId.value
}
