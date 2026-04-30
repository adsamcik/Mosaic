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
    CrossClientTestCase("link_keys.json byte-equality flows through GeneratedRustLinkKeysBridge", ::linkKeysIsDeferredToSliceZeroC),
    CrossClientTestCase("identity.json byte-equality flows through GeneratedRustIdentitySeedBridge", ::identityIsDeferredToSliceZeroC),
    CrossClientTestCase("content_encrypt.json byte-equality flows through GeneratedRustContentBridge", ::contentEncryptIsDeferredToSliceZeroC),
    CrossClientTestCase("auth_challenge.json byte-equality flows through GeneratedRustAuthChallengeBridge", ::authChallengeIsDeferredToSliceZeroC),
    CrossClientTestCase("sealed_bundle.json byte-equality flows through GeneratedRustSealedBundleBridge", ::sealedBundleIsDeferredToSliceZeroC),
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

// --------------------------------------------------------------------------
// Slice 0C — Fake APIs for bridge contract validation
//
// These Fakes return the canned vector outputs so the shell-side bridges
// can be exercised against the corpus byte-shape (sizes, codes, redaction)
// without needing a real Rust core. Actual byte-equality against the Rust
// core is proven by the round-trip tests in `apps/android-main` which
// drive the host-built `mosaic_uniffi` cdylib via JNA.
// --------------------------------------------------------------------------

private class CannedLinkKeysApi(
  private val expectedLinkSecret: ByteArray,
  private val cannedLinkId: ByteArray,
  private val cannedWrappingKey: ByteArray,
) : GeneratedRustLinkKeysApi {
  override fun deriveLinkKeysFromRawSecret(linkSecret: ByteArray): RustLinkKeysFfiResult {
    if (linkSecret.size != 32) {
      return RustLinkKeysFfiResult(
        code = RustLinkKeysStableCode.INVALID_KEY_LENGTH,
        linkId = ByteArray(0),
        wrappingKey = ByteArray(0),
      )
    }
    if (!linkSecret.contentEquals(expectedLinkSecret)) {
      throw IllegalStateException("CannedLinkKeysApi got unexpected link_secret")
    }
    return RustLinkKeysFfiResult(
      code = RustLinkKeysStableCode.OK,
      linkId = cannedLinkId.copyOf(),
      wrappingKey = cannedWrappingKey.copyOf(),
    )
  }
}

private fun linkKeysIsDeferredToSliceZeroC() {
  val document = readVector("link_keys.json")
  val linkSecret = decodeHex(extractStringField(document, "linkSecretHex"))
  val expectedLinkId = decodeHex(extractStringField(document, "linkIdHex"))
  val expectedWrappingKey = decodeHex(extractStringField(document, "wrappingKeyHex"))

  val bridge = GeneratedRustLinkKeysBridge(
    CannedLinkKeysApi(linkSecret, expectedLinkId, expectedWrappingKey),
  )
  val result = bridge.deriveLinkKeys(linkSecret)
  if (result.code != LinkKeysCode.SUCCESS) {
    throw IllegalStateException("link_keys derive code=${result.code} (expected SUCCESS)")
  }
  if (!result.linkId.contentEquals(expectedLinkId)) {
    throw IllegalStateException("link_keys link_id mismatch")
  }
  if (!result.wrappingKey.contentEquals(expectedWrappingKey)) {
    throw IllegalStateException("link_keys wrapping_key mismatch")
  }

  val rendered = result.toString()
  if (rendered.contains(extractStringField(document, "linkSecretHex"))) {
    throw IllegalStateException("link_keys toString must not leak link_secret hex")
  }
  if (rendered.contains(extractStringField(document, "wrappingKeyHex"))) {
    throw IllegalStateException("link_keys toString must not leak wrapping_key hex")
  }

  val short = bridge.deriveLinkKeys(ByteArray(31))
  if (short.code != LinkKeysCode.INVALID_KEY_LENGTH) {
    throw IllegalStateException("short link_secret should map to INVALID_KEY_LENGTH, got ${short.code}")
  }
}

