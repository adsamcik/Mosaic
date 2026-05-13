package org.mosaic.android.main.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
  entities = [
    UploadQueueRecord::class,
    ShardStagingRef::class,
    StagedPickerBlob::class,
    UploadJobSnapshotRow::class,
    AlbumSyncSnapshotRow::class,
    AlbumContentHashRecord::class,
    AlbumEpochKeyRecord::class,
  ],
  version = 3,
  exportSchema = true,
)
abstract class UploadQueueDatabase : RoomDatabase() {
  abstract fun uploadQueueDao(): UploadQueueDao
  abstract fun shardStagingDao(): ShardStagingDao
  abstract fun stagedPickerBlobDao(): StagedPickerBlobDao
  abstract fun uploadJobSnapshotDao(): UploadJobSnapshotDao
  abstract fun albumSyncSnapshotDao(): AlbumSyncSnapshotDao
  abstract fun albumContentHashDao(): AlbumContentHashDao
  abstract fun albumEpochKeyDao(): AlbumEpochKeyDao

  companion object {
    const val DATABASE_NAME: String = "mosaic_upload_queue.db"

    fun create(context: Context): UploadQueueDatabase = Room.databaseBuilder(
      context.applicationContext,
      UploadQueueDatabase::class.java,
      DATABASE_NAME,
    ).addMigrations(MIGRATION_1_2, MIGRATION_2_3)
      .addCallback(PrivacyValidationRoomCallback)
      .build()

    fun createInMemoryForTests(context: Context): UploadQueueDatabase = Room.inMemoryDatabaseBuilder(
      context.applicationContext,
      UploadQueueDatabase::class.java,
    ).allowMainThreadQueries()
      .addCallback(PrivacyValidationRoomCallback)
      .build()

    val MIGRATION_1_2: Migration = object : Migration(1, 2) {
      override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
          """
            CREATE TABLE IF NOT EXISTS `album_content_hashes` (
              `album_id` TEXT NOT NULL,
              `content_hash` TEXT NOT NULL,
              `photo_id` TEXT NOT NULL,
              `date_added` INTEGER NOT NULL,
              PRIMARY KEY(`album_id`, `content_hash`)
            )
          """.trimIndent(),
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_album_content_hashes_album_id_content_hash` ON `album_content_hashes` (`album_id`, `content_hash`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_album_content_hashes_album_id` ON `album_content_hashes` (`album_id`)")
      }
    }

    val MIGRATION_2_3: Migration = object : Migration(2, 3) {
      override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
          """
            CREATE TABLE IF NOT EXISTS `album_epoch_keys` (
              `album_id` TEXT NOT NULL,
              `epoch_id` INTEGER NOT NULL,
              `wrapped_epoch_seed` BLOB NOT NULL,
              `updated_at_ms` INTEGER NOT NULL,
              PRIMARY KEY(`album_id`, `epoch_id`)
            )
          """.trimIndent(),
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_album_epoch_keys_album_id` ON `album_epoch_keys` (`album_id`)")
      }
    }
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
    "album_content_hashes" to listOf("album_id", "content_hash", "photo_id"),
    "album_epoch_keys" to listOf("album_id"),
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
      "$value LIKE '%ed25519%' OR $value LIKE '${MosaicPiiPatterns.EMAIL_SQL_LIKE}')"
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
