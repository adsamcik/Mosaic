package org.mosaic.android.foundation

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Cross-client golden vector regression — Android shell layer.
 *
 * Loads the shared corpus under tests/vectors/ (each operation in its own JSON
 * file) and asserts every vector's envelope shape (schema version, protocol
 * version, presence of inputs/expected). Operations that need a real
 * Rust core call go through the `Generated*` bridge contracts that ship with
 * the shell — but those bridges are wired to Fake APIs in this JVM-only test
 * harness, so we cannot drive cryptographic byte-equality from here. Each
 * crypto vector is therefore validated for shape only and skipped (with a
 * `SKIP` log line) for byte-equality, with a TODO referencing Slice 0C.
 *
 * The single byte-checkable operation today is the shard-envelope HEADER
 * parser, because it is a pure-format transformation that the existing
 * `RustHeaderBridge` contract already models with stable error codes — the
 * test exercises only the canonical-success mapping.
 */

private data class CrossClientTestCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    CrossClientTestCase("corpus directory exists and contains the expected vector files", ::corpusDirectoryExistsAndContainsExpectedFiles),
    CrossClientTestCase("every corpus file declares schema envelope (version, operation, description)", ::everyCorpusFileDeclaresSchemaEnvelope),
    CrossClientTestCase("manifest_transcript.json declares rust_canonical=true", ::manifestTranscriptDeclaresRustCanonical),
    CrossClientTestCase("shard_envelope.json header bytes parse via RustHeaderBridge contract", ::shardEnvelopeHeaderBytesParseViaBridgeContract),
    CrossClientTestCase("link_keys.json byte-exact assertion is deferred to Slice 0C", ::linkKeysIsDeferredToSliceZeroC),
    CrossClientTestCase("identity.json byte-exact assertion is deferred to Slice 0C", ::identityIsDeferredToSliceZeroC),
    CrossClientTestCase("content_encrypt.json byte-exact assertion is deferred to Slice 0C", ::contentEncryptIsDeferredToSliceZeroC),
    CrossClientTestCase("auth_challenge.json byte-exact assertion is deferred to Slice 0C", ::authChallengeIsDeferredToSliceZeroC),
    CrossClientTestCase("sealed_bundle.json byte-exact assertion is deferred to Slice 0C", ::sealedBundleIsDeferredToSliceZeroC),
    CrossClientTestCase("tier_key_wrap.json is locked under deviation:tier-key-wrap", ::tierKeyWrapIsLockedUnderDeviation),
    CrossClientTestCase("auth_keypair.json is locked under deviation:auth-keypair", ::authKeypairIsLockedUnderDeviation),
    CrossClientTestCase("account_unlock.json is locked under deviation:account-unlock", ::accountUnlockIsLockedUnderDeviation),
    CrossClientTestCase("epoch_derive.json is locked under deviation:epoch-tier-keys", ::epochDeriveIsLockedUnderDeviation),
  )

  var failed = 0
  for (test in tests) {
    try {
      test.body()
      println("PASS ${test.name}")
    } catch (skip: SkipException) {
      println("SKIP ${test.name}: ${skip.message}")
    } catch (error: Throwable) {
      failed += 1
      println("FAIL ${test.name}: ${error.message}")
    }
  }

  if (failed > 0) {
    throw IllegalStateException("$failed cross-client vector tests failed")
  }

  println("PASS ${tests.size} cross-client vector tests")
}

private class SkipException(message: String) : RuntimeException(message)

// --------------------------------------------------------------------------
// Corpus location
// --------------------------------------------------------------------------

private fun corpusDir(): Path {
  // walking up from src/test/kotlin/.../foundation: ../../../../../tests/vectors
  // but rather than relying on relative paths, locate the repo root by walking
  // upwards looking for `tests/vectors/golden-vector.schema.json`.
  var cursor = Paths.get("").toAbsolutePath()
  repeat(10) {
    val candidate = cursor.resolve("tests").resolve("vectors").resolve("golden-vector.schema.json")
    if (Files.exists(candidate)) {
      return cursor.resolve("tests").resolve("vectors")
    }
    cursor = cursor.parent ?: throw IllegalStateException("could not locate tests/vectors directory")
  }
  throw IllegalStateException("could not locate tests/vectors after 10 hops upward")
}

private val expectedVectorFiles = listOf(
  "link_keys.json",
  "link_secret.json",
  "tier_key_wrap.json",
  "identity.json",
  "content_encrypt.json",
  "shard_envelope.json",
  "auth_challenge.json",
  "auth_keypair.json",
  "account_unlock.json",
  "epoch_derive.json",
  "sealed_bundle.json",
  "manifest_transcript.json",
)