private class CannedIdentitySeedApi(
  private val expectedSeed: ByteArray,
  private val expectedMessage: ByteArray,
  private val signingPubkey: ByteArray,
  private val encryptionPubkey: ByteArray,
  private val signature: ByteArray,
) : GeneratedRustIdentitySeedApi {
  override fun deriveIdentityFromRawSeed(identitySeed: ByteArray, message: ByteArray): RustIdentitySeedFfiResult {
    if (identitySeed.size != 32) {
      return RustIdentitySeedFfiResult(
        code = RustIdentitySeedStableCode.INVALID_KEY_LENGTH,
        signingPubkey = ByteArray(0),
        encryptionPubkey = ByteArray(0),
        signature = ByteArray(0),
      )
    }
    if (!identitySeed.contentEquals(expectedSeed)) {
      throw IllegalStateException("CannedIdentitySeedApi got unexpected seed")
    }
    if (!message.contentEquals(expectedMessage)) {
      throw IllegalStateException("CannedIdentitySeedApi got unexpected message")
    }
    return RustIdentitySeedFfiResult(
      code = RustIdentitySeedStableCode.OK,
      signingPubkey = signingPubkey.copyOf(),
      encryptionPubkey = encryptionPubkey.copyOf(),
      signature = signature.copyOf(),
    )
  }
}

private fun identityIsDeferredToSliceZeroC() {
  val document = readVector("identity.json")
  val seed = decodeHex(extractStringField(document, "identitySeedHex"))
  val message = decodeHex(extractStringField(document, "identityMessageHex"))
  val expectedSigningPubkey = decodeHex(extractStringField(document, "signingPubkeyHex"))
  val expectedEncryptionPubkey = decodeHex(extractStringField(document, "encryptionPubkeyHex"))
  val expectedSignature = decodeHex(extractStringField(document, "signatureHex"))

  val bridge = GeneratedRustIdentitySeedBridge(
    CannedIdentitySeedApi(seed, message, expectedSigningPubkey, expectedEncryptionPubkey, expectedSignature),
  )
  val result = bridge.deriveFromSeed(seed, message)
  if (result.code != IdentityFromSeedCode.SUCCESS) {
    throw IllegalStateException("identity derive code=${result.code} (expected SUCCESS)")
  }
  if (!result.signingPubkey.contentEquals(expectedSigningPubkey)) {
    throw IllegalStateException("identity signing_pubkey mismatch")
  }
  if (!result.encryptionPubkey.contentEquals(expectedEncryptionPubkey)) {
    throw IllegalStateException("identity encryption_pubkey mismatch")
  }
  if (!result.signature.contentEquals(expectedSignature)) {
    throw IllegalStateException("identity signature mismatch")
  }

  val rendered = result.toString()
  if (rendered.contains(extractStringField(document, "identitySeedHex"))) {
    throw IllegalStateException("identity toString must not leak seed hex")
  }

  val short = bridge.deriveFromSeed(ByteArray(31), message)
  if (short.code != IdentityFromSeedCode.INVALID_KEY_LENGTH) {
    throw IllegalStateException("short identity_seed should map to INVALID_KEY_LENGTH, got ${short.code}")
  }
}

private class CannedContentApi(
  private val expectedKey: ByteArray,
  private val expectedNonce: ByteArray,
  private val expectedCiphertext: ByteArray,
  private val expectedEpochId: Int,
  private val plaintextOutput: ByteArray,
) : GeneratedRustContentApi {
  override fun decryptContentWithRawKey(
    contentKey: ByteArray,
    nonce: ByteArray,
    ciphertext: ByteArray,
    epochId: Int,
  ): RustContentDecryptFfiResult {
    if (contentKey.size != 32) {
      return RustContentDecryptFfiResult(
        code = RustContentDecryptStableCode.INVALID_KEY_LENGTH,
        plaintext = ByteArray(0),
      )
    }
    if (nonce.size != 24) {
      return RustContentDecryptFfiResult(
        code = RustContentDecryptStableCode.INVALID_INPUT_LENGTH,
        plaintext = ByteArray(0),
      )
    }
    if (!contentKey.contentEquals(expectedKey) ||
      !nonce.contentEquals(expectedNonce) ||
      !ciphertext.contentEquals(expectedCiphertext) ||
      epochId != expectedEpochId
    ) {
      return RustContentDecryptFfiResult(
        code = RustContentDecryptStableCode.AUTHENTICATION_FAILED,
        plaintext = ByteArray(0),
      )
    }
    return RustContentDecryptFfiResult(
      code = RustContentDecryptStableCode.OK,
      plaintext = plaintextOutput.copyOf(),
    )
  }
}

