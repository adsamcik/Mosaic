@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package org.mosaic.android.main.net

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.mosaic.android.main.net.dto.AlbumSyncManifest
import org.mosaic.android.main.net.dto.AlbumSyncResponse
import org.mosaic.android.main.net.dto.AlbumSyncShard

internal object AlbumSyncFixtures {
  val albumId = "018f9f8d-99df-7b42-8f0d-777777777777"
  val manifestId = "018f9f8d-99df-7b42-8f0d-888888888888"
  val response = AlbumSyncResponse(
    albumId = albumId,
    currentVersion = 42,
    manifestId = manifestId,
    manifestUrl = "/api/v1/manifests/$manifestId",
    expectedSha256 = "d".repeat(64),
    manifests = listOf(
      AlbumSyncManifest(
        id = manifestId,
        albumId = albumId,
        versionCreated = 42,
        isDeleted = false,
        encryptedMeta = "ZW5jcnlwdGVkLW1ldGE=",
        signature = "c2lnbmF0dXJl",
        signerPubkey = "cHVia2V5",
        shardIds = listOf("018f9f8d-99df-7b42-8f0d-999999999999"),
        shards = listOf(
          AlbumSyncShard(
            shardId = "018f9f8d-99df-7b42-8f0d-999999999999",
            tier = 3,
            shardIndex = 0,
            sha256 = "e".repeat(64),
            contentLength = 1234,
            envelopeVersion = 3,
          ),
        ),
      ),
    ),
    currentEpochId = 7,
    albumVersion = 42,
    hasMore = false,
  )
  val responseJson = Json {
    encodeDefaults = true
    explicitNulls = false
  }.encodeToString(response)
}
