package org.mosaic.android.main.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
  entities = [
    UploadQueueRecord::class,
    ShardStagingRef::class,
    StagedPickerBlob::class,
    UploadJobSnapshotRow::class,
    AlbumSyncSnapshotRow::class,
  ],
  version = 1,
  exportSchema = true,
)
abstract class UploadQueueDatabase : RoomDatabase() {
  abstract fun uploadQueueDao(): UploadQueueDao
  abstract fun shardStagingDao(): ShardStagingDao
  abstract fun stagedPickerBlobDao(): StagedPickerBlobDao
  abstract fun uploadJobSnapshotDao(): UploadJobSnapshotDao
  abstract fun albumSyncSnapshotDao(): AlbumSyncSnapshotDao

  companion object {
    const val DATABASE_NAME: String = "mosaic_upload_queue.db"

    fun create(context: Context): UploadQueueDatabase = Room.databaseBuilder(
      context.applicationContext,
      UploadQueueDatabase::class.java,
      DATABASE_NAME,
    ).addCallback(PrivacyValidationRoomCallback).build()

    fun createInMemoryForTests(context: Context): UploadQueueDatabase = Room.inMemoryDatabaseBuilder(
      context.applicationContext,
      UploadQueueDatabase::class.java,
    ).allowMainThreadQueries()
      .addCallback(PrivacyValidationRoomCallback)
      .build()
  }
}

object PrivacyValidationRoomCallback : RoomDatabase.Callback() {
  override fun onCreate(db: SupportSQLiteDatabase) {
    installPrivacyTriggers(db)
  }

  override fun onOpen(db: SupportSQLiteDatabase) {
    installPrivacyTriggers(db)
  }
}

private fun installPrivacyTriggers(db: SupportSQLiteDatabase) {
  val tables = mapOf(
    "upload_queue_records" to listOf(
      "job_id",
      "album_id",
      "phase",
      "idempotency_key",
      "shard_set_hash_hex",
      "last_effect_id",
      "last_acknowledged_effect_id",
      "last_applied_event_id",
    ),
    "shard_staging_refs" to listOf("shard_id", "job_id", "sha256_hex"),
    "staged_picker_blobs" to listOf("blob_id", "job_id", "mime_type"),
    "upload_job_snapshots" to listOf("job_id", "canonical_cbor_bytes"),
    "album_sync_snapshots" to listOf("album_id", "canonical_cbor_bytes"),
  )
  for ((table, columns) in tables) {
    for (operation in listOf("INSERT", "UPDATE")) {
      db.execSQL(triggerSql(table, columns, operation))
    }
  }
}

private fun triggerSql(table: String, columns: List<String>, operation: String): String {
  val triggerName = "privacy_${table}_${operation.lowercase()}"
  val checks = columns.joinToString(" OR ") { column ->
    val value = "lower(CAST(COALESCE(NEW.$column, '') AS TEXT))"
    "($value LIKE '%signature%' OR $value LIKE '%signpublickey%' OR " +
      "$value LIKE '%sign_public_key%' OR $value LIKE '%privatekey%' OR " +
      "$value LIKE '%private_key%' OR $value LIKE '%-----begin%' OR " +
      "$value LIKE '%ed25519%' OR $value LIKE '%@%.%')"
  }
  return """
    CREATE TRIGGER IF NOT EXISTS $triggerName
    BEFORE $operation ON $table
    FOR EACH ROW
    WHEN $checks
    BEGIN
      SELECT RAISE(ABORT, 'Mosaic privacy validator rejected plaintext marker');
    END
  """.trimIndent()
}
