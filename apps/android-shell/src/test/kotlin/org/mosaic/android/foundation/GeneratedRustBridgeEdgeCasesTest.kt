package org.mosaic.android.foundation

private data class EdgeCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    EdgeCase("identity handle rejects zero and negative values", ::identityHandleRejectsZeroAndNegative),
    EdgeCase("epoch handle rejects zero and negative values", ::epochHandleRejectsZeroAndNegative),
    EdgeCase("identity handle equality is value-based", ::identityHandleEqualityIsValueBased),
    EdgeCase("epoch handle equality is value-based", ::epochHandleEqualityIsValueBased),

    EdgeCase("parsed shard envelope header rejects nonce of wrong length", ::parsedHeaderRejectsBadNonceLength),
    EdgeCase("parsed shard envelope header accepts boundary tier values", ::parsedHeaderAcceptsBoundaryTiers),

    EdgeCase("encrypted shard envelope rejects empty bytes and non-hex sha256", ::encryptedShardRejectsBadInputs),
    EdgeCase("encrypted shard envelope copies bytes defensively", ::encryptedShardCopiesBytesDefensively),
    EdgeCase("decrypted shard wipe leaves redacted toString unchanged", ::decryptedShardWipeKeepsRedacted),

    EdgeCase("identity create result requires populated bytes on success", ::identityCreateRequiresBytesOnSuccess),
    EdgeCase("identity create result rejects success with null handle", ::identityCreateRejectsSuccessWithoutHandle),
    EdgeCase("epoch create result rejects success with null handle", ::epochCreateRejectsSuccessWithoutHandle),

    EdgeCase("metadata sidecar request copies bytes defensively", ::metadataSidecarRequestCopiesBytes),
    EdgeCase("encrypt media metadata sidecar request copies bytes defensively", ::encryptMediaSidecarRequestCopiesBytes),

    EdgeCase("media image metadata rejects out-of-range orientation", ::mediaImageMetadataRejectsBadOrientation),
    EdgeCase("media tier dimensions rejects out-of-range tier", ::mediaTierDimensionsRejectsBadTier),
    EdgeCase("media tier layout rejects mismatched tier values", ::mediaTierLayoutRejectsMismatchedTiers),

    EdgeCase("album sync request id rejects oversize tokens", ::albumSyncRequestIdRejectsOversize),
    EdgeCase("album sync cursor accepts boundary length and rejects oversize", ::albumSyncCursorBoundary),
    EdgeCase("album sync handoff result rejects accepted code with blank phase", ::albumSyncHandoffResultRequiresPhaseOnAccepted),

    EdgeCase("rust bytes ffi result equality reflects byte content", ::rustBytesFfiResultEquality),
    EdgeCase("rust identity handle ffi result equality reflects all fields", ::rustIdentityHandleFfiResultEquality),
    EdgeCase("rust epoch handle ffi result equality reflects all fields", ::rustEpochHandleFfiResultEquality),
    EdgeCase("rust encrypted shard ffi result equality reflects all fields", ::rustEncryptedShardFfiResultEquality),

    EdgeCase("header bridge maps unknown stable codes to internal error", ::headerBridgeMapsUnknownCodes),
    EdgeCase("identity bridge maps unknown stable codes to internal error", ::identityBridgeMapsUnknownCodes),
    EdgeCase("epoch bridge maps unknown stable codes to internal error", ::epochBridgeMapsUnknownCodes),
    EdgeCase("shard bridge maps unknown stable codes to internal error", ::shardBridgeMapsUnknownCodes),
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
    throw IllegalStateException("$failed Rust bridge edge-case tests failed")
  }
  println("PASS ${tests.size} Rust bridge edge-case tests")
}

// region handle invariants

private fun identityHandleRejectsZeroAndNegative() {
  edgeExpectThrows("zero handle") { IdentityHandle(0) }
  edgeExpectThrows("negative handle") { IdentityHandle(-1) }
  edgeExpectThrows("MIN_VALUE handle") { IdentityHandle(Long.MIN_VALUE) }
}

