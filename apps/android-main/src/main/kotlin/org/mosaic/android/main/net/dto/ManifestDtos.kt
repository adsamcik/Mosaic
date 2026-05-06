package org.mosaic.android.main.net.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ManifestFinalizeRequest(
  @SerialName("protocolVersion") val protocolVersion: Int = 1,
  @SerialName("albumId") val albumId: String,
  @SerialName("assetType") val assetType: String,
  @SerialName("encryptedMeta") val encryptedMeta: String,
  @SerialName("encryptedMetaSidecar") val encryptedMetaSidecar: String? = null,
  @SerialName("signature") val signature: String,
  @SerialName("signerPubkey") val signerPubkey: String,
  @SerialName("shardIds") val shardIds: List<String> = emptyList(),
  @SerialName("tieredShards") val tieredShards: List<TieredShardInfo>,
  @SerialName("expiresAt") val expiresAt: String? = null,
)

@Serializable
data class ManifestFinalizeResponse(
  @SerialName("protocolVersion") val protocolVersion: Int,
  @SerialName("manifestId") val manifestId: String,
  @SerialName("metadataVersion") val metadataVersion: Long,
  @SerialName("createdAt") val createdAt: String,
  @SerialName("tieredShards") val tieredShards: List<TieredShardInfo>,
)

@Serializable
data class ManifestFinalizeErrorBody(
  @SerialName("error") val error: String? = null,
  @SerialName("detail") val detail: String? = null,
  @SerialName("manifestId") val manifestId: String? = null,
)

@Serializable
data class TieredShardInfo(
  @SerialName("shardId") val shardId: String,
  @SerialName("tier") val tier: Int,
  @SerialName("shardIndex") val shardIndex: Int = 0,
  @SerialName("sha256") val sha256: String,
  @SerialName("contentLength") val contentLength: Long,
  @SerialName("envelopeVersion") val envelopeVersion: Int = 3,
)
