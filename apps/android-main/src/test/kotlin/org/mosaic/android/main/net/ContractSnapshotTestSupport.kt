package org.mosaic.android.main.net

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray

internal object ContractSnapshotTestSupport {
  private val json = Json { prettyPrint = true }

  fun backendSnapshot(name: String): String {
    val relative = "apps/backend/Mosaic.Backend.Tests/Snapshots/$name"
    val start = File(System.getProperty("user.dir")).absoluteFile
    return generateSequence(start) { it.parentFile }
      .map { File(it, relative) }
      .first { it.isFile }
      .readText()
      .trim()
  }

  fun toShapeJson(payload: String): String {
    val element = Json.parseToJsonElement(payload)
    return json.encodeToString(JsonElement.serializer(), toShape(element))
  }

  private fun toShape(element: JsonElement): JsonElement = when (element) {
    is JsonObject -> JsonObject(element.entries.associate { (key, value) -> key to toShape(value) })
    is JsonArray -> buildJsonArray {
      if (element.isNotEmpty()) add(toShape(element.first()))
    }
    JsonNull -> JsonPrimitive("string")
    is JsonPrimitive -> JsonPrimitive(primitiveType(element))
  }

  private fun primitiveType(value: JsonPrimitive): String {
    if (value.isString) return "string"
    val content = value.content
    return if (content.toDoubleOrNull() != null) "number" else "string"
  }
}
