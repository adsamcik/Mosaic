package org.mosaic.android.main.net

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mosaic.android.main.net.dto.ShardId
import org.mosaic.android.main.net.dto.UploadJobId
import org.mosaic.android.main.net.manifest.MosaicIdempotencyKeys

class MosaicIdempotencyKeysTest {
  @Test
  fun tusShardPatchKeyMatchesCanonicalVector() {
    val vector = Json.parseToJsonElement(repoRoot().resolve("tests/vectors/tus_patch_idempotency_key.json").readText()).jsonObject
    val inputs = vector.getValue("inputs").jsonObject
    val expected = vector.getValue("expected").jsonObject

    val key = MosaicIdempotencyKeys.forTusShardPatch(
      UploadJobId(inputs.getValue("jobId").jsonPrimitive.content),
      ShardId(inputs.getValue("shardId").jsonPrimitive.content),
    )

    assertEquals(expected.getValue("idempotencyKey").jsonPrimitive.content, key)
  }

  private fun repoRoot(): File {
    var current = File(System.getProperty("user.dir") ?: error("user.dir system property is not set")).absoluteFile
    while (true) {
      if (current.resolve("tests/vectors/tus_patch_idempotency_key.json").isFile) return current
      current = current.parentFile
        ?: error("Could not find Mosaic repository root from ${System.getProperty("user.dir")}")
    }
  }
}
