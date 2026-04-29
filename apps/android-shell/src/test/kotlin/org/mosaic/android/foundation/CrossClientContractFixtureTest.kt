package org.mosaic.android.foundation

import java.nio.file.Files
import java.nio.file.Paths

/**
 * Verifies that the Kotlin shell's stable-code constants and protocol invariants
 * match the cross-client contract fixture at
 * `tests/contracts/android-rust-bridges-cross-client.json`.
 *
 * The fixture is the cross-language source of truth — Rust core, Kotlin shell,
 * and Android module must all agree on these values. This test exists so any
 * silent drift on the Kotlin side fails CI before it reaches a customer.
 */

private data class CrossClientCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    CrossClientCase("contract version is the supported one", ::contractVersionMatches),
    CrossClientCase("protocol version constant matches", ::protocolVersionMatches),
    CrossClientCase("shard envelope tier constants match", ::shardEnvelopeTiersMatch),
    CrossClientCase("KDF bounds match Rust core", ::kdfBoundsMatch),
    CrossClientCase("header stable codes match", ::headerStableCodesMatch),
    CrossClientCase("identity stable codes match", ::identityStableCodesMatch),
    CrossClientCase("epoch stable codes match", ::epochStableCodesMatch),
    CrossClientCase("media plan stable codes match", ::mediaPlanStableCodesMatch),
    CrossClientCase("media inspection stable codes match", ::mediaInspectionStableCodesMatch),
    CrossClientCase("metadata sidecar stable codes match", ::metadataSidecarStableCodesMatch),
    CrossClientCase("shard stable codes match", ::shardStableCodesMatch),
    CrossClientCase("client-core sync stable codes match", ::clientCoreSyncStableCodesMatch),
    CrossClientCase("client-core upload stable codes match", ::clientCoreUploadStableCodesMatch),
    CrossClientCase("nonce length constant matches", ::nonceLengthMatches),
  )

  var failed = 0
  for (test in tests) {
    try {
      test.body()
      println("PASS ${test.name}")
    } catch (error: Throwable) {
      failed += 1
      println("FAIL ${test.name}: ${error.message}")
    }
  }
  if (failed > 0) {
    throw IllegalStateException("$failed cross-client contract tests failed")
  }
  println("PASS ${tests.size} cross-client contract tests")
}

private val FIXTURE_PATH = listOf(
  "tests/contracts/android-rust-bridges-cross-client.json",
  "../tests/contracts/android-rust-bridges-cross-client.json",
  "../../tests/contracts/android-rust-bridges-cross-client.json",
)

private val fixture: String by lazy {
  val candidates = FIXTURE_PATH.map { Paths.get(it).toAbsolutePath() }
  val path = candidates.firstOrNull { Files.exists(it) }
    ?: throw IllegalStateException("fixture not found at any of: $candidates")
  Files.readString(path)
}

private fun fixtureField(path: String): String {
  // Minimal nested-key extractor for `"a.b.c"` style addresses. Avoids pulling
  // in a JSON parser dep just for cross-client fixture lookup.
  val keys = path.split(".")
  var remaining = fixture
  for ((i, key) in keys.withIndex()) {
    val needle = "\"$key\""
    val keyIdx = remaining.indexOf(needle)
    if (keyIdx < 0) throw IllegalStateException("fixture missing key: $path (failed at '$key')")
    val colon = remaining.indexOf(":", keyIdx)
    val valueStart = colon + 1
    val openBrace = remaining.indexOf("{", valueStart)
    val openBracket = remaining.indexOf("[", valueStart)
    val openQuote = remaining.indexOf("\"", valueStart)
    val firstNonSpace = remaining.indexOfFirst(valueStart) { !it.isWhitespace() }
    if (firstNonSpace < 0) throw IllegalStateException("malformed fixture at $path")
    val ch = remaining[firstNonSpace]
    when {
      ch == '{' && i < keys.size - 1 -> {
        val end = matchBraces(remaining, firstNonSpace, '{', '}')
        remaining = remaining.substring(firstNonSpace, end + 1)
      }
      ch == '[' -> return remaining.substring(firstNonSpace, matchBraces(remaining, firstNonSpace, '[', ']') + 1)
      ch == '"' -> {
        val close = remaining.indexOf("\"", firstNonSpace + 1)
        return remaining.substring(firstNonSpace + 1, close)
      }
      ch == 't' || ch == 'f' -> {
        val end = remaining.indexOfAny(charArrayOf(',', '}', '\n'), firstNonSpace)
        return remaining.substring(firstNonSpace, end).trim()
      }
      ch.isDigit() || ch == '-' -> {
        val end = remaining.indexOfAny(charArrayOf(',', '}', '\n'), firstNonSpace)
        return remaining.substring(firstNonSpace, end).trim()
      }
      else -> throw IllegalStateException("unexpected fixture value char '$ch' at $path")
    }
  }
  throw IllegalStateException("path traversal exhausted without value: $path")
}

