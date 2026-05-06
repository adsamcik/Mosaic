package org.mosaic.android.main.db

import androidx.room.RoomDatabase
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadQueueDatabaseSchemaTest {
  private val db = UploadQueueDatabase.createInMemoryForTests(ApplicationProvider.getApplicationContext())

  @After
  fun closeDb() {
    db.close()
  }

  @Test
  fun databaseExposesQueueStagingAndSnapshotTables() {
    val tables = queryStrings("SELECT name FROM sqlite_master WHERE type = 'table'")

    assertEquals(
      setOf(
        "android_metadata",
        "room_master_table",
        "upload_queue_records",
        "shard_staging_refs",
        "staged_picker_blobs",
        "upload_job_snapshots",
        "album_sync_snapshots",
      ),
      tables.toSet(),
    )
  }

  @Test
  fun queueAndStagingRowsRoundTripWithForeignKeys() {
    val record = validUploadQueueRecord()
    db.uploadQueueDao().insert(record)
    db.shardStagingDao().insert(
      ShardStagingRef(
        shardId = "mosaic-staged://upload/job-1#preview-0",
        jobId = record.jobId,
        stagedAtMs = 1_700_000_000_010L,
        sizeBytes = 4096L,
        sha256Hex = "0".repeat(64),
      ),
    )
    db.stagedPickerBlobDao().insert(
      StagedPickerBlob(
        blobId = "picker-blob-1",
        jobId = record.jobId,
        mimeType = "image/jpeg",
        sizeBytes = 8192L,
        createdAtMs = 1_700_000_000_020L,
      ),
    )

    assertEquals(1, db.uploadQueueDao().count())
    assertEquals(record, db.uploadQueueDao().get(record.jobId))
    assertEquals(1, db.shardStagingDao().listForJob(record.jobId).size)
    assertEquals(1, db.stagedPickerBlobDao().listForJob(record.jobId).size)
  }

  @Test
  fun snapshotsPersistCanonicalCborBytesAndRustSchemaVersion() {
    val uploadBytes = byteArrayOf(0xA2.toByte(), 0x00, 0x01, 0x01, 0x02)
    val albumBytes = byteArrayOf(0xA1.toByte(), 0x00, 0x01)

    db.uploadJobSnapshotDao().upsert(
      UploadJobSnapshotRow(
        jobId = "018f05a4-8b31-7c00-8c00-0000000000e1",
        schemaVersion = RustSnapshotVersions.CURRENT,
        canonicalCborBytes = uploadBytes,
        updatedAtMs = 1_700_000_000_030L,
        snapshotRevision = 7L,
      ),
    )
    db.albumSyncSnapshotDao().upsert(
      AlbumSyncSnapshotRow(
        albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
        schemaVersion = RustSnapshotVersions.CURRENT,
        canonicalCborBytes = albumBytes,
        updatedAtMs = 1_700_000_000_040L,
        snapshotRevision = 8L,
      ),
    )

    val upload = requireNotNull(db.uploadJobSnapshotDao().get("018f05a4-8b31-7c00-8c00-0000000000e1"))
    val album = requireNotNull(db.albumSyncSnapshotDao().get("018f05a4-8b31-7c00-8c00-0000000000a3"))
    assertEquals(1, upload.schemaVersion)
    assertEquals(1, album.schemaVersion)
    assertArrayEquals(uploadBytes, upload.canonicalCborBytes)
    assertArrayEquals(albumBytes, album.canonicalCborBytes)
  }

  @Test
  fun daoPrivacyValidatorRejectsPiiBeforeInsert() {
    val bad = validUploadQueueRecord().copy(phase = "signature from alice@example.com")

    assertThrows(IllegalArgumentException::class.java) {
      db.uploadQueueDao().insert(bad)
    }
  }


  @Test
  fun daoPrivacyValidatorRejectsSqlLikeEmailShapeBeforeInsert() {
    val bad = validUploadQueueRecord().copy(phase = "AwaitingPreparedMedia user@.local")

    assertThrows(IllegalArgumentException::class.java) {
      db.uploadQueueDao().insert(bad)
    }
  }

  @Test
  fun roomCallbackTriggerRejectsPlaintextMarkerOnRawInsert() {
    val sql = """
      INSERT INTO upload_queue_records (
        job_id, album_id, schema_version, phase, created_at_ms, updated_at_ms,
        retry_count, max_retry_count, next_retry_not_before_ms, idempotency_key,
        tiered_shard_count, shard_set_hash_hex, snapshot_revision, last_effect_id,
        last_acknowledged_effect_id, last_applied_event_id, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()

    assertThrows(android.database.SQLException::class.java) {
      db.openHelper.writableDatabase.execSQL(
        sql,
        arrayOf(
          "018f05a4-8b31-7c00-8c00-0000000000e2",
          "018f05a4-8b31-7c00-8c00-0000000000a3",
          1,
          "AwaitingPreparedMedia signature",
          1_700_000_000_000L,
          1_700_000_000_000L,
          0,
          3,
          null,
          "018f05a4-8b31-7c00-8c00-0000000000c1",
          0,
          null,
          0L,
          null,
          null,
          null,
          null,
        ),
      )
    }
  }

  @Test
  fun tableColumnsUseSnakeCaseStorageNames() {
    val uploadQueueColumns = tableColumns("upload_queue_records")
    val uploadSnapshotColumns = tableColumns("upload_job_snapshots")
    val albumSnapshotColumns = tableColumns("album_sync_snapshots")

    assertEquals(
      setOf(
        "job_id",
        "album_id",
        "schema_version",
        "phase",
        "created_at_ms",
        "updated_at_ms",
        "retry_count",
        "max_retry_count",
        "next_retry_not_before_ms",
        "idempotency_key",
        "tiered_shard_count",
        "shard_set_hash_hex",
        "snapshot_revision",
        "last_effect_id",
        "last_acknowledged_effect_id",
        "last_applied_event_id",
        "failure_code",
      ),
      uploadQueueColumns,
    )
    assertEquals(setOf("job_id", "schema_version", "canonical_cbor_bytes", "updated_at_ms", "snapshot_revision"), uploadSnapshotColumns)
    assertEquals(setOf("album_id", "schema_version", "canonical_cbor_bytes", "updated_at_ms", "snapshot_revision"), albumSnapshotColumns)
  }

  private fun validUploadQueueRecord(): UploadQueueRecord = UploadQueueRecord(
    jobId = "018f05a4-8b31-7c00-8c00-0000000000e1",
    albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
    schemaVersion = RustSnapshotVersions.CURRENT,
    phase = "AwaitingPreparedMedia",
    createdAtMs = 1_700_000_000_000L,
    updatedAtMs = 1_700_000_000_000L,
    retryCount = 0,
    maxRetryCount = 3,
    nextRetryNotBeforeMs = null,
    idempotencyKey = "018f05a4-8b31-7c00-8c00-0000000000c1",
    tieredShardCount = 0,
    shardSetHashHex = null,
    snapshotRevision = 0L,
    lastEffectId = null,
    lastAcknowledgedEffectId = null,
    lastAppliedEventId = null,
    failureCode = null,
  )

  private fun tableColumns(tableName: String): Set<String> = queryStrings("PRAGMA table_info($tableName)", columnIndex = 1).toSet()

  private fun queryStrings(sql: String, columnIndex: Int = 0): List<String> {
    val cursor = db.query(SimpleSQLiteQuery(sql))
    cursor.use {
      val values = mutableListOf<String>()
      while (it.moveToNext()) {
        values += it.getString(columnIndex)
      }
      return values
    }
  }
}