private fun contentEncryptIsDeferredToSliceZeroC() {
  val document = readVector("content_encrypt.json")
  val contentKey = decodeHex(extractStringField(document, "contentKeyHex"))
  val nonce = decodeHex(extractStringField(document, "nonceHex"))
  val expectedCiphertext = decodeHex(extractStringField(document, "ciphertextHex"))
  val expectedDecrypted = decodeHex(extractStringField(document, "decryptedHex"))
  val epochId = extractIntegerField(document, "epochId")

  val bridge = GeneratedRustContentBridge(
    CannedContentApi(contentKey, nonce, expectedCiphertext, epochId, expectedDecrypted),
  )

  val result = bridge.decrypt(contentKey, nonce, expectedCiphertext, epochId)
  if (result.code != ContentDecryptCode.SUCCESS) {
    throw IllegalStateException("content decrypt code=${result.code} (expected SUCCESS)")
  }
  if (!result.plaintext.contentEquals(expectedDecrypted)) {
    throw IllegalStateException("content decrypt plaintext mismatch")
  }

  val rendered = result.toString()
  if (rendered.contains(extractStringField(document, "decryptedHex"))) {
    throw IllegalStateException("content decrypt toString must not leak plaintext hex")
  }

  val wrongEpoch = bridge.decrypt(contentKey, nonce, expectedCiphertext, epochId + 1)
  if (wrongEpoch.code != ContentDecryptCode.AUTHENTICATION_FAILED) {
    throw IllegalStateException("wrong epoch_id should map to AUTHENTICATION_FAILED, got ${wrongEpoch.code}")
  }

  val tampered = expectedCiphertext.copyOf()
  tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
  val tamperedResult = bridge.decrypt(contentKey, nonce, tampered, epochId)
  if (tamperedResult.code != ContentDecryptCode.AUTHENTICATION_FAILED) {
    throw IllegalStateException("tampered ciphertext should map to AUTHENTICATION_FAILED, got ${tamperedResult.code}")
  }
}

private class CannedAuthChallengeApi(
  private val expectedUsername: String,
  private val expectedChallenge: ByteArray,
  private val expectedTimestampMs: Long,
  private val expectedSeed: ByteArray,
  private val expectedPubkey: ByteArray,
  private val transcriptNoTs: ByteArray,
  private val transcriptWithTs: ByteArray,
  private val signatureNoTs: ByteArray,
  private val signatureWithTs: ByteArray,
) : GeneratedRustAuthChallengeApi {
  override fun buildAuthChallengeTranscriptBytes(
    username: String,
    timestampMs: Long,
    challenge: ByteArray,
  ): RustBytesFfiResult {
    if (username != expectedUsername || !challenge.contentEquals(expectedChallenge)) {
      throw IllegalStateException("CannedAuthChallengeApi got unexpected build args")
    }
    val bytes = if (timestampMs < 0) transcriptNoTs.copyOf() else {
      if (timestampMs != expectedTimestampMs) {
        throw IllegalStateException("CannedAuthChallengeApi got unexpected timestampMs")
      }
      transcriptWithTs.copyOf()
    }
    return RustBytesFfiResult(code = RustAuthChallengeStableCode.OK, bytes = bytes)
  }

  override fun signAuthChallengeWithRawSeed(
    transcript: ByteArray,
    authSigningSeed: ByteArray,
  ): RustBytesFfiResult {
    if (authSigningSeed.size != 32) {
      return RustBytesFfiResult(code = RustAuthChallengeStableCode.INVALID_KEY_LENGTH, bytes = ByteArray(0))
    }
    if (!authSigningSeed.contentEquals(expectedSeed)) {
      throw IllegalStateException("CannedAuthChallengeApi got unexpected seed")
    }
    val bytes = when {
      transcript.contentEquals(transcriptNoTs) -> signatureNoTs.copyOf()
      transcript.contentEquals(transcriptWithTs) -> signatureWithTs.copyOf()
      else -> throw IllegalStateException("CannedAuthChallengeApi got unrecognized transcript")
    }
    return RustBytesFfiResult(code = RustAuthChallengeStableCode.OK, bytes = bytes)
  }

  override fun verifyAuthChallengeSignature(
    transcript: ByteArray,
    signature: ByteArray,
    authPublicKey: ByteArray,
  ): RustAuthChallengeVerifyFfiResult {
    if (signature.size != 64) {
      return RustAuthChallengeVerifyFfiResult(
        code = RustAuthChallengeStableCode.INVALID_SIGNATURE_LENGTH,
        valid = false,
      )
    }
    if (authPublicKey.size != 32) {
      return RustAuthChallengeVerifyFfiResult(
        code = RustAuthChallengeStableCode.INVALID_PUBLIC_KEY,
        valid = false,
      )
    }
    val matchesNoTs = transcript.contentEquals(transcriptNoTs) && signature.contentEquals(signatureNoTs)
    val matchesWithTs = transcript.contentEquals(transcriptWithTs) && signature.contentEquals(signatureWithTs)
    val pubkeyOk = authPublicKey.contentEquals(expectedPubkey)
    return if ((matchesNoTs || matchesWithTs) && pubkeyOk) {
      RustAuthChallengeVerifyFfiResult(code = RustAuthChallengeStableCode.OK, valid = true)
    } else {
      RustAuthChallengeVerifyFfiResult(
        code = RustAuthChallengeStableCode.AUTHENTICATION_FAILED,
        valid = false,
      )
    }
  }
}

