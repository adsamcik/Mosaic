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
      val plaintextLength = store.stagingLength(stagingUri)
      val smallPlaintext = if (plaintextLength > STREAMING_THRESHOLD_BYTES) null else store.readStagingBytes(stagingUri)
      val plaintextSha256Hex = if (smallPlaintext == null) {
        ShardEnvelopeStore.sha256Hex(store.openStagingInputStream(stagingUri))
      } else {
        ShardEnvelopeStore.sha256Hex(smallPlaintext)
      }
      val input = ShardEnvelopeInput(
        stagingUri = stagingUri,
        epochHandleId = epochHandleId,
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
            engine.encryptStreamingShard(epochHandleId, plaintext, plaintextLength, tier, shardIndex)
          }
        } else {
          engine.encryptShardWithEpochHandle(epochHandleId, requireNotNull(smallPlaintext), tier, shardIndex)
        }
        val persisted = store.persistEnvelope(input, envelope)
        persisted.uri to persisted.sha256Hex
      }
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