private fun epochHandleRejectsZeroAndNegative() {
  edgeExpectThrows("zero handle") { EpochKeyHandle(0) }
  edgeExpectThrows("negative handle") { EpochKeyHandle(-1) }
  edgeExpectThrows("MIN_VALUE handle") { EpochKeyHandle(Long.MIN_VALUE) }
}

private fun identityHandleEqualityIsValueBased() {
  val a = IdentityHandle(42)
  val b = IdentityHandle(42)
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != IdentityHandle(43))
}

private fun epochHandleEqualityIsValueBased() {
  val a = EpochKeyHandle(99)
  val b = EpochKeyHandle(99)
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != EpochKeyHandle(100))
}

// endregion

// region parsed header

private fun parsedHeaderRejectsBadNonceLength() {
  edgeExpectThrows("23-byte nonce") {
    ParsedShardEnvelopeHeader(epochId = 1, shardIndex = 0, tier = 1, nonce = ByteArray(23))
  }
  edgeExpectThrows("25-byte nonce") {
    ParsedShardEnvelopeHeader(epochId = 1, shardIndex = 0, tier = 1, nonce = ByteArray(25))
  }
  edgeExpectThrows("empty nonce") {
    ParsedShardEnvelopeHeader(epochId = 1, shardIndex = 0, tier = 1, nonce = ByteArray(0))
  }
}

private fun parsedHeaderAcceptsBoundaryTiers() {
  ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 1, nonce = ByteArray(24))
  ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 3, nonce = ByteArray(24))
  edgeExpectThrows("tier 0") {
    ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 0, nonce = ByteArray(24))
  }
  edgeExpectThrows("tier 4") {
    ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 4, nonce = ByteArray(24))
  }
}

// endregion

// region encrypted shard envelope

private fun encryptedShardRejectsBadInputs() {
  edgeExpectThrows("empty bytes") {
    EncryptedShardEnvelope(envelopeBytes = ByteArray(0), sha256 = "0".repeat(64))
  }
  edgeExpectThrows("short sha256") {
    EncryptedShardEnvelope(envelopeBytes = ByteArray(8), sha256 = "abc")
  }
  edgeExpectThrows("non-hex sha256") {
    EncryptedShardEnvelope(envelopeBytes = ByteArray(8), sha256 = "z".repeat(64))
  }
}

private fun encryptedShardCopiesBytesDefensively() {
  val source = ByteArray(32) { it.toByte() }
  val envelope = EncryptedShardEnvelope(source, "f".repeat(64))
  source[0] = 0x42
  edgeAssertTrue(envelope.envelopeBytes[0].toInt() == 0)
  // Returned byte array is also a defensive copy.
  envelope.envelopeBytes[0] = 0x77
  edgeAssertTrue(envelope.envelopeBytes[0].toInt() == 0)
}

private fun decryptedShardWipeKeepsRedacted() {
  val shard = DecryptedShard(ByteArray(8) { 0x55 })
  edgeAssertTrue(shard.toString() == "DecryptedShard(<redacted>)")
  shard.wipe()
  edgeAssertTrue(shard.toString() == "DecryptedShard(<redacted>)")
}

// endregion

// region identity result invariants

private fun identityCreateRequiresBytesOnSuccess() {
  // Successful creates require populated handle + non-empty pubkeys + non-empty wrapped seed.
  IdentityCreateResult(
    code = IdentityCreateCode.SUCCESS,
    handle = IdentityHandle(7),
    signingPubkey = ByteArray(32) { 0x11 },
    encryptionPubkey = ByteArray(32) { 0x22 },
    wrappedSeed = ByteArray(48) { 0x33 },
  )
  // OK: non-success with empty bytes and null handle.
  IdentityCreateResult(
    code = IdentityCreateCode.INTERNAL_ERROR,
    handle = null,
    signingPubkey = ByteArray(0),
    encryptionPubkey = ByteArray(0),
    wrappedSeed = ByteArray(0),
  )
}

