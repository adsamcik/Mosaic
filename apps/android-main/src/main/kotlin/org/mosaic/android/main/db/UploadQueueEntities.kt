package org.mosaic.android.main.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
  tableName = "upload_queue_records",
  indices = [Index(value = ["album_id"]), Index(value = ["phase"]), Index(value = ["updated_at_ms"])],
)
data class UploadQueueRecord(
  @PrimaryKey @ColumnInfo(name = "job_id") val jobId: String,
  @ColumnInfo(name = "album_id") val albumId: String,
  @ColumnInfo(name = "schema_version") val schemaVersion: Int,
  @ColumnInfo(name = "phase") val phase: String,
  @ColumnInfo(name = "created_at_ms") val createdAtMs: Long,
  @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
  @ColumnInfo(name = "retry_count") val retryCount: Int,
  @ColumnInfo(name = "max_retry_count") val maxRetryCount: Int,
  @ColumnInfo(name = "next_retry_not_before_ms") val nextRetryNotBeforeMs: Long?,
  @ColumnInfo(name = "idempotency_key") val idempotencyKey: String,
  @ColumnInfo(name = "tiered_shard_count") val tieredShardCount: Int,
  @ColumnInfo(name = "shard_set_hash_hex") val shardSetHashHex: String?,
  @ColumnInfo(name = "snapshot_revision") val snapshotRevision: Long,
  @ColumnInfo(name = "last_effect_id") val lastEffectId: String?,
  @ColumnInfo(name = "last_acknowledged_effect_id") val lastAcknowledgedEffectId: String?,
  @ColumnInfo(name = "last_applied_event_id") val lastAppliedEventId: String?,
  @ColumnInfo(name = "failure_code") val failureCode: Int?,
)

@Entity(
  tableName = "shard_staging_refs",
  foreignKeys = [
    ForeignKey(
      entity = UploadQueueRecord::class,
      parentColumns = ["job_id"],
      childColumns = ["job_id"],
      onDelete = ForeignKey.CASCADE,
    ),
  ],
  indices = [Index(value = ["job_id"]), Index(value = ["sha256_hex"], unique = true)],
)
data class ShardStagingRef(
  @PrimaryKey @ColumnInfo(name = "shard_id") val shardId: String,
  @ColumnInfo(name = "job_id") val jobId: String,
  @ColumnInfo(name = "staged_at_ms") val stagedAtMs: Long,
  @ColumnInfo(name = "size_bytes") val sizeBytes: Long,
  @ColumnInfo(name = "sha256_hex") val sha256Hex: String,
)

@Entity(
  tableName = "staged_picker_blobs",
  foreignKeys = [
    ForeignKey(
      entity = UploadQueueRecord::class,
      parentColumns = ["job_id"],
      childColumns = ["job_id"],
      onDelete = ForeignKey.CASCADE,
    ),
  ],
  indices = [Index(value = ["job_id"]), Index(value = ["created_at_ms"])],
)
data class StagedPickerBlob(
  @PrimaryKey @ColumnInfo(name = "blob_id") val blobId: String,
  @ColumnInfo(name = "job_id") val jobId: String,
  @ColumnInfo(name = "mime_type") val mimeType: String,
  @ColumnInfo(name = "size_bytes") val sizeBytes: Long,
  @ColumnInfo(name = "created_at_ms") val createdAtMs: Long,
)

@Entity(tableName = "upload_job_snapshots", indices = [Index(value = ["updated_at_ms"])])
data class UploadJobSnapshotRow(
  @PrimaryKey @ColumnInfo(name = "job_id") val jobId: String,
  @ColumnInfo(name = "schema_version") val schemaVersion: Int,
  @ColumnInfo(name = "canonical_cbor_bytes", typeAffinity = ColumnInfo.BLOB) val canonicalCborBytes: ByteArray,
  @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
  @ColumnInfo(name = "snapshot_revision") val snapshotRevision: Long,
)

@Entity(tableName = "album_sync_snapshots", indices = [Index(value = ["updated_at_ms"])])
data class AlbumSyncSnapshotRow(
  @PrimaryKey @ColumnInfo(name = "album_id") val albumId: String,
  @ColumnInfo(name = "schema_version") val schemaVersion: Int,
  @ColumnInfo(name = "canonical_cbor_bytes", typeAffinity = ColumnInfo.BLOB) val canonicalCborBytes: ByteArray,
  @ColumnInfo(name = "updated_at_ms") val updatedAtMs: Long,
  @ColumnInfo(name = "snapshot_revision") val snapshotRevision: Long,
)