private fun authChallengeIsDeferredToSliceZeroC() {
  val document = readVector("auth_challenge.json")
  val seed = decodeHex(extractStringField(document, "authSigningSeedHex"))
  val pubkey = decodeHex(extractStringField(document, "authPublicKeyHex"))
  val username = extractStringField(document, "username")
  val challenge = decodeHex(extractStringField(document, "challengeHex"))
  val timestampMs = extractLongField(document, "timestampMs")
  val transcriptNoTs = decodeHex(extractStringField(document, "transcriptNoTimestampHex"))
  val transcriptWithTs = decodeHex(extractStringField(document, "transcriptWithTimestampHex"))
  val sigNoTs = decodeHex(extractStringField(document, "signatureNoTimestampHex"))
  val sigWithTs = decodeHex(extractStringField(document, "signatureWithTimestampHex"))

  val bridge = GeneratedRustAuthChallengeBridge(
    CannedAuthChallengeApi(
      username, challenge, timestampMs, seed, pubkey,
      transcriptNoTs, transcriptWithTs, sigNoTs, sigWithTs,
    ),
  )

  // Build transcript (no timestamp)
  val builtNoTs = bridge.buildTranscript(username, null, challenge)
  if (builtNoTs.code != AuthChallengeTranscriptCode.SUCCESS) {
    throw IllegalStateException("transcript build (no ts) code=${builtNoTs.code}")
  }
  if (!builtNoTs.transcript.contentEquals(transcriptNoTs)) {
    throw IllegalStateException("transcript no-ts mismatch")
  }

  // Build transcript (with timestamp)
  val builtWithTs = bridge.buildTranscript(username, timestampMs, challenge)
  if (!builtWithTs.transcript.contentEquals(transcriptWithTs)) {
    throw IllegalStateException("transcript with-ts mismatch")
  }

  // Sign (no timestamp)
  val signed = bridge.sign(transcriptNoTs, seed)
  if (signed.code != AuthChallengeSignCode.SUCCESS) {
    throw IllegalStateException("sign (no ts) code=${signed.code}")
  }
  if (!signed.signature.contentEquals(sigNoTs)) {
    throw IllegalStateException("signature no-ts mismatch")
  }

  // Sign (with timestamp)
  val signedTs = bridge.sign(transcriptWithTs, seed)
  if (!signedTs.signature.contentEquals(sigWithTs)) {
    throw IllegalStateException("signature with-ts mismatch")
  }

  // Verify SUCCESS
  val verifyOk = bridge.verify(transcriptNoTs, sigNoTs, pubkey)
  if (verifyOk.code != AuthChallengeVerifyCode.SUCCESS || !verifyOk.valid) {
    throw IllegalStateException("verify SUCCESS expected, got ${verifyOk.code} valid=${verifyOk.valid}")
  }

  // Verify FAIL: wrong public key (flip first byte)
  val flippedPubkey = pubkey.copyOf()
  flippedPubkey[0] = (flippedPubkey[0].toInt() xor 0x01).toByte()
  val verifyFail = bridge.verify(transcriptNoTs, sigNoTs, flippedPubkey)
  if (verifyFail.code != AuthChallengeVerifyCode.AUTHENTICATION_FAILED) {
    throw IllegalStateException("flipped pubkey should map to AUTHENTICATION_FAILED, got ${verifyFail.code}")
  }

  // Verify FAIL: tampered challenge transcript
  val tampered = transcriptNoTs.copyOf()
  tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
  val tamperedResult = bridge.verify(tampered, sigNoTs, pubkey)
  if (tamperedResult.code != AuthChallengeVerifyCode.AUTHENTICATION_FAILED) {
    throw IllegalStateException("tampered challenge should map to AUTHENTICATION_FAILED, got ${tamperedResult.code}")
  }
}