private fun readVector(name: String): String {
  val path = corpusDir().resolve(name)
  if (!Files.exists(path)) {
    throw IllegalStateException("missing corpus file: $path")
  }
  return Files.readString(path)
}

private fun extractStringField(document: String, name: String): String {
  // Minimal JSON field extraction — the JVM-only shell test harness intentionally
  // avoids pulling in a JSON library so the corpus shape check stays pure-Kotlin.
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found in vector document")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  if (cursor >= document.length || document[cursor] != '"') {
    throw IllegalStateException("field `$name` is not a string in vector document")
  }
  cursor++
  val start = cursor
  while (cursor < document.length && document[cursor] != '"') {
    if (document[cursor] == '\\') cursor++
    cursor++
  }
  return document.substring(start, cursor)
}

private fun extractIntegerField(document: String, name: String): Int {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  val start = cursor
  while (cursor < document.length && (document[cursor].isDigit() || document[cursor] == '-')) cursor++
  return document.substring(start, cursor).toInt()
}

private fun extractBooleanField(document: String, name: String): Boolean {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  return when {
    document.startsWith("true", cursor) -> true
    document.startsWith("false", cursor) -> false
    else -> throw IllegalStateException("field `$name` is not a boolean")
  }
}

private fun decodeHex(hex: String): ByteArray {
  if (hex.length % 2 != 0) throw IllegalStateException("invalid hex length")
  val out = ByteArray(hex.length / 2)
  for (i in out.indices) {
    val high = Character.digit(hex[i * 2], 16)
    val low = Character.digit(hex[i * 2 + 1], 16)
    if (high < 0 || low < 0) throw IllegalStateException("invalid hex character at $i")
    out[i] = ((high shl 4) or low).toByte()
  }
  return out
}

// --------------------------------------------------------------------------
// Test bodies
// --------------------------------------------------------------------------

private fun corpusDirectoryExistsAndContainsExpectedFiles() {
  val dir = corpusDir()
  val present = Files.list(dir).use { stream ->
    stream
      .map { it.fileName.toString() }
      .filter { it.endsWith(".json") && it != "golden-vector.schema.json" }
      .toList()
      .toSet()
  }
  for (file in expectedVectorFiles) {
    if (file !in present) throw IllegalStateException("missing $file in $dir")
  }
}

private fun everyCorpusFileDeclaresSchemaEnvelope() {
  for (file in expectedVectorFiles) {
    val document = readVector(file)
    val schemaVersion = extractIntegerField(document, "schemaVersion")
    if (schemaVersion != 1) throw IllegalStateException("$file schemaVersion=$schemaVersion (expected 1)")
    val protocolVersion = extractStringField(document, "protocolVersion")
    if (protocolVersion != "mosaic-v1") {
      throw IllegalStateException("$file protocolVersion=$protocolVersion (expected mosaic-v1)")
    }
    val description = extractStringField(document, "description")
    if (description.isBlank()) throw IllegalStateException("$file has empty description")
    val operation = extractStringField(document, "operation")
    if (operation.isBlank()) throw IllegalStateException("$file has empty operation")
  }
}

private fun manifestTranscriptDeclaresRustCanonical() {
  val document = readVector("manifest_transcript.json")
  if (!extractBooleanField(document, "rust_canonical")) {
    throw IllegalStateException("manifest_transcript.json must declare rust_canonical: true")
  }
}

/**
 * Fake `GeneratedRustHeaderApi` that interprets the supplied envelope bytes
 * by hand using the documented Mosaic shard envelope layout. This keeps the
 * Android shell test harness JVM-only (no Rust dependency) while still
 * covering the cross-client byte-shape mapping path.
 */
private class CorpusBackedGeneratedRustHeaderApi : GeneratedRustHeaderApi {
  override fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult {
    if (bytes.size != 64) {
      return RustHeaderParseFfiResult(
        code = RustHeaderStableCode.INVALID_HEADER_LENGTH,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      )
    }
    val magic = bytes.copyOfRange(0, 4)
    if (!magic.contentEquals(byteArrayOf(0x53, 0x47, 0x7a, 0x6b))) {
      return RustHeaderParseFfiResult(
        code = RustHeaderStableCode.INVALID_MAGIC,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      )
    }
    val version = bytes[4].toInt() and 0xff
    if (version != 0x03) {
      return RustHeaderParseFfiResult(
        code = RustHeaderStableCode.UNSUPPORTED_VERSION,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      )
    }
    val epochId = leU32(bytes, 5)
    val shardIndex = leU32(bytes, 9)
    val nonce = bytes.copyOfRange(13, 37)
    val tier = bytes[37].toInt() and 0xff
    if (tier !in 1..3) {
      return RustHeaderParseFfiResult(
        code = RustHeaderStableCode.INVALID_TIER,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      )
    }
    for (i in 38 until 64) {
      if (bytes[i].toInt() != 0) {
        return RustHeaderParseFfiResult(
          code = RustHeaderStableCode.NON_ZERO_RESERVED_BYTE,
          epochId = 0,
          shardIndex = 0,
          tier = 0,
          nonce = ByteArray(0),
        )
      }
    }
    return RustHeaderParseFfiResult(
      code = RustHeaderStableCode.OK,
      epochId = epochId,
      shardIndex = shardIndex,
      tier = tier,
      nonce = nonce,
    )
  }

