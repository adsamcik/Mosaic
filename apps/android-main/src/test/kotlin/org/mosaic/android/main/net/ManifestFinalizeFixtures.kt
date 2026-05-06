@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package org.mosaic.android.main.net

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.mosaic.android.main.net.dto.ManifestFinalizeRequest
import org.mosaic.android.main.net.dto.ManifestFinalizeResponse
import org.mosaic.android.main.net.dto.TieredShardInfo
import org.mosaic.android.main.net.dto.UploadJobId

internal object ManifestFinalizeFixtures {
  val albumId = "018f9f8d-99df-7b42-8f0d-111111111111"
  val manifestId = "018f9f8d-99df-7b42-8f0d-222222222222"
  val uploadJobId = UploadJobId("018f9f8d-99df-7b42-8f0d-333333333333")
  val tieredShards = listOf(
    TieredShardInfo(
      shardId = "018f9f8d-99df-7b42-8f0d-444444444444",
      tier = 1,
      shardIndex = 0,
      sha256 = "a".repeat(64),
      contentLength = 11,
      envelopeVersion = 3,
    ),
    TieredShardInfo(
      shardId = "018f9f8d-99df-7b42-8f0d-555555555555",
      tier = 2,
      shardIndex = 0,
      sha256 = "b".repeat(64),
      contentLength = 22,
      envelopeVersion = 3,
    ),
    TieredShardInfo(
      shardId = "018f9f8d-99df-7b42-8f0d-666666666666",
      tier = 3,
      shardIndex = 0,
      sha256 = "c".repeat(64),
      contentLength = 33,
      envelopeVersion = 3,
    ),
  )
  val request = ManifestFinalizeRequest(
    albumId = albumId,
    assetType = "Image",
    encryptedMeta = "ZW5jcnlwdGVkLW1ldGE=",
    encryptedMetaSidecar = "ZW5jcnlwdGVkLXNpZGVjYXI=",
    signature = "c2lnbmF0dXJl",
    signerPubkey = "cHVia2V5",
    tieredShards = tieredShards,
  )
  val response = ManifestFinalizeResponse(
    protocolVersion = 1,
    manifestId = manifestId,
    metadataVersion = 1,
    createdAt = "2025-01-02T03:04:05Z",
    tieredShards = tieredShards,
  )
  val json = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
  }
  val responseJson = json.encodeToString(response)
}
