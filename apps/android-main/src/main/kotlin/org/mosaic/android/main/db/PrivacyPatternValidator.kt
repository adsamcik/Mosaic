package org.mosaic.android.main.db

object RustSnapshotVersions {
  const val CURRENT: Int = 1
}

object PrivacyPatternValidator {
  private val forbiddenPlaintextMarkers = listOf(
    "signature",
    "signpublickey",
    "sign_public_key",
    "privatekey",
    "private_key",
    "-----begin",
    "ed25519",
  )

  fun validateUploadQueueRecord(row: UploadQueueRecord) = validateValues(
    tableName = "upload_queue_records",
    values = listOf(
      row.jobId,
      row.albumId,
      row.schemaVersion,
      row.phase,
      row.createdAtMs,
      row.updatedAtMs,
      row.retryCount,
      row.maxRetryCount,
      row.nextRetryNotBeforeMs,
      row.idempotencyKey,
      row.tieredShardCount,
      row.shardSetHashHex,
      row.snapshotRevision,
      row.lastEffectId,
      row.lastAcknowledgedEffectId,
      row.lastAppliedEventId,
      row.failureCode,
    ),
  )

  fun validateShardStagingRef(row: ShardStagingRef) = validateValues(
    tableName = "shard_staging_refs",
    values = listOf(row.shardId, row.jobId, row.stagedAtMs, row.sizeBytes, row.sha256Hex),
  )

  fun validateStagedPickerBlob(row: StagedPickerBlob) = validateValues(
    tableName = "staged_picker_blobs",
    values = listOf(row.blobId, row.jobId, row.mimeType, row.sizeBytes, row.createdAtMs),
  )

  fun validateUploadJobSnapshot(row: UploadJobSnapshotRow) = validateValues(
    tableName = "upload_job_snapshots",
    values = listOf(row.jobId, row.schemaVersion, row.canonicalCborBytes, row.updatedAtMs, row.snapshotRevision),
  )

  fun validateAlbumSyncSnapshot(row: AlbumSyncSnapshotRow) = validateValues(
    tableName = "album_sync_snapshots",
    values = listOf(row.albumId, row.schemaVersion, row.canonicalCborBytes, row.updatedAtMs, row.snapshotRevision),
  )

  private fun validateValues(tableName: String, values: Iterable<Any?>) {
    for (value in values) {
      val text = when (value) {
        null -> continue
        is ByteArray -> value.toString(Charsets.UTF_8)
        else -> value.toString()
      }
      val normalized = text.lowercase()
      if (findQueuePlaintextMarkers(text).isNotEmpty()) {
        throw IllegalArgumentException("Mosaic privacy validator rejected plaintext marker in $tableName")
      }
    }
  }

  fun findPlaintextMarkers(text: String): List<PrivacyPatternMatch> {
    val normalized = text.lowercase()
    val markerMatches = forbiddenPlaintextMarkers
      .filter { marker -> normalized.contains(marker) }
      .map { marker -> PrivacyPatternMatch("plaintext-marker:$marker", excerpt(text, normalized.indexOf(marker), marker.length)) }
    val piiMatches = MosaicPiiPatterns.ALL.mapNotNull { pattern ->
      pattern.regex.find(text)?.let { match -> PrivacyPatternMatch(pattern.name, excerpt(text, match.range.first, match.value.length)) }
    }
    return markerMatches + piiMatches
  }

  private fun findQueuePlaintextMarkers(text: String): List<PrivacyPatternMatch> {
    val normalized = text.lowercase()
    val markerMatches = forbiddenPlaintextMarkers
      .filter { marker -> normalized.contains(marker) }
      .map { marker -> PrivacyPatternMatch("plaintext-marker:$marker", excerpt(text, normalized.indexOf(marker), marker.length)) }
    val emailMatches = MosaicPiiPatterns.EMAIL.find(text)?.let { match ->
      listOf(PrivacyPatternMatch("email", excerpt(text, match.range.first, match.value.length)))
    }.orEmpty()
    return markerMatches + emailMatches
  }

  private fun excerpt(text: String, start: Int, length: Int): String {
    val safeStart = start.coerceAtLeast(0)
    val from = (safeStart - EXCERPT_CONTEXT_CHARS).coerceAtLeast(0)
    val to = (safeStart + length + EXCERPT_CONTEXT_CHARS).coerceAtMost(text.length)
    return text.substring(from, to)
  }

  private const val EXCERPT_CONTEXT_CHARS: Int = 12
}

data class PrivacyPatternMatch(
  val patternName: String,
  val excerpt: String,
)