private fun String.indexOfFirst(start: Int, predicate: (Char) -> Boolean): Int {
  for (i in start until length) {
    if (predicate(this[i])) return i
  }
  return -1
}

private fun matchBraces(text: String, start: Int, open: Char, close: Char): Int {
  var depth = 0
  for (i in start until text.length) {
    when (text[i]) {
      open -> depth++
      close -> {
        depth--
        if (depth == 0) return i
      }
    }
  }
  throw IllegalStateException("unbalanced $open$close starting at $start")
}

private fun assertEquals(expected: Any, actual: Any, message: String = "") {
  if (expected.toString() != actual.toString()) {
    throw IllegalStateException("$message expected=$expected actual=$actual")
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

private fun contractVersionMatches() {
  assertEquals("1", fixtureField("contractVersion"))
}

private fun protocolVersionMatches() {
  assertEquals("mosaic-v1", fixtureField("protocolVersion"))
}

private fun shardEnvelopeTiersMatch() {
  assertEquals("1", fixtureField("shardEnvelope.tiers.thumbnail"))
  assertEquals("2", fixtureField("shardEnvelope.tiers.preview"))
  assertEquals("3", fixtureField("shardEnvelope.tiers.original"))
  assertEquals("64", fixtureField("shardEnvelope.headerLength"))
  assertEquals("\"SGzk\"".substring(1, 5), fixtureField("shardEnvelope.magic"))
}

private fun kdfBoundsMatch() {
  assertEquals(KdfProfile.MAX_MEMORY_KIB.toString(), fixtureField("kdfProfileBounds.maxMemoryKib"))
  assertEquals(KdfProfile.MAX_ITERATIONS.toString(), fixtureField("kdfProfileBounds.maxIterations"))
  assertEquals(KdfProfile.MAX_PARALLELISM.toString(), fixtureField("kdfProfileBounds.maxParallelism"))
}

private fun headerStableCodesMatch() {
  assertEquals(RustHeaderStableCode.INVALID_HEADER_LENGTH.toString(), fixtureField("stableCodes.header.INVALID_HEADER_LENGTH"))
  assertEquals(RustHeaderStableCode.INVALID_MAGIC.toString(), fixtureField("stableCodes.header.INVALID_MAGIC"))
  assertEquals(RustHeaderStableCode.UNSUPPORTED_VERSION.toString(), fixtureField("stableCodes.header.UNSUPPORTED_VERSION"))
  assertEquals(RustHeaderStableCode.INVALID_TIER.toString(), fixtureField("stableCodes.header.INVALID_TIER"))
  assertEquals(RustHeaderStableCode.NON_ZERO_RESERVED_BYTE.toString(), fixtureField("stableCodes.header.NON_ZERO_RESERVED_BYTE"))
}

private fun identityStableCodesMatch() {
  assertEquals(RustIdentityStableCode.INVALID_KEY_LENGTH.toString(), fixtureField("stableCodes.crypto.INVALID_KEY_LENGTH"))
  assertEquals(RustIdentityStableCode.AUTHENTICATION_FAILED.toString(), fixtureField("stableCodes.crypto.AUTHENTICATION_FAILED"))
  assertEquals(RustIdentityStableCode.INVALID_SIGNATURE_LENGTH.toString(), fixtureField("stableCodes.crypto.INVALID_SIGNATURE_LENGTH"))
  assertEquals(RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND.toString(), fixtureField("stableCodes.handles.IDENTITY_HANDLE_NOT_FOUND"))
  assertEquals(RustIdentityStableCode.HANDLE_SPACE_EXHAUSTED.toString(), fixtureField("stableCodes.handles.HANDLE_SPACE_EXHAUSTED"))
}

private fun epochStableCodesMatch() {
  assertEquals(RustEpochStableCode.WRAPPED_KEY_TOO_SHORT.toString(), fixtureField("stableCodes.crypto.WRAPPED_KEY_TOO_SHORT"))
  assertEquals(RustEpochStableCode.EPOCH_HANDLE_NOT_FOUND.toString(), fixtureField("stableCodes.handles.EPOCH_HANDLE_NOT_FOUND"))
}

private fun mediaPlanStableCodesMatch() {
  assertEquals(RustMediaPlanStableCode.DEFERRED.toString(), fixtureField("stableCodes.media.DEFERRED"))
  assertEquals(RustMediaPlanStableCode.UNSUPPORTED.toString(), fixtureField("stableCodes.media.UNSUPPORTED"))
}

private fun mediaInspectionStableCodesMatch() {
  assertEquals(RustMediaInspectionStableCode.UNSUPPORTED_MEDIA_FORMAT.toString(), fixtureField("stableCodes.media.UNSUPPORTED_MEDIA_FORMAT"))
  assertEquals(RustMediaInspectionStableCode.INVALID_MEDIA_CONTAINER.toString(), fixtureField("stableCodes.media.INVALID_MEDIA_CONTAINER"))
  assertEquals(RustMediaInspectionStableCode.INVALID_MEDIA_DIMENSIONS.toString(), fixtureField("stableCodes.media.INVALID_MEDIA_DIMENSIONS"))
}

private fun metadataSidecarStableCodesMatch() {
  assertEquals(RustMetadataSidecarStableCode.MEDIA_METADATA_MISMATCH.toString(), fixtureField("stableCodes.media.MEDIA_METADATA_MISMATCH"))
  assertEquals(RustMetadataSidecarStableCode.INVALID_MEDIA_SIDECAR.toString(), fixtureField("stableCodes.media.INVALID_MEDIA_SIDECAR"))
}

private fun shardStableCodesMatch() {
  assertEquals(RustShardStableCode.INVALID_ENVELOPE.toString(), fixtureField("stableCodes.crypto.INVALID_ENVELOPE"))
  assertEquals(RustShardStableCode.MISSING_CIPHERTEXT.toString(), fixtureField("stableCodes.crypto.MISSING_CIPHERTEXT"))
  assertEquals(RustShardStableCode.AUTHENTICATION_FAILED.toString(), fixtureField("stableCodes.crypto.AUTHENTICATION_FAILED"))
}

private fun clientCoreSyncStableCodesMatch() {
  assertEquals(RustClientCoreSyncStableCode.CLIENT_CORE_INVALID_TRANSITION.toString(), fixtureField("stableCodes.clientCore.INVALID_TRANSITION"))
  assertEquals(RustClientCoreSyncStableCode.CLIENT_CORE_RETRY_BUDGET_EXHAUSTED.toString(), fixtureField("stableCodes.clientCore.RETRY_BUDGET_EXHAUSTED"))
  assertEquals(RustClientCoreSyncStableCode.CLIENT_CORE_SYNC_PAGE_DID_NOT_ADVANCE.toString(), fixtureField("stableCodes.clientCore.SYNC_PAGE_DID_NOT_ADVANCE"))
}

private fun clientCoreUploadStableCodesMatch() {
  assertEquals(RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_TRANSITION.toString(), fixtureField("stableCodes.clientCore.INVALID_TRANSITION"))
  assertEquals(RustClientCoreUploadStableCode.CLIENT_CORE_MISSING_EVENT_PAYLOAD.toString(), fixtureField("stableCodes.clientCore.MISSING_EVENT_PAYLOAD"))
}

private fun nonceLengthMatches() {
  assertEquals(ParsedShardEnvelopeHeader.NONCE_LENGTH.toString(), fixtureField("shardEnvelope.nonceLength"))
}