private fun identityCreateRejectsSuccessWithoutHandle() {
  edgeExpectThrows("success without handle") {
    IdentityCreateResult(
      code = IdentityCreateCode.SUCCESS,
      handle = null,
      signingPubkey = ByteArray(32),
      encryptionPubkey = ByteArray(32),
      wrappedSeed = ByteArray(32),
    )
  }
  edgeExpectThrows("failure with handle") {
    IdentityCreateResult(
      code = IdentityCreateCode.INTERNAL_ERROR,
      handle = IdentityHandle(7),
      signingPubkey = ByteArray(0),
      encryptionPubkey = ByteArray(0),
      wrappedSeed = ByteArray(0),
    )
  }
}

private fun epochCreateRejectsSuccessWithoutHandle() {
  edgeExpectThrows("success without handle") {
    EpochCreateResult(
      code = EpochCreateCode.SUCCESS,
      handle = null,
      epochId = 5,
      wrappedEpochSeed = ByteArray(48),
    )
  }
  edgeExpectThrows("failure with handle") {
    EpochCreateResult(
      code = EpochCreateCode.INTERNAL_ERROR,
      handle = EpochKeyHandle(99),
      epochId = 5,
      wrappedEpochSeed = ByteArray(0),
    )
  }
}

// endregion

// region sidecar request defensive copies

private fun metadataSidecarRequestCopiesBytes() {
  val albumId = ByteArray(16) { it.toByte() }
  val photoId = ByteArray(16) { it.toByte() }
  val encodedFields = ByteArray(32) { it.toByte() }
  val request = CanonicalMetadataSidecarRequest(
    albumId = albumId,
    photoId = photoId,
    epochId = 1,
    encodedFields = encodedFields,
  )
  albumId[0] = 0x42
  photoId[0] = 0x42
  encodedFields[0] = 0x42
  edgeAssertTrue(request.albumId[0].toInt() == 0)
  edgeAssertTrue(request.photoId[0].toInt() == 0)
  edgeAssertTrue(request.encodedFields[0].toInt() == 0)
}

private fun encryptMediaSidecarRequestCopiesBytes() {
  val albumId = ByteArray(16) { it.toByte() }
  val photoId = ByteArray(16) { it.toByte() }
  val mediaBytes = ByteArray(64) { it.toByte() }
  val request = EncryptMediaMetadataSidecarRequest(
    epochKeyHandle = EpochKeyHandle(99),
    albumId = albumId,
    photoId = photoId,
    epochId = 1,
    mediaBytes = mediaBytes,
    shardIndex = 0,
  )
  albumId[0] = 0x42
  photoId[0] = 0x42
  mediaBytes[0] = 0x42
  edgeAssertTrue(request.albumId[0].toInt() == 0)
  edgeAssertTrue(request.photoId[0].toInt() == 0)
  edgeAssertTrue(request.mediaBytes[0].toInt() == 0)
}

// endregion

// region media DTOs

private fun mediaImageMetadataRejectsBadOrientation() {
  // Valid range is 1..8 (EXIF orientations).
  edgeExpectThrows("orientation 0") {
    MediaImageMetadata("JPEG", "image/jpeg", 100, 100, 0)
  }
  edgeExpectThrows("orientation 9") {
    MediaImageMetadata("JPEG", "image/jpeg", 100, 100, 9)
  }
  // Boundary values accepted.
  MediaImageMetadata("JPEG", "image/jpeg", 100, 100, 1)
  MediaImageMetadata("JPEG", "image/jpeg", 100, 100, 8)
}

private fun mediaTierDimensionsRejectsBadTier() {
  edgeExpectThrows("tier 0") { MediaTierDimensions(0, 100, 100) }
  edgeExpectThrows("tier 4") { MediaTierDimensions(4, 100, 100) }
  edgeExpectThrows("zero width") { MediaTierDimensions(1, 0, 100) }
  edgeExpectThrows("zero height") { MediaTierDimensions(1, 100, 0) }
}

private fun mediaTierLayoutRejectsMismatchedTiers() {
  edgeExpectThrows("thumbnail tier 2") {
    MediaTierLayout(
      thumbnail = MediaTierDimensions(2, 100, 100),
      preview = MediaTierDimensions(2, 200, 200),
      original = MediaTierDimensions(3, 400, 400),
    )
  }
  edgeExpectThrows("preview tier 1") {
    MediaTierLayout(
      thumbnail = MediaTierDimensions(1, 100, 100),
      preview = MediaTierDimensions(1, 200, 200),
      original = MediaTierDimensions(3, 400, 400),
    )
  }
}

