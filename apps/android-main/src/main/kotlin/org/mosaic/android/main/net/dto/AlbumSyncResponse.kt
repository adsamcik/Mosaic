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
)
