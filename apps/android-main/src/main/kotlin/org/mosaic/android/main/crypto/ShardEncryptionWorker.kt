package org.mosaic.android.main.crypto

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.security.zeroize
import org.mosaic.android.main.upload.ContentHashDedup
import org.mosaic.android.main.upload.NoOpContentHashDedup
import org.mosaic.android.main.upload.RoomContentHashDedup
import org.mosaic.android.main.upload.ShardWorkerForegroundInfo

class ShardEncryptionWorker internal constructor(
  appContext: Context,
  workerParams: WorkerParameters,
  private val cryptoEngine: ShardCryptoEngine,
  private val envelopeStore: ShardEnvelopeStore,
  private val epochHandleResolver: EpochHandleResolver,
  private val contentHashDedup: ContentHashDedup = NoOpContentHashDedup,
) : CoroutineWorker(appContext, workerParams) {
  constructor(
    appContext: Context,
    workerParams: WorkerParameters,
  ) : this(appContext, workerParams, UploadQueueDatabase.create(appContext))

  private constructor(
    appContext: Context,
    workerParams: WorkerParameters,
    database: UploadQueueDatabase,
  ) : this(
    appContext,
    workerParams,
    AndroidShardCryptoEngine(),
    ShardEnvelopeStore(appContext),
    RoomEpochHandleResolver(database.albumEpochKeyDao()),
    RoomContentHashDedup(database.albumContentHashDao()),
  )

  override suspend fun getForegroundInfo(): ForegroundInfo =
    ShardWorkerForegroundInfo.forEncryption(applicationContext)

  override suspend fun doWork(): Result {
    val stagingUri = inputData.getString(KEY_STAGING_URI) ?: return Result.failure()
    val albumId = inputData.getString(KEY_ALBUM_ID)?.takeIf { it.isNotBlank() }
      ?: return Result.failure(workDataOf("error" to "missing_album_id"))
    val epochId = inputData.getInt(KEY_EPOCH_ID, -1)
    val tier = inputData.getInt(KEY_TIER, -1)
    val shardIndex = inputData.getInt(KEY_SHARD_INDEX, -1)
    val photoId = inputData.getString(KEY_PHOTO_ID)
    val plaintextSha256Hex = inputData.getString(KEY_ALBUM_CONTENT_HASH_HEX)
      ?: return Result.failure(workDataOf("error" to "missing_album_content_hash"))

    if (epochId < 0 || tier !in MIN_TIER..MAX_TIER || shardIndex < 0) {
      return Result.failure()
    }
    if (!org.mosaic.android.main.upload.ContentHashHex.isValid(plaintextSha256Hex)) {
      return Result.failure(workDataOf("error" to "malformed_album_content_hash"))
    }

    return try {
      val epochHandle = epochHandleResolver.openEpochHandle(albumId = albumId, epochId = epochId)
        ?: return Result.failure(workDataOf("error" to ERROR_EPOCH_HANDLE_UNAVAILABLE))
      try {
        val store = envelopeStore
        val plaintextLength = store.stagingLength(stagingUri)
        val smallPlaintext = if (plaintextLength > STREAMING_THRESHOLD_BYTES) null else store.readStagingBytes(stagingUri)
        try {
          // CONTRACT: see docs/specs/SPEC-UploadContentHash.md. This worker now consumes
          // a precomputed source-of-truth content hash via KEY_ALBUM_CONTENT_HASH_HEX.
          // The hash MUST be computed once per photo upstream of this worker (in
          // ShardEncryptionScheduler or its caller). This worker MUST NOT recompute
          // from the staging input — that input may be a tier-specific encoded JPEG.
          if (!photoId.isNullOrBlank()) {
            val duplicate = contentHashDedup.lookup(albumId, plaintextSha256Hex)
            if (duplicate != null && duplicate.photoId != photoId) {
              return Result.failure(
                workDataOf(
                  KEY_DUPLICATE_PHOTO_ID to duplicate.photoId,
                  KEY_DUPLICATE_DATE_ADDED to duplicate.dateAdded,
                  KEY_CONTENT_HASH_HEX to plaintextSha256Hex,
                  KEY_FAILURE_REASON to FAILURE_DUPLICATE,
                ),
              )
            }
          }
          val input = ShardEnvelopeInput(
            stagingUri = stagingUri,
            albumId = albumId,
            epochId = epochId,
            tier = tier,
            shardIndex = shardIndex,
            plaintextSha256Hex = plaintextSha256Hex,
          )

          val existingEnvelopeUri = store.existingEnvelopeUri(input)
          val (envelopeUri, sha256) = if (existingEnvelopeUri != null) {
            existingEnvelopeUri to store.sha256HexForUri(existingEnvelopeUri)
          } else {
            val engine = cryptoEngine
            val envelope = if (plaintextLength > STREAMING_THRESHOLD_BYTES) {
              store.openStagingInputStream(stagingUri).use { plaintext ->
                engine.encryptStreamingShard(epochHandle.id, plaintext, plaintextLength, tier, shardIndex)
              }
            } else {
              engine.encryptShardWithEpochHandle(epochHandle.id, requireNotNull(smallPlaintext), tier, shardIndex)
            }
            val persisted = store.persistEnvelope(input, envelope)
            if (!photoId.isNullOrBlank()) {
              contentHashDedup.record(albumId, plaintextSha256Hex, photoId)
            }
            persisted.uri to persisted.sha256Hex
          }
          Result.success(
            workDataOf(
              KEY_ENVELOPE_URI to envelopeUri,
              KEY_SHA256_HEX to sha256,
              KEY_CONTENT_HASH_HEX to plaintextSha256Hex,
            ),
          )
        } finally {
          smallPlaintext?.zeroize()
        }
      } finally {
        epochHandle.close()
      }
    } catch (e: Exception) {
      if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
    }
  }

  companion object {
    const val KEY_STAGING_URI: String = "staging_uri"
    const val KEY_EPOCH_ID: String = "epoch_id"
    const val KEY_TIER: String = "tier"
    const val KEY_SHARD_INDEX: String = "shard_index"
    const val KEY_ALBUM_ID: String = "album_id"
    const val KEY_PHOTO_ID: String = "photo_id"
    const val KEY_ALBUM_CONTENT_HASH_HEX: String = "album_content_hash_hex"
    const val KEY_ENVELOPE_URI: String = "envelope_uri"
    const val KEY_SHA256_HEX: String = "sha256_hex"
    const val KEY_CONTENT_HASH_HEX: String = "content_hash_hex"
    const val KEY_DUPLICATE_PHOTO_ID: String = "duplicate_photo_id"
    const val KEY_DUPLICATE_DATE_ADDED: String = "duplicate_date_added"
    const val KEY_FAILURE_REASON: String = "failure_reason"
    const val FAILURE_DUPLICATE: String = "duplicate-content"
    const val ERROR_EPOCH_HANDLE_UNAVAILABLE: String = "epoch_handle_unavailable"
    const val MAX_RETRIES: Int = 3
    /**
     * Above 256 KiB, encrypt via the v0x04 streaming AEAD so WorkManager never
     * asks UniFFI to process multi-frame shard data as a single allocation. The
     * stream still uses 64 KiB crypto frames, matching the Rust core contract.
     */
    const val STREAMING_THRESHOLD_BYTES: Int = 256 * 1024
    const val STREAMING_FRAME_BYTES: Int = 64 * 1024

    private const val MIN_TIER: Int = 1
    private const val MAX_TIER: Int = 3
  }
}
