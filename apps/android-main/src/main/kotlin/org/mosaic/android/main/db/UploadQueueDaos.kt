package org.mosaic.android.main.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update

@Dao
interface UploadQueueDao {
  @Transaction
  fun insert(record: UploadQueueRecord) {
    PrivacyPatternValidator.validateUploadQueueRecord(record)
    insertValidated(record)
  }

  @Transaction
  fun update(record: UploadQueueRecord) {
    PrivacyPatternValidator.validateUploadQueueRecord(record)
    updateValidated(record)
  }

  @Insert(onConflict = OnConflictStrategy.ABORT)
  fun insertValidated(record: UploadQueueRecord)

  @Update
  fun updateValidated(record: UploadQueueRecord)

  @Query("SELECT * FROM upload_queue_records WHERE job_id = :jobId")
  fun get(jobId: String): UploadQueueRecord?

  @Query("SELECT COUNT(*) FROM upload_queue_records")
  fun count(): Int
}

@Dao
interface ShardStagingDao {
  @Transaction
  fun insert(ref: ShardStagingRef) {
    PrivacyPatternValidator.validateShardStagingRef(ref)
    insertValidated(ref)
  }

  @Insert(onConflict = OnConflictStrategy.ABORT)
  fun insertValidated(ref: ShardStagingRef)

  @Query("SELECT * FROM shard_staging_refs WHERE job_id = :jobId ORDER BY staged_at_ms ASC")
  fun listForJob(jobId: String): List<ShardStagingRef>
}

@Dao
interface StagedPickerBlobDao {
  @Transaction
  fun insert(blob: StagedPickerBlob) {
    PrivacyPatternValidator.validateStagedPickerBlob(blob)
    insertValidated(blob)
  }

  @Insert(onConflict = OnConflictStrategy.ABORT)
  fun insertValidated(blob: StagedPickerBlob)

  @Query("SELECT * FROM staged_picker_blobs WHERE job_id = :jobId ORDER BY created_at_ms ASC")
  fun listForJob(jobId: String): List<StagedPickerBlob>
}

@Dao
interface UploadJobSnapshotDao {
  @Transaction
  fun upsert(row: UploadJobSnapshotRow) {
    PrivacyPatternValidator.validateUploadJobSnapshot(row)
    upsertValidated(row)
  }

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  fun upsertValidated(row: UploadJobSnapshotRow)

  @Query("SELECT * FROM upload_job_snapshots WHERE job_id = :jobId")
  fun get(jobId: String): UploadJobSnapshotRow?
}

@Dao
interface AlbumSyncSnapshotDao {
  @Transaction
  fun upsert(row: AlbumSyncSnapshotRow) {
    PrivacyPatternValidator.validateAlbumSyncSnapshot(row)
    upsertValidated(row)
  }

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  fun upsertValidated(row: AlbumSyncSnapshotRow)

  @Query("SELECT * FROM album_sync_snapshots WHERE album_id = :albumId")
  fun get(albumId: String): AlbumSyncSnapshotRow?
}
