package org.mosaic.android.main.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mosaic.android.main.net.dto.AlbumSyncResponse

class AlbumSyncResponseDeserializationTest {
  @Test
  fun albumSyncResponseDeserializesBackendContractShape() {
    val shape = ContractSnapshotTestSupport.toShapeJson(AlbumSyncFixtures.responseJson)
    assertEquals(
      Json.parseToJsonElement(ContractSnapshotTestSupport.backendSnapshot("album-sync.contract.json")),
      Json.parseToJsonElement(shape),
    )

    val decoded = Json.decodeFromString(AlbumSyncResponse.serializer(), AlbumSyncFixtures.responseJson)

    assertEquals(AlbumSyncFixtures.albumId, decoded.albumId)
    assertEquals(42L, decoded.currentVersion)
    assertEquals(AlbumSyncFixtures.manifestId, decoded.manifestId)
    assertEquals("/api/manifests/${AlbumSyncFixtures.manifestId}", decoded.manifestUrl)
    assertEquals("d".repeat(64), decoded.expectedSha256)
  }
}