  private fun leU32(bytes: ByteArray, offset: Int): Int {
    return (bytes[offset].toInt() and 0xff) or
      ((bytes[offset + 1].toInt() and 0xff) shl 8) or
      ((bytes[offset + 2].toInt() and 0xff) shl 16) or
      ((bytes[offset + 3].toInt() and 0xff) shl 24)
  }
}

private fun shardEnvelopeHeaderBytesParseViaBridgeContract() {
  val document = readVector("shard_envelope.json")
  val tierMatches = Regex("\"envelopeHex\":\\s*\"([0-9a-fA-F]+)\"").findAll(document).toList()
  if (tierMatches.size != 3) {
    throw IllegalStateException("shard_envelope.json must contain 3 tiers, found ${tierMatches.size}")
  }
  val expectedTiers = intArrayOf(1, 2, 3)
  val bridge = GeneratedRustHeaderBridge(CorpusBackedGeneratedRustHeaderApi())
  for ((idx, match) in tierMatches.withIndex()) {
    val envelope = decodeHex(match.groupValues[1])
    if (envelope.size < 64) throw IllegalStateException("envelope $idx too short")
    val header = envelope.copyOfRange(0, 64)
    val parse = bridge.parseEnvelopeHeader(header)
    if (parse.code != HeaderParseCode.SUCCESS) {
      throw IllegalStateException("tier $idx parse code=${parse.code} (expected SUCCESS)")
    }
    val parsed = parse.parsed ?: throw IllegalStateException("tier $idx missing parsed payload")
    if (parsed.tier != expectedTiers[idx]) {
      throw IllegalStateException("tier $idx tier=${parsed.tier} (expected ${expectedTiers[idx]})")
    }
    if (parsed.nonce.size != 24) {
      throw IllegalStateException("tier $idx nonce length=${parsed.nonce.size}")
    }
  }
}

private fun deferred(message: String): Nothing = throw SkipException(message)

private fun linkKeysIsDeferredToSliceZeroC() {
  // Sanity-check the corpus document survives parsing.
  readVector("link_keys.json")
  deferred("TODO Slice 0C: the Android shell does not yet bridge link-key derivation.")
}

private fun identityIsDeferredToSliceZeroC() {
  readVector("identity.json")
  deferred("TODO Slice 0C: identity bridge wires create/open via account handle, not raw seed bytes.")
}

private fun contentEncryptIsDeferredToSliceZeroC() {
  readVector("content_encrypt.json")
  deferred("TODO Slice 0C: shell has no raw-key content decrypt bridge; current API expects an open epoch handle.")
}

private fun authChallengeIsDeferredToSliceZeroC() {
  readVector("auth_challenge.json")
  deferred("TODO Slice 0C: shell does not yet expose signAuthChallenge / verifyAuthChallenge bridges.")
}

private fun sealedBundleIsDeferredToSliceZeroC() {
  readVector("sealed_bundle.json")
  deferred("TODO Slice 0C: shell does not yet expose verifyAndOpenBundle bridge.")
}

private fun tierKeyWrapIsLockedUnderDeviation() {
  readVector("tier_key_wrap.json")
  deferred("deviation:tier-key-wrap — see tests/vectors/deviations.md; closure planned post-Slice 0B.")
}

private fun authKeypairIsLockedUnderDeviation() {
  readVector("auth_keypair.json")
  deferred("deviation:auth-keypair — see tests/vectors/deviations.md; closure planned post-Slice 0B.")
}

private fun accountUnlockIsLockedUnderDeviation() {
  readVector("account_unlock.json")
  deferred("deviation:account-unlock — see tests/vectors/deviations.md; closure planned post-Slice 0B.")
}

private fun epochDeriveIsLockedUnderDeviation() {
  readVector("epoch_derive.json")
  deferred("deviation:epoch-tier-keys — see tests/vectors/deviations.md; closure planned post-Slice 0B.")
}