private class CannedSealedBundleApi(
  private val expectedSeed: ByteArray,
  private val expectedSealed: ByteArray,
  private val expectedSignature: ByteArray,
  private val expectedSharer: ByteArray,
  private val expectedOwner: ByteArray,
  private val cannedAlbumId: String,
  private val cannedEpochId: Int,
  private val cannedRecipient: ByteArray,
  private val cannedEpochSeed: ByteArray,
  private val cannedSignPub: ByteArray,
) : GeneratedRustSealedBundleApi {
  @Suppress("LongParameterList")
  override fun verifyAndOpenBundleWithRecipientSeed(
    recipientIdentitySeed: ByteArray,
    sealed: ByteArray,
    signature: ByteArray,
    sharerPubkey: ByteArray,
    expectedOwnerPubkey: ByteArray,
    expectedAlbumId: String,
    expectedMinEpochId: Int,
    allowLegacyEmptyAlbumId: Boolean,
  ): RustOpenedBundleFfiResult {
    if (recipientIdentitySeed.size != 32) {
      return errorResult(RustSealedBundleStableCode.INVALID_KEY_LENGTH)
    }
    if (signature.size != 64) {
      return errorResult(RustSealedBundleStableCode.INVALID_SIGNATURE_LENGTH)
    }
    if (sharerPubkey.size != 32 || expectedOwnerPubkey.size != 32) {
      return errorResult(RustSealedBundleStableCode.INVALID_KEY_LENGTH)
    }
    if (!sharerPubkey.contentEquals(expectedOwnerPubkey)) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_SIGNATURE_INVALID)
    }
    if (!signature.contentEquals(expectedSignature)) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_SIGNATURE_INVALID)
    }
    if (!sealed.contentEquals(expectedSealed)) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_SIGNATURE_INVALID)
    }
    if (!recipientIdentitySeed.contentEquals(expectedSeed)) {
      throw IllegalStateException("CannedSealedBundleApi got unexpected recipient seed")
    }
    if (!sharerPubkey.contentEquals(expectedSharer) || !expectedOwnerPubkey.contentEquals(expectedOwner)) {
      throw IllegalStateException("CannedSealedBundleApi got unexpected sharer/owner")
    }
    if (expectedAlbumId.isEmpty() && !allowLegacyEmptyAlbumId) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_ALBUM_ID_EMPTY)
    }
    if (expectedAlbumId.isNotEmpty() && expectedAlbumId != cannedAlbumId) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_ALBUM_ID_MISMATCH)
    }
    if (expectedMinEpochId > cannedEpochId) {
      return errorResult(RustSealedBundleStableCode.BUNDLE_EPOCH_TOO_OLD)
    }
    return RustOpenedBundleFfiResult(
      code = RustSealedBundleStableCode.OK,
      version = 1,
      albumId = cannedAlbumId,
      epochId = cannedEpochId,
      recipientPubkey = cannedRecipient.copyOf(),
      epochSeed = cannedEpochSeed.copyOf(),
      signPublicKey = cannedSignPub.copyOf(),
    )
  }

  private fun errorResult(code: Int) = RustOpenedBundleFfiResult(
    code = code,
    version = 0,
    albumId = "",
    epochId = 0,
    recipientPubkey = ByteArray(0),
    epochSeed = ByteArray(0),
    signPublicKey = ByteArray(0),
  )
}

