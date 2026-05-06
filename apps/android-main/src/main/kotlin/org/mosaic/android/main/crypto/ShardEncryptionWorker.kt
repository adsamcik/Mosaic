package org.mosaic.android.main.crypto

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf

class ShardEncryptionWorker internal constructor(
  appContext: Context,
  workerParams: WorkerParameters,
  private val cryptoEngine: ShardCryptoEngine,
  private val envelopeStore: ShardEnvelopeStore,
) : CoroutineWorker(appContext, workerParams) {
  constructor(
    appContext: Context,
    workerParams: WorkerParameters,
  ) : this(appContext, workerParams, AndroidShardCryptoEngine(), ShardEnvelopeStore(appContext))

  override suspend fun doWork(): Result {
    val stagingUri = inputData.getString(KEY_STAGING_URI) ?: return Result.failure()
    val epochHandleId = inputData.getLong(KEY_EPOCH_HANDLE_ID, 0L)
    val tier = inputData.getInt(KEY_TIER, 0)
    val shardIndex = inputData.getInt(KEY_SHARD_INDEX, -1)

    if (epochHandleId == 0L || tier !in MIN_TIER..MAX_TIER || shardIndex < 0) {
      return Result.failure()
    }

    return try {
      val store = envelopeStore
      val plaintext = store.readStagingBytes(stagingUri)
      val input = ShardEnvelopeInput(
        stagingUri = stagingUri,
        epochHandleId = epochHandleId,
        tier = tier,
        shardIndex = shardIndex,
        plaintextSha256Hex = ShardEnvelopeStore.sha256Hex(plaintext),
      )

      val existingEnvelopeUri = store.existingEnvelopeUri(input)
      val envelopeUri = if (existingEnvelopeUri != null) {
        existingEnvelopeUri
      } else {
        val engine = cryptoEngine
        val envelope = if (plaintext.size > STREAMING_THRESHOLD_BYTES) {
          engine.encryptStreamingShard(epochHandleId, plaintext, tier, shardIndex)
        } else {
          engine.encryptShardWithEpochHandle(epochHandleId, plaintext, tier, shardIndex)
        }
        store.persistEnvelope(input, envelope)
      }
      val sha256 = ShardEnvelopeStore.sha256Hex(store.readStagingBytes(envelopeUri))
      Result.success(
        workDataOf(
          KEY_ENVELOPE_URI to envelopeUri,
          KEY_SHA256_HEX to sha256,
        ),
      )
    } catch (e: Exception) {
      if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
    }
  }

  companion object {
    const val KEY_STAGING_URI: String = "staging_uri"
    const val KEY_EPOCH_HANDLE_ID: String = "epoch_handle_id"
    const val KEY_TIER: String = "tier"
    const val KEY_SHARD_INDEX: String = "shard_index"
    const val KEY_ENVELOPE_URI: String = "envelope_uri"
    const val KEY_SHA256_HEX: String = "sha256_hex"
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