// endregion

// region album sync DTOs

private fun albumSyncRequestIdRejectsOversize() {
  AlbumSyncRequestId("a".repeat(AlbumSyncRequestId.MAX_ALBUM_SYNC_REQUEST_ID_LENGTH))
  edgeExpectThrows("oversize request id") {
    AlbumSyncRequestId("a".repeat(AlbumSyncRequestId.MAX_ALBUM_SYNC_REQUEST_ID_LENGTH + 1))
  }
  edgeExpectThrows("blank") { AlbumSyncRequestId("") }
}

private fun albumSyncCursorBoundary() {
  AlbumSyncCursor("a".repeat(AlbumSyncCursor.MAX_ALBUM_SYNC_CURSOR_LENGTH))
  AlbumSyncCursor("")
  edgeExpectThrows("oversize cursor") {
    AlbumSyncCursor("a".repeat(AlbumSyncCursor.MAX_ALBUM_SYNC_CURSOR_LENGTH + 1))
  }
}

private fun albumSyncHandoffResultRequiresPhaseOnAccepted() {
  edgeExpectThrows("accepted with blank phase") {
    AlbumSyncHandoffResult(
      code = AlbumSyncHandoffCode.ACCEPTED,
      phase = "",
      activeCursor = null,
      pendingCursor = null,
      rerunRequested = false,
      retryCount = 0,
      nextRetryUnixMs = 0,
    )
  }
  // Failure with empty phase is allowed.
  AlbumSyncHandoffResult(
    code = AlbumSyncHandoffCode.INVALID_TRANSITION,
    phase = "",
    activeCursor = null,
    pendingCursor = null,
    rerunRequested = false,
    retryCount = 0,
    nextRetryUnixMs = 0,
  )
}

// endregion

// region FFI result equality

private fun rustBytesFfiResultEquality() {
  val a = RustBytesFfiResult(code = 0, bytes = ByteArray(8) { 0x11 })
  val b = RustBytesFfiResult(code = 0, bytes = ByteArray(8) { 0x11 })
  val c = RustBytesFfiResult(code = 0, bytes = ByteArray(8) { 0x22 })
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != c)
}

private fun rustIdentityHandleFfiResultEquality() {
  val a = RustIdentityHandleFfiResult(0, 1, ByteArray(8), ByteArray(8), ByteArray(8))
  val b = RustIdentityHandleFfiResult(0, 1, ByteArray(8), ByteArray(8), ByteArray(8))
  val c = RustIdentityHandleFfiResult(0, 2, ByteArray(8), ByteArray(8), ByteArray(8))
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != c)
}

private fun rustEpochHandleFfiResultEquality() {
  val a = RustEpochHandleFfiResult(0, 1, 5, ByteArray(8))
  val b = RustEpochHandleFfiResult(0, 1, 5, ByteArray(8))
  val c = RustEpochHandleFfiResult(0, 1, 6, ByteArray(8))
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != c)
}

private fun rustEncryptedShardFfiResultEquality() {
  val a = RustEncryptedShardFfiResult(0, ByteArray(8), "f".repeat(64))
  val b = RustEncryptedShardFfiResult(0, ByteArray(8), "f".repeat(64))
  val c = RustEncryptedShardFfiResult(0, ByteArray(8), "0".repeat(64))
  edgeAssertTrue(a == b)
  edgeAssertTrue(a.hashCode() == b.hashCode())
  edgeAssertTrue(a != c)
}

// endregion

// region unknown stable code mapping

private fun headerBridgeMapsUnknownCodes() {
  for (unknownCode in listOf(50, 99, 105, 200, 999)) {
    val api = SimpleHeaderApi(
      RustHeaderParseFfiResult(
        code = unknownCode,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      ),
    )
    val result = GeneratedRustHeaderBridge(api).parseEnvelopeHeader(ByteArray(64))
    edgeAssertTrue(result.code == HeaderParseCode.INTERNAL_ERROR)
    edgeAssertTrue(result.parsed == null)
  }
}

