package org.mosaic.android.main.crypto

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.db.RustSnapshotVersions
import org.mosaic.android.main.db.ShardStagingRef
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadQueueRecord
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Verifies the v1.0.1 envelope layout migrator that moves legacy flat
 * `<sha256>.envelope` files into the per-album subdirectory layout
 * introduced by v101-s34 so AlbumPurger can drop them without a DB index.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EnvelopeLayoutMigratorTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val envelopeRoot = File(context.filesDir, "encrypted-shards")
  private lateinit var database: UploadQueueDatabase

  @Before
  fun resetMigrationFlag() {
    envelopeRoot.deleteRecursively()
    context.getSharedPreferences(EnvelopeLayoutMigrator.SHARED_PREFS_NAME, Context.MODE_PRIVATE)
      .edit().clear().commit()
  }

  @After
  fun tearDown() {
    if (::database.isInitialized) database.close()
    envelopeRoot.deleteRecursively()
    context.getSharedPreferences(EnvelopeLayoutMigrator.SHARED_PREFS_NAME, Context.MODE_PRIVATE)
      .edit().clear().commit()
  }

  @Test
  fun migrateLegacyEnvelopesIsNoOpWhenEnvelopeRootMissing() {
    database = UploadQueueDatabase.createInMemoryForTests(context)

    val result = EnvelopeLayoutMigrator.migrateLegacyEnvelopes(context, database)

    assertEquals(0, result.moved)
    assertEquals(0, result.orphaned)
    assertTrue(result.errors.isEmpty())
  }

  @Test
  fun migrateLegacyEnvelopesMovesAllReferencedFilesIntoAlbumSubdirectories() {
    database = UploadQueueDatabase.createInMemoryForTests(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val albumB = "018f9f8d-99df-7b42-8f0d-bbbbbbbbbbbb"
    val sha1 = "a".repeat(64)
    val sha2 = "b".repeat(64)
    val sha3 = "c".repeat(64)
    insertJobWithShard("jobA1", albumA, "shardA1", sha1)
    insertJobWithShard("jobA2", albumA, "shardA2", sha2)
    insertJobWithShard("jobB1", albumB, "shardB1", sha3)
    val flat1 = writeLegacyEnvelope(sha1, "envelope-1")
    val flat2 = writeLegacyEnvelope(sha2, "envelope-2")
    val flat3 = writeLegacyEnvelope(sha3, "envelope-3")

    val result = EnvelopeLayoutMigrator.migrateLegacyEnvelopes(context, database)

    assertEquals(3, result.moved)
    assertEquals(0, result.orphaned)
    assertTrue("no errors expected; got ${result.errors}", result.errors.isEmpty())
    assertFalse("legacy file 1 must be gone", flat1.exists())
    assertFalse("legacy file 2 must be gone", flat2.exists())
    assertFalse("legacy file 3 must be gone", flat3.exists())
    assertTrue(File(envelopeRoot, "$albumA/$sha1.envelope").exists())
    assertTrue(File(envelopeRoot, "$albumA/$sha2.envelope").exists())
    assertTrue(File(envelopeRoot, "$albumB/$sha3.envelope").exists())
  }

  @Test
  fun migrateLegacyEnvelopesDeletesOrphansThatHaveNoAlbumReference() {
    database = UploadQueueDatabase.createInMemoryForTests(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val sha1 = "a".repeat(64)
    val orphanSha = "e".repeat(64)
    insertJobWithShard("jobA1", albumA, "shardA1", sha1)
    val keep = writeLegacyEnvelope(sha1, "kept")
    val orphan = writeLegacyEnvelope(orphanSha, "orphan-payload")

    val result = EnvelopeLayoutMigrator.migrateLegacyEnvelopes(context, database)

    assertEquals(1, result.moved)
    assertEquals(1, result.orphaned)
    assertTrue(result.errors.isEmpty())
    assertFalse("orphan envelope must be deleted", orphan.exists())
    assertFalse("legacy referenced file must be moved", keep.exists())
    assertTrue(File(envelopeRoot, "$albumA/$sha1.envelope").exists())
  }

  @Test
  fun migrateIfNeededIsIdempotentOnceFlagIsSet() {
    database = UploadQueueDatabase.createInMemoryForTests(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val sha1 = "a".repeat(64)
    insertJobWithShard("jobA1", albumA, "shardA1", sha1)
    writeLegacyEnvelope(sha1, "first-run")

    val first = EnvelopeLayoutMigrator.migrateIfNeeded(context, database)
    // Second-run setup: drop a fresh legacy file that should NOT be migrated
    // because the idempotency flag was set on the first successful run.
    val secondLegacy = writeLegacyEnvelope("d".repeat(64), "second-run")
    val second = EnvelopeLayoutMigrator.migrateIfNeeded(context, database)

    assertEquals(1, first.moved)
    assertEquals(0, second.moved)
    assertEquals(0, second.orphaned)
    assertTrue("second run must be a no-op once the flag is set", second.errors.isEmpty())
    assertTrue("flag must persist across runs", secondLegacy.exists())
    assertTrue(
      context.getSharedPreferences(EnvelopeLayoutMigrator.SHARED_PREFS_NAME, Context.MODE_PRIVATE)
        .getBoolean(EnvelopeLayoutMigrator.PREF_KEY_MIGRATED, false),
    )
  }

  private fun writeLegacyEnvelope(sha256Hex: String, body: String): File {
    envelopeRoot.mkdirs()
    val file = File(envelopeRoot, "$sha256Hex.envelope")
    file.writeText(body)
    return file
  }

  private fun insertJobWithShard(jobId: String, albumId: String, shardId: String, sha256Hex: String) {
    database.uploadQueueDao().insert(uploadQueueRecord(jobId, albumId))
    database.shardStagingDao().insert(
      ShardStagingRef(
        shardId = shardId,
        jobId = jobId,
        stagedAtMs = 1_700_000_000_000L,
        sizeBytes = 1024L,
        sha256Hex = sha256Hex,
      ),
    )
  }

  private fun uploadQueueRecord(jobId: String, albumId: String): UploadQueueRecord = UploadQueueRecord(
    jobId = jobId,
    albumId = albumId,
    schemaVersion = RustSnapshotVersions.CURRENT,
    phase = "AwaitingPreparedMedia",
    createdAtMs = 1_700_000_000_000L,
    updatedAtMs = 1_700_000_000_000L,
    retryCount = 0,
    maxRetryCount = 3,
    nextRetryNotBeforeMs = null,
    idempotencyKey = "idempotency-$jobId",
    tieredShardCount = 0,
    shardSetHashHex = null,
    snapshotRevision = 0L,
    lastEffectId = null,
    lastAcknowledgedEffectId = null,
    lastAppliedEventId = null,
    failureCode = null,
  )
}
