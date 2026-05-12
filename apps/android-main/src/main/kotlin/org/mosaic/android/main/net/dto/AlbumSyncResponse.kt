package org.mosaic.android.main.net.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class AlbumSyncResponse(
  @SerialName("albumId") val albumId: String,
  @SerialName("currentVersion") val currentVersion: Long,
  @SerialName("manifestId") val manifestId: String? = null,
  @SerialName("manifestUrl") val manifestUrl: String? = null,
  @SerialName("expectedSha256") val expectedSha256: String,
  @SerialName("manifests") val manifests: List<AlbumSyncManifest> = emptyList(),
  @SerialName("currentEpochId") val currentEpochId: Int = 0,
  @SerialName("albumVersion") val albumVersion: Long = currentVersion,
  @SerialName("hasMore") val hasMore: Boolean = false,
)

@Serializable
data class AlbumSyncManifest(
  @SerialName("id") val id: String,
  @SerialName("albumId") val albumId: String,
  @SerialName("versionCreated") val versionCreated: Long,
  @SerialName("isDeleted") val isDeleted: Boolean,
  @SerialName("encryptedMeta") val encryptedMeta: String? = null,
  @SerialName("signature") val signature: String? = null,
  @SerialName("signerPubkey") val signerPubkey: String? = null,
  @SerialName("expiresAt") val expiresAt: String? = null,
  @SerialName("shardIds") val shardIds: List<String> = emptyList(),
  @SerialName("shards") val shards: List<AlbumSyncShard> = emptyList(),
)

@Serializable
data class AlbumSyncShard(
  @SerialName("shardId") val shardId: String,
  @SerialName("tier") val tier: Int,
  @SerialName("shardIndex") val shardIndex: Int,
  @SerialName("sha256") val sha256: String,
  @SerialName("contentLength") val contentLength: Long,
  @SerialName("envelopeVersion") val envelopeVersion: Int,
)
