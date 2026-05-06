package org.mosaic.android.main.net

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal fun JsonElement.jsonObjectValue(name: String): String =
  jsonObject[name]!!.jsonPrimitive.content

internal fun JsonElement.jsonObjectValue(name: String, block: JsonPrimitive.() -> Unit) {
  jsonObject[name]!!.jsonPrimitive.block()
}

@Suppress("unused")
internal fun JsonObject.require(name: String): JsonElement = get(name)!!
