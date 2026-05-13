package org.mosaic.android.main.upload

import java.io.File
import android.net.Uri
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.mosaic.android.main.picker.PhotoPickerStagingAdapter
import org.mosaic.android.main.staging.StagedFile
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RustContentHasherTest {
  @Test
  fun sha256HexMatchesStandardVectors() {
    assertEquals(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      RustContentHasher.sha256Hex(ByteArray(0)),
    )
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      RustContentHasher.sha256Hex("abc".toByteArray(Charsets.UTF_8)),
    )
  }

  @Test
  fun sha256HexMatchesContentHashDedupSourceFileFixture() {
    val fixture = loadContentHashDedupFixture()
    val webFileArrayBufferBytes = fixture.sourceFileBytes.copyOf()
    val androidStagingInputBytes = fixture.sourceFileBytes.copyOf()

    assertEquals(64, fixture.sourceFileBytes.size)
    assertEquals(
      fixture.plaintextSha256Hex,
      RustContentHasher.sha256Hex(webFileArrayBufferBytes),
    )
    assertEquals(
      fixture.plaintextSha256Hex,
      RustContentHasher.sha256Hex(androidStagingInputBytes),
    )
  }

  @Test
  fun photoPickerProductionHashPathMatchesRustHasherForStagedFile() {
    val fixture = loadContentHashDedupFixture()
    val stagedFile = stagedFileWithBytes(fixture.sourceFileBytes)

    assertEquals(
      RustContentHasher.sha256Hex(fixture.sourceFileBytes),
      PhotoPickerStagingAdapter.computeAlbumContentHash(stagedFile),
    )
    assertEquals(
      fixture.plaintextSha256Hex,
      PhotoPickerStagingAdapter.computeAlbumContentHash(stagedFile),
    )
  }

  private data class ContentHashDedupFixture(
    val sourceFileBytes: ByteArray,
    val plaintextSha256Hex: String,
  )

  private fun loadContentHashDedupFixture(): ContentHashDedupFixture {
    val fixtureFile = repoRoot().resolve("tests/vectors/content_hash_dedup.json")
    val root = Json.parseToJsonElement(fixtureFile.readText()).jsonObject
    val inputs = root.getValue("inputs").jsonObject
    val expected = root.getValue("expected").jsonObject
    return ContentHashDedupFixture(
      sourceFileBytes = hexToBytes(inputs.getValue("sourceFileBytesHex").jsonPrimitive.content),
      plaintextSha256Hex = expected.getValue("plaintextSha256Hex").jsonPrimitive.content,
    )
  }

  private fun stagedFileWithBytes(bytes: ByteArray): StagedFile {
    val file = kotlin.io.path.createTempFile(prefix = "mosaic-content-hash-", suffix = ".blob").toFile()
    file.deleteOnExit()
    file.writeBytes(bytes)
    return StagedFile(
      id = file.nameWithoutExtension,
      uri = Uri.fromFile(file),
      file = file,
      displayName = file.name,
      sizeBytes = file.length(),
      createdAtMs = 1_700_000_000_000L,
      lastAccessMs = 1_700_000_000_000L,
    )
  }

  private fun repoRoot(): File {
    val userDir = System.getProperty("user.dir") ?: error("user.dir system property is not set")
    var current = File(userDir).absoluteFile
    while (true) {
      if (current.resolve("tests/vectors/content_hash_dedup.json").isFile) {
        return current
      }
      current = current.parentFile
        ?: error("Could not find Mosaic repository root from ${System.getProperty("user.dir")}")
    }
  }

  private fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "fixture hex must have even length" }
    return ByteArray(hex.length / 2) { index ->
      hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }
}
