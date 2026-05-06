package org.mosaic.android.main.net

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ManifestFinalizeRequestSerializationTest {
  @Test
  fun manifestFinalizeRequestSerializesAdr022BodyFields() {
    val encoded = ManifestFinalizeFixtures.json.encodeToString(ManifestFinalizeFixtures.request)

    assertFalse(encoded.contains("encryptedMetaSidecar\":null"))
    assertEquals("Image", kotlinx.serialization.json.Json.parseToJsonElement(encoded).jsonObjectValue("assetType"))
    assertEquals(ManifestFinalizeFixtures.albumId, kotlinx.serialization.json.Json.parseToJsonElement(encoded).jsonObjectValue("albumId"))
  }

  @Test
  fun manifestFinalizeResponseSerializationMatchesBackendContractSnapshot() {
    val encoded = ManifestFinalizeFixtures.json.encodeToString(ManifestFinalizeFixtures.response)
    val shape = ContractSnapshotTestSupport.toShapeJson(encoded)

    assertEquals(
      Json.parseToJsonElement(ContractSnapshotTestSupport.backendSnapshot("manifest-finalize.contract.json")),
      Json.parseToJsonElement(shape),
    )
  }
}