private fun identityBridgeMapsUnknownCodes() {
  val api = SimpleIdentityApi(
    create = RustIdentityHandleFfiResult(99, 0, ByteArray(0), ByteArray(0), ByteArray(0)),
  )
  val result = GeneratedRustIdentityBridge(api).createIdentity(AccountKeyHandle(7))
  edgeAssertTrue(result.code == IdentityCreateCode.INTERNAL_ERROR)
  edgeAssertTrue(result.handle == null)
}

private fun epochBridgeMapsUnknownCodes() {
  val api = SimpleEpochApi(
    create = RustEpochHandleFfiResult(99, 0, 0, ByteArray(0)),
  )
  val result = GeneratedRustEpochBridge(api).createEpoch(AccountKeyHandle(7), 1)
  edgeAssertTrue(result.code == EpochCreateCode.INTERNAL_ERROR)
  edgeAssertTrue(result.handle == null)
}

private fun shardBridgeMapsUnknownCodes() {
  val api = SimpleShardApi(
    encrypt = RustEncryptedShardFfiResult(99, ByteArray(0), "0".repeat(64)),
  )
  val result = GeneratedRustShardBridge(api).encryptShard(EpochKeyHandle(99), ByteArray(8), 0, 1)
  edgeAssertTrue(result.code == ShardEncryptCode.INTERNAL_ERROR)
  edgeAssertTrue(result.envelope == null)
}

// endregion

// region helpers

private fun edgeAssertTrue(value: Boolean) {
  if (!value) throw IllegalStateException("expected true")
}

private fun edgeExpectThrows(label: String, body: () -> Unit) {
  try {
    body()
  } catch (_: Throwable) {
    return
  }
  throw IllegalStateException("expected $label to throw")
}

private class SimpleHeaderApi(private val canned: RustHeaderParseFfiResult) : GeneratedRustHeaderApi {
  override fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult = canned
}

private class SimpleIdentityApi(
  private val create: RustIdentityHandleFfiResult? = null,
) : GeneratedRustIdentityApi {
  override fun createIdentityHandle(accountKeyHandle: Long): RustIdentityHandleFfiResult =
    create ?: error("not configured")

  override fun openIdentityHandle(wrappedSeed: ByteArray, accountKeyHandle: Long): RustIdentityHandleFfiResult =
    error("not configured")

  override fun identitySigningPubkey(handle: Long): RustBytesFfiResult = error("not configured")
  override fun identityEncryptionPubkey(handle: Long): RustBytesFfiResult = error("not configured")
  override fun signManifestWithIdentity(handle: Long, transcriptBytes: ByteArray): RustBytesFfiResult =
    error("not configured")

  override fun closeIdentityHandle(handle: Long): Int = 0
}

private class SimpleEpochApi(
  private val create: RustEpochHandleFfiResult? = null,
) : GeneratedRustEpochApi {
  override fun createEpochKeyHandle(accountKeyHandle: Long, epochId: Int): RustEpochHandleFfiResult =
    create ?: error("not configured")

  override fun openEpochKeyHandle(
    wrappedEpochSeed: ByteArray,
    accountKeyHandle: Long,
    epochId: Int,
  ): RustEpochHandleFfiResult = error("not configured")

  override fun epochKeyHandleIsOpen(handle: Long): RustEpochHandleStatusFfiResult = error("not configured")
  override fun closeEpochKeyHandle(handle: Long): Int = 0
}

private class SimpleShardApi(
  private val encrypt: RustEncryptedShardFfiResult? = null,
) : GeneratedRustShardApi {
  override fun encryptShardWithEpochHandle(
    epochKeyHandle: Long,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): RustEncryptedShardFfiResult = encrypt ?: error("not configured")

  override fun decryptShardWithEpochHandle(
    epochKeyHandle: Long,
    envelopeBytes: ByteArray,
  ): RustDecryptedShardFfiResult = error("not configured")
}

// endregion
