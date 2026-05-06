package org.mosaic.android.main.net

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.mosaic.android.main.net.dto.AlbumSyncResponse

internal object AlbumSyncFixtures {
  val albumId = "018f9f8d-99df-7b42-8f0d-777777777777"
  val manifestId = "018f9f8d-99df-7b42-8f0d-888888888888"
  val response = AlbumSyncResponse(
    albumId = albumId,
    currentVersion = 42,
    manifestId = manifestId,
    manifestUrl = "/api/manifests/$manifestId",
    expectedSha256 = "d".repeat(64),
  )
  val responseJson = Json.encodeToString(response)
}