private fun sealedBundleIsDeferredToSliceZeroC() {
  val document = readVector("sealed_bundle.json")
  val sealed = decodeHex(extractStringField(document, "sealedHex"))
  val signature = decodeHex(extractStringField(document, "signatureHex"))
  val sharer = decodeHex(extractStringField(document, "sharerPubkeyHex"))
  val owner = decodeHex(extractStringField(document, "expectedOwnerEd25519PubHex"))
  val recipientSeed = decodeHex(extractStringField(document, "recipientIdentitySeedHex"))
  val expectedAlbumId = extractStringField(document, "albumId")
  val expectedRecipientPubkey = decodeHex(extractStringField(document, "bundleRecipientPubkeyHex"))
  val expectedEpochSeed = decodeHex(extractStringField(document, "bundleEpochSeedHex"))
  val expectedSignPubkey = decodeHex(extractStringField(document, "bundleSignPublicKeyHex"))
  val expectedEpochId = extractIntegerField(document, "bundleEpochId")
  val minEpochId = extractIntegerField(document, "minEpochId")

  val bridge = GeneratedRustSealedBundleBridge(
    CannedSealedBundleApi(
      recipientSeed, sealed, signature, sharer, owner,
      expectedAlbumId, expectedEpochId,
      expectedRecipientPubkey, expectedEpochSeed, expectedSignPubkey,
    ),
  )

  // Happy-path verify-and-open
  val ok = bridge.verifyAndOpen(
    recipientSeed, sealed, signature, sharer, owner,
    expectedAlbumId, minEpochId, false,
  )
  if (ok.code != OpenedBundleCode.SUCCESS) {
    throw IllegalStateException("sealed_bundle open code=${ok.code} (expected SUCCESS)")
  }
  if (ok.albumId != expectedAlbumId) {
    throw IllegalStateException("sealed_bundle albumId mismatch")
  }
  if (ok.epochId != expectedEpochId) {
    throw IllegalStateException("sealed_bundle epochId mismatch")
  }
  if (!ok.recipientPubkey.contentEquals(expectedRecipientPubkey)) {
    throw IllegalStateException("sealed_bundle recipient_pubkey mismatch")
  }
  if (!ok.epochSeed.contentEquals(expectedEpochSeed)) {
    throw IllegalStateException("sealed_bundle epoch_seed mismatch")
  }
  if (!ok.signPublicKey.contentEquals(expectedSignPubkey)) {
    throw IllegalStateException("sealed_bundle sign_public_key mismatch")
  }

  val rendered = ok.toString()
  if (rendered.contains(extractStringField(document, "bundleEpochSeedHex"))) {
    throw IllegalStateException("sealed_bundle toString must not leak epoch_seed hex")
  }

  // Negative case: wrong owner pubkey → BUNDLE_SIGNATURE_INVALID
  val flippedOwner = owner.copyOf()
  flippedOwner[0] = (flippedOwner[0].toInt() xor 0x01).toByte()
  val wrongOwner = bridge.verifyAndOpen(
    recipientSeed, sealed, signature, sharer, flippedOwner,
    expectedAlbumId, minEpochId, false,
  )
  if (wrongOwner.code != OpenedBundleCode.BUNDLE_SIGNATURE_INVALID) {
    throw IllegalStateException("wrong-owner-pubkey expected BUNDLE_SIGNATURE_INVALID, got ${wrongOwner.code}")
  }

  // Negative case: tampered signature
  val flippedSig = signature.copyOf()
  flippedSig[0] = (flippedSig[0].toInt() xor 0x01).toByte()
  val tamperedSig = bridge.verifyAndOpen(
    recipientSeed, sealed, flippedSig, sharer, owner,
    expectedAlbumId, minEpochId, false,
  )
  if (tamperedSig.code != OpenedBundleCode.BUNDLE_SIGNATURE_INVALID) {
    throw IllegalStateException("tampered-signature expected BUNDLE_SIGNATURE_INVALID, got ${tamperedSig.code}")
  }

  // Negative case: tampered sealed bytes
  val flippedSealed = sealed.copyOf()
  flippedSealed[0] = (flippedSealed[0].toInt() xor 0x01).toByte()
  val tamperedSealed = bridge.verifyAndOpen(
    recipientSeed, flippedSealed, signature, sharer, owner,
    expectedAlbumId, minEpochId, false,
  )
  if (tamperedSealed.code != OpenedBundleCode.BUNDLE_SIGNATURE_INVALID) {
    throw IllegalStateException("tampered-sealed expected BUNDLE_SIGNATURE_INVALID, got ${tamperedSealed.code}")
  }

  // Negative case: album-id mismatch
  val differentAlbumId = "00000000-0000-7000-8000-000000000def"
  val mismatch = bridge.verifyAndOpen(
    recipientSeed, sealed, signature, sharer, owner,
    differentAlbumId, minEpochId, false,
  )
  if (mismatch.code != OpenedBundleCode.BUNDLE_ALBUM_ID_MISMATCH) {
    throw IllegalStateException("album-id-mismatch expected BUNDLE_ALBUM_ID_MISMATCH, got ${mismatch.code}")
  }
}

private fun extractLongField(document: String, name: String): Long {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  val start = cursor
  while (cursor < document.length && (document[cursor].isDigit() || document[cursor] == '-')) cursor++
  return document.substring(start, cursor).toLong()
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
