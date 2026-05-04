package org.mosaic.android.foundation

private data class BridgeTestCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    BridgeTestCase("header bridge maps OK to ParsedShardEnvelopeHeader", ::headerBridgeMapsOkResult),
    BridgeTestCase("header bridge maps invalid header codes to typed failures", ::headerBridgeMapsInvalidCodes),
    BridgeTestCase("header parse FFI result redacts nonce in toString", ::headerParseFfiResultRedactsNonce),
    BridgeTestCase("parsed header redacts nonce and rejects out-of-range fields", ::parsedHeaderRejectsBadFields),

    BridgeTestCase("progress bridge maps OK and cancellation", ::progressBridgeMapsOkAndCancellation),
    BridgeTestCase("progress probe rejects negative inputs", ::progressProbeRejectsNegativeInputs),

    BridgeTestCase("identity bridge create maps OK and absent handle", ::identityBridgeCreateMapsOkAndMissingHandle),
    BridgeTestCase("identity bridge open maps authentication failure to typed code", ::identityBridgeOpenMapsAuthenticationFailure),
    BridgeTestCase("identity pubkey bridge maps missing handle", ::identityBridgePubkeyMapsMissingHandle),
    BridgeTestCase("identity sign manifest maps invalid input length", ::identityBridgeSignManifestMapsInvalidInputLength),
    BridgeTestCase("identity close maps not-found", ::identityBridgeCloseMapsNotFound),
    BridgeTestCase("identity DTOs redact key material in toString", ::identityDtosRedactKeyMaterial),

    BridgeTestCase("epoch bridge create maps OK and missing account handle", ::epochBridgeCreateMapsOkAndMissingAccountHandle),
    BridgeTestCase("epoch bridge open maps wrapped-key-too-short", ::epochBridgeOpenMapsWrappedKeyTooShort),
    BridgeTestCase("epoch bridge isOpen reflects status code", ::epochBridgeIsOpenReflectsStatus),
    BridgeTestCase("epoch bridge close maps not-found", ::epochBridgeCloseMapsNotFound),
    BridgeTestCase("epoch DTOs redact wrapped seed in toString", ::epochDtosRedactWrappedSeed),

    BridgeTestCase("shard bridge encrypt maps OK to envelope and rejects empty plaintext", ::shardEncryptMapsOkAndRejectsEmpty),
    BridgeTestCase("shard bridge encrypt maps RNG failure", ::shardEncryptMapsRngFailure),
    BridgeTestCase("shard bridge decrypt maps OK to plaintext and authentication failure", ::shardDecryptMapsOkAndAuthFailure),
    BridgeTestCase("decrypted shard can be wiped and refuses access afterward", ::decryptedShardWipeBlocksAccess),
    BridgeTestCase("shard DTOs redact ciphertext and plaintext in toString", ::shardDtosRedactCiphertextAndPlaintext),

    BridgeTestCase("metadata sidecar bridge canonical maps OK to bytes", ::metadataSidecarCanonicalMapsOk),
    BridgeTestCase("metadata sidecar bridge encrypt maps invalid media format", ::metadataSidecarEncryptMapsInvalidFormat),
    BridgeTestCase("metadata sidecar request DTOs redact sensitive bytes", ::metadataSidecarRequestDtosRedactBytes),

    BridgeTestCase("album sync bridge accepts initial start and reports phase", ::albumSyncBridgeAcceptsInitialStart),
    BridgeTestCase("album sync bridge maps invalid transition", ::albumSyncBridgeMapsInvalidTransition),
    BridgeTestCase("album sync bridge maps retry budget exhaustion", ::albumSyncBridgeMapsRetryBudgetExhaustion),
    BridgeTestCase("album sync DTOs redact cursors and asset ids in toString", ::albumSyncDtosRedactCursorsAndAssetIds),

    BridgeTestCase("diagnostics bridge returns protocol version and rejects blank", ::diagnosticsProtocolVersion),
    BridgeTestCase("diagnostics bridge returns golden vector and redacts opaque fields", ::diagnosticsGoldenVectorRedacted),
    BridgeTestCase("diagnostics bridge state machine snapshot rejects blank", ::diagnosticsStateMachineSnapshot),

    BridgeTestCase("media inspection bridge maps OK and rejects empty bytes", ::mediaInspectionMapsOkAndRejectsEmpty),
    BridgeTestCase("media inspection bridge maps unsupported format", ::mediaInspectionMapsUnsupportedFormat),
    BridgeTestCase("media tier layout bridge maps OK", ::mediaTierLayoutMapsOk),
    BridgeTestCase("media tier layout bridge maps invalid dimensions", ::mediaTierLayoutMapsInvalidDimensions),

    BridgeTestCase("public android shell DTOs avoid privacy-forbidden media text", ::publicBridgeDtosAvoidPrivacyForbiddenText),

    // Slice 0C raw-input bridge DTO redaction (SPEC-CrossPlatformHardening,
    // Android shell checklist: "DTO toString methods redact staged sources,
    // handles, plan IDs, and request salts/wrapped keys.").
    BridgeTestCase("RustLinkKeysFfiResult redacts linkId and wrappingKey", ::rustLinkKeysFfiResultRedactsBytes),
    BridgeTestCase("RustIdentitySeedFfiResult redacts pubkeys and signature", ::rustIdentitySeedFfiResultRedactsBytes),
    BridgeTestCase("RustContentDecryptFfiResult redacts plaintext", ::rustContentDecryptFfiResultRedactsPlaintext),
    BridgeTestCase("AuthChallenge transcript / sign result strings redact secret-equivalent bytes", ::authChallengeResultsRedactBytes),
    BridgeTestCase("RustOpenedBundleFfiResult redacts album-id chars and key bytes", ::rustOpenedBundleFfiResultRedactsAllSensitiveFields),
    BridgeTestCase("OpenedBundleResult redacts albumId and key bytes", ::openedBundleResultRedactsBytes),
    BridgeTestCase("RustAccountUnlockFfiResult redacts raw account-key handle", ::rustAccountUnlockFfiResultRedactsHandle),

    BridgeTestCase("identity create result wipes wrapped seed and pubkeys", ::identityCreateResultWipesAllSensitiveBytes),
    BridgeTestCase("identity open result wipes pubkeys", ::identityOpenResultWipesPubkeys),
    BridgeTestCase("identity pubkey result wipes pubkey", ::identityPubkeyResultWipesPubkey),
    BridgeTestCase("manifest signature result wipes signature", ::manifestSignatureResultWipesSignature),
    BridgeTestCase("epoch create result wipes wrapped seed", ::epochCreateResultWipesWrappedSeed),
    BridgeTestCase("decrypted shard FFI result wipes plaintext", ::decryptedShardFfiResultWipesPlaintext),
    BridgeTestCase("shard bridge wipes FFI result after decrypting", ::shardBridgeWipesFfiResultAfterDecrypt),
    BridgeTestCase("encryptShardWipingPlaintext wipes caller plaintext", ::encryptShardWipingPlaintextWipesCallerPlaintext),
    BridgeTestCase("metadata sidecar request types wipe their byte arrays", ::metadataSidecarRequestsWipeAllBytes),
    BridgeTestCase("canonical metadata sidecar wipes its bytes", ::canonicalMetadataSidecarWipes),
    BridgeTestCase("epoch bridge openEpoch wipes FFI seed buffer", ::epochBridgeOpenWipesFfiSeed),
    BridgeTestCase("identity bridge openIdentity wipes FFI buffers", ::identityBridgeOpenWipesFfi),
    BridgeTestCase("identity bridge signManifest wipes FFI bytes", ::identityBridgeSignManifestWipesFfi),
    BridgeTestCase("identity bridge signingPubkey/encryptionPubkey wipe FFI bytes", ::identityBridgePubkeyOpsWipeFfi),
    BridgeTestCase("metadata sidecar encrypt ops wipe FFI envelopes", ::metadataSidecarEncryptOpsWipeFfi),
    BridgeTestCase("metadata sidecar canonicalMedia wipes FFI bytes", ::metadataSidecarCanonicalMediaWipesFfi),
    BridgeTestCase("diagnostics bridge cryptoDomainGoldenVector wipes FFI vector", ::diagnosticsBridgeWipesFfiGoldenVector),
    BridgeTestCase("diagnostics golden vector FFI wipe zeros all 7 byte arrays", ::diagnosticsFfiGoldenVectorWipeZerosAll),
    BridgeTestCase("openIdentityWipingWrappedSeed wipes caller wrapped seed", ::openIdentityWipingWrappedSeedWipesCallerBuffer),
    BridgeTestCase("openEpochWipingWrappedSeed wipes caller wrapped seed", ::openEpochWipingWrappedSeedWipesCallerBuffer),
    BridgeTestCase("decryptShardWipingEnvelope wipes caller envelope", ::decryptShardWipingEnvelopeWipesCallerBuffer),
    BridgeTestCase("signManifestWipingTranscript wipes caller transcript", ::signManifestWipingTranscriptWipesCallerBuffer),
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
    throw IllegalStateException("$failed Rust bridge contract tests failed")
  }

  println("PASS ${tests.size} Rust bridge contract tests")
}

// region header bridge

private fun headerBridgeMapsOkResult() {
  val nonce = ByteArray(ParsedShardEnvelopeHeader.NONCE_LENGTH) { it.toByte() }
  val expectedNonce = nonce.copyOf()
  val api = FakeGeneratedRustHeaderApi(
    canned = RustHeaderParseFfiResult(
      code = RustHeaderStableCode.OK,
      epochId = 7,
      shardIndex = 3,
      tier = 2,
      nonce = nonce,
    ),
  )
  val bridge = GeneratedRustHeaderBridge(api)
  val result = bridge.parseEnvelopeHeader(ByteArray(64) { it.toByte() })

  bridgeAssertTrue(result.code == HeaderParseCode.SUCCESS)
  val parsed = result.parsed ?: error("expected parsed header")
  bridgeAssertTrue(parsed.epochId == 7)
  bridgeAssertTrue(parsed.shardIndex == 3)
  bridgeAssertTrue(parsed.tier == 2)
  bridgeAssertTrue(parsed.nonce.contentEquals(expectedNonce))
  // The bridge wiped the FFI buffer; the test's local nonce reference is now zeroed.
  bridgeAssertTrue(nonce.all { it == 0.toByte() })
}

private fun headerBridgeMapsInvalidCodes() {
  val cases = listOf(
    RustHeaderStableCode.INVALID_HEADER_LENGTH to HeaderParseCode.INVALID_HEADER_LENGTH,
    RustHeaderStableCode.INVALID_MAGIC to HeaderParseCode.INVALID_MAGIC,
    RustHeaderStableCode.UNSUPPORTED_VERSION to HeaderParseCode.UNSUPPORTED_VERSION,
    RustHeaderStableCode.INVALID_TIER to HeaderParseCode.INVALID_TIER,
    RustHeaderStableCode.NON_ZERO_RESERVED_BYTE to HeaderParseCode.NON_ZERO_RESERVED_BYTE,
    9999 to HeaderParseCode.INTERNAL_ERROR,
  )
  for ((stable, expected) in cases) {
    val api = FakeGeneratedRustHeaderApi(
      canned = RustHeaderParseFfiResult(
        code = stable,
        epochId = 0,
        shardIndex = 0,
        tier = 0,
        nonce = ByteArray(0),
      ),
    )
    val bridge = GeneratedRustHeaderBridge(api)
    val result = bridge.parseEnvelopeHeader(ByteArray(8))
    bridgeAssertTrue(result.code == expected)
    bridgeAssertTrue(result.parsed == null)
  }
}

private fun headerParseFfiResultRedactsNonce() {
  val nonce = ByteArray(ParsedShardEnvelopeHeader.NONCE_LENGTH) { it.toByte() }
  val ffi = RustHeaderParseFfiResult(
    code = RustHeaderStableCode.OK,
    epochId = 1,
    shardIndex = 0,
    tier = 1,
    nonce = nonce,
  )
  bridgeAssertTrue("nonce=<redacted>" in ffi.toString())
}

private fun parsedHeaderRejectsBadFields() {
  val nonce = ByteArray(ParsedShardEnvelopeHeader.NONCE_LENGTH)
  bridgeExpectThrows("negative epoch id") {
    ParsedShardEnvelopeHeader(epochId = -1, shardIndex = 0, tier = 1, nonce = nonce)
  }
  bridgeExpectThrows("negative shard index") {
    ParsedShardEnvelopeHeader(epochId = 0, shardIndex = -1, tier = 1, nonce = nonce)
  }
  bridgeExpectThrows("tier zero") {
    ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 0, nonce = nonce)
  }
  bridgeExpectThrows("nonce too short") {
    ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 1, nonce = ByteArray(8))
  }
  val parsed = ParsedShardEnvelopeHeader(epochId = 0, shardIndex = 0, tier = 1, nonce = nonce)
  bridgeAssertTrue("nonce=<redacted>" in parsed.toString())
  // Defensive copy: caller mutation must not affect bridge state.
  nonce[0] = 0x42
  bridgeAssertTrue(parsed.nonce[0].toInt() == 0)
}

// endregion

// region progress bridge

private fun progressBridgeMapsOkAndCancellation() {
  val okApi = FakeGeneratedRustProgressApi(
    canned = RustProgressFfiResult(
      code = RustProgressStableCode.OK,
      checkpoints = listOf(RustProgressFfiCheckpoint(2, 3), RustProgressFfiCheckpoint(3, 3)),
    ),
  )
  val ok = GeneratedRustProgressBridge(okApi).probe(totalSteps = 3, cancelAfter = null)
  bridgeAssertTrue(ok.code == ProgressProbeCode.SUCCESS)
  bridgeAssertTrue(ok.checkpoints.size == 2)
  bridgeAssertTrue(ok.checkpoints[0].completedSteps == 2 && ok.checkpoints[0].totalSteps == 3)

  val cancelApi = FakeGeneratedRustProgressApi(
    canned = RustProgressFfiResult(
      code = RustProgressStableCode.OPERATION_CANCELLED,
      checkpoints = listOf(RustProgressFfiCheckpoint(1, 5)),
    ),
  )
  val cancelled = GeneratedRustProgressBridge(cancelApi).probe(totalSteps = 5, cancelAfter = 1)
  bridgeAssertTrue(cancelled.code == ProgressProbeCode.CANCELLED)
  bridgeAssertTrue(cancelled.checkpoints.size == 1)

  val errApi = FakeGeneratedRustProgressApi(
    canned = RustProgressFfiResult(code = 9999, checkpoints = emptyList()),
  )
  bridgeAssertTrue(GeneratedRustProgressBridge(errApi).probe(totalSteps = 1, cancelAfter = null).code == ProgressProbeCode.INTERNAL_ERROR)
}

private fun progressProbeRejectsNegativeInputs() {
  val api = FakeGeneratedRustProgressApi(
    canned = RustProgressFfiResult(code = RustProgressStableCode.OK, checkpoints = emptyList()),
  )
  val bridge = GeneratedRustProgressBridge(api)
  bridgeExpectThrows("negative total steps") { bridge.probe(totalSteps = -1, cancelAfter = null) }
  bridgeExpectThrows("negative cancel-after") { bridge.probe(totalSteps = 5, cancelAfter = -1) }
}

// endregion

// region identity bridge

private fun identityBridgeCreateMapsOkAndMissingHandle() {
  val signing = ByteArray(32) { 0x11 }
  val encryption = ByteArray(32) { 0x22 }
  val seed = ByteArray(64) { 0x33 }
  val expectedSigning = signing.copyOf()
  val expectedEncryption = encryption.copyOf()
  val expectedSeed = seed.copyOf()

  val okApi = FakeGeneratedRustIdentityApi(
    create = RustIdentityHandleFfiResult(
      code = RustIdentityStableCode.OK,
      handle = 42,
      signingPubkey = signing,
      encryptionPubkey = encryption,
      wrappedSeed = seed,
    ),
  )
  val ok = GeneratedRustIdentityBridge(okApi).createIdentity(AccountKeyHandle(7))
  bridgeAssertTrue(ok.code == IdentityCreateCode.SUCCESS)
  bridgeAssertTrue(ok.handle != null && ok.handle!!.value == 42L)
  bridgeAssertTrue(ok.signingPubkey.contentEquals(expectedSigning))
  bridgeAssertTrue(ok.encryptionPubkey.contentEquals(expectedEncryption))
  bridgeAssertTrue(ok.wrappedSeed.contentEquals(expectedSeed))
  // The bridge wiped the FFI buffers; the test's local arrays are now zeroed.
  bridgeAssertTrue(signing.all { it == 0.toByte() })
  bridgeAssertTrue(encryption.all { it == 0.toByte() })
  bridgeAssertTrue(seed.all { it == 0.toByte() })

  val missingApi = FakeGeneratedRustIdentityApi(
    create = RustIdentityHandleFfiResult(
      code = RustIdentityStableCode.SECRET_HANDLE_NOT_FOUND,
      handle = 0,
      signingPubkey = ByteArray(0),
      encryptionPubkey = ByteArray(0),
      wrappedSeed = ByteArray(0),
    ),
  )
  val missing = GeneratedRustIdentityBridge(missingApi).createIdentity(AccountKeyHandle(7))
  bridgeAssertTrue(missing.code == IdentityCreateCode.ACCOUNT_HANDLE_NOT_FOUND)
  bridgeAssertTrue(missing.handle == null)
}

private fun identityBridgeOpenMapsAuthenticationFailure() {
  val api = FakeGeneratedRustIdentityApi(
    open = RustIdentityHandleFfiResult(
      code = RustIdentityStableCode.AUTHENTICATION_FAILED,
      handle = 0,
      signingPubkey = ByteArray(0),
      encryptionPubkey = ByteArray(0),
      wrappedSeed = ByteArray(0),
    ),
  )
  val result = GeneratedRustIdentityBridge(api).openIdentity(ByteArray(48), AccountKeyHandle(7))
  bridgeAssertTrue(result.code == IdentityOpenCode.AUTHENTICATION_FAILED)
  bridgeAssertTrue(result.handle == null)
}

private fun identityBridgePubkeyMapsMissingHandle() {
  val api = FakeGeneratedRustIdentityApi(
    signingPubkey = RustBytesFfiResult(code = RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND, bytes = ByteArray(0)),
  )
  val result = GeneratedRustIdentityBridge(api).signingPubkey(IdentityHandle(99))
  bridgeAssertTrue(result.code == IdentityPubkeyCode.IDENTITY_HANDLE_NOT_FOUND)
  bridgeAssertTrue(result.pubkey.isEmpty())
}

private fun identityBridgeSignManifestMapsInvalidInputLength() {
  val api = FakeGeneratedRustIdentityApi(
    signature = RustBytesFfiResult(code = RustIdentityStableCode.INVALID_INPUT_LENGTH, bytes = ByteArray(0)),
  )
  val result = GeneratedRustIdentityBridge(api).signManifest(IdentityHandle(99), ByteArray(0))
  bridgeAssertTrue(result.code == IdentitySignCode.INVALID_INPUT_LENGTH)
  bridgeAssertTrue(result.signature.isEmpty())
}

private fun identityBridgeCloseMapsNotFound() {
  val api = FakeGeneratedRustIdentityApi(closeCode = RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND)
  bridgeAssertTrue(GeneratedRustIdentityBridge(api).closeIdentity(IdentityHandle(99)) == IdentityCloseCode.NOT_FOUND)

  val okApi = FakeGeneratedRustIdentityApi(closeCode = RustIdentityStableCode.OK)
  bridgeAssertTrue(GeneratedRustIdentityBridge(okApi).closeIdentity(IdentityHandle(99)) == IdentityCloseCode.SUCCESS)
}

private fun identityDtosRedactKeyMaterial() {
  val handle = IdentityHandle(7)
  bridgeAssertTrue("IdentityHandle(<redacted>)" == handle.toString())

  val createResult = IdentityCreateResult(
    code = IdentityCreateCode.SUCCESS,
    handle = IdentityHandle(7),
    signingPubkey = ByteArray(32) { 0x11 },
    encryptionPubkey = ByteArray(32) { 0x22 },
    wrappedSeed = ByteArray(64) { 0x33 },
  )
  val createString = createResult.toString()
  bridgeAssertTrue("signingPubkey=<redacted>" in createString)
  bridgeAssertTrue("encryptionPubkey=<redacted>" in createString)
  bridgeAssertTrue("wrappedSeed=<redacted>" in createString)

  val signing = IdentityPubkeyResult(IdentityPubkeyCode.SUCCESS, ByteArray(32) { 0xAB.toByte() })
  bridgeAssertTrue("pubkey=<redacted>" in signing.toString())

  val signature = ManifestSignatureResult(IdentitySignCode.SUCCESS, ByteArray(64) { 0xCD.toByte() })
  bridgeAssertTrue("signature=<redacted>" in signature.toString())
}

// endregion

// region epoch bridge

private fun epochBridgeCreateMapsOkAndMissingAccountHandle() {
  val seed = ByteArray(48) { 0x44 }
  val expectedSeed = seed.copyOf()
  val okApi = FakeGeneratedRustEpochApi(
    create = RustEpochHandleFfiResult(
      code = RustEpochStableCode.OK,
      handle = 88,
      epochId = 5,
      wrappedEpochSeed = seed,
      signPublicKey = ByteArray(32),
    ),
  )
  val ok = GeneratedRustEpochBridge(okApi).createEpoch(AccountKeyHandle(7), epochId = 5)
  bridgeAssertTrue(ok.code == EpochCreateCode.SUCCESS)
  bridgeAssertTrue(ok.handle?.value == 88L)
  bridgeAssertTrue(ok.epochId == 5)
  bridgeAssertTrue(ok.wrappedEpochSeed.contentEquals(expectedSeed))
  bridgeAssertTrue(seed.all { it == 0.toByte() })

  val missingApi = FakeGeneratedRustEpochApi(
    create = RustEpochHandleFfiResult(
      code = RustEpochStableCode.SECRET_HANDLE_NOT_FOUND,
      handle = 0,
      epochId = 0,
      wrappedEpochSeed = ByteArray(0),
      signPublicKey = ByteArray(0),
    ),
  )
  val missing = GeneratedRustEpochBridge(missingApi).createEpoch(AccountKeyHandle(7), epochId = 5)
  bridgeAssertTrue(missing.code == EpochCreateCode.ACCOUNT_HANDLE_NOT_FOUND)
  bridgeAssertTrue(missing.handle == null)
}

private fun epochBridgeOpenMapsWrappedKeyTooShort() {
  val api = FakeGeneratedRustEpochApi(
    open = RustEpochHandleFfiResult(
      code = RustEpochStableCode.WRAPPED_KEY_TOO_SHORT,
      handle = 0,
      epochId = 0,
      wrappedEpochSeed = ByteArray(0),
      signPublicKey = ByteArray(0),
    ),
  )
  val result = GeneratedRustEpochBridge(api).openEpoch(ByteArray(8), AccountKeyHandle(7), epochId = 1)
  bridgeAssertTrue(result.code == EpochOpenCode.WRAPPED_KEY_TOO_SHORT)
  bridgeAssertTrue(result.handle == null)
}

private fun epochBridgeIsOpenReflectsStatus() {
  val openApi = FakeGeneratedRustEpochApi(
    status = RustEpochHandleStatusFfiResult(code = RustEpochStableCode.OK, isOpen = true),
  )
  bridgeAssertTrue(GeneratedRustEpochBridge(openApi).isEpochOpen(EpochKeyHandle(99)))

  val closedApi = FakeGeneratedRustEpochApi(
    status = RustEpochHandleStatusFfiResult(code = RustEpochStableCode.OK, isOpen = false),
  )
  bridgeAssertFalse(GeneratedRustEpochBridge(closedApi).isEpochOpen(EpochKeyHandle(99)))

  val errorApi = FakeGeneratedRustEpochApi(
    status = RustEpochHandleStatusFfiResult(code = RustEpochStableCode.EPOCH_HANDLE_NOT_FOUND, isOpen = false),
  )
  bridgeAssertFalse(GeneratedRustEpochBridge(errorApi).isEpochOpen(EpochKeyHandle(99)))
}

private fun epochBridgeCloseMapsNotFound() {
  val api = FakeGeneratedRustEpochApi(closeCode = RustEpochStableCode.EPOCH_HANDLE_NOT_FOUND)
  bridgeAssertTrue(GeneratedRustEpochBridge(api).closeEpoch(EpochKeyHandle(99)) == EpochCloseCode.NOT_FOUND)

  val okApi = FakeGeneratedRustEpochApi(closeCode = RustEpochStableCode.OK)
  bridgeAssertTrue(GeneratedRustEpochBridge(okApi).closeEpoch(EpochKeyHandle(99)) == EpochCloseCode.SUCCESS)
}

private fun epochDtosRedactWrappedSeed() {
  val handle = EpochKeyHandle(7)
  bridgeAssertTrue("EpochKeyHandle(<redacted>)" == handle.toString())

  val result = EpochCreateResult(
    code = EpochCreateCode.SUCCESS,
    handle = EpochKeyHandle(7),
    epochId = 5,
    wrappedEpochSeed = ByteArray(48) { 0x44 },
  )
  bridgeAssertTrue("wrappedEpochSeed=<redacted>" in result.toString())
}

// endregion

// region shard bridge

private fun shardEncryptMapsOkAndRejectsEmpty() {
  val envelope = ByteArray(128) { it.toByte() }
  val expectedEnvelope = envelope.copyOf()
  val sha = "a".repeat(64)
  val api = FakeGeneratedRustShardApi(
    encrypt = RustEncryptedShardFfiResult(
      code = RustShardStableCode.OK,
      envelopeBytes = envelope,
      sha256 = sha,
    ),
  )
  val bridge = GeneratedRustShardBridge(api)
  val result = bridge.encryptShard(EpochKeyHandle(99), ByteArray(32) { it.toByte() }, shardIndex = 0, tier = 1)
  bridgeAssertTrue(result.code == ShardEncryptCode.SUCCESS)
  val env = result.envelope ?: error("expected envelope")
  bridgeAssertTrue(env.envelopeBytes.contentEquals(expectedEnvelope))
  bridgeAssertTrue(env.sha256 == sha)
  bridgeAssertTrue(envelope.all { it == 0.toByte() })

  bridgeExpectThrows("empty plaintext") {
    bridge.encryptShard(EpochKeyHandle(99), ByteArray(0), shardIndex = 0, tier = 1)
  }
  bridgeExpectThrows("invalid tier") {
    bridge.encryptShard(EpochKeyHandle(99), ByteArray(8), shardIndex = 0, tier = 0)
  }
}

private fun shardEncryptMapsRngFailure() {
  val api = FakeGeneratedRustShardApi(
    encrypt = RustEncryptedShardFfiResult(
      code = RustShardStableCode.RNG_FAILURE,
      envelopeBytes = ByteArray(0),
      sha256 = "0".repeat(64),
    ),
  )
  val result = GeneratedRustShardBridge(api).encryptShard(EpochKeyHandle(99), ByteArray(8), shardIndex = 0, tier = 1)
  bridgeAssertTrue(result.code == ShardEncryptCode.RNG_FAILURE)
  bridgeAssertTrue(result.envelope == null)
}

private fun shardDecryptMapsOkAndAuthFailure() {
  val plaintext = ByteArray(48) { it.toByte() }
  val okApi = FakeGeneratedRustShardApi(
    decrypt = RustDecryptedShardFfiResult(code = RustShardStableCode.OK, plaintext = plaintext),
  )
  val ok = GeneratedRustShardBridge(okApi).decryptShard(EpochKeyHandle(99), ByteArray(64) { it.toByte() })
  bridgeAssertTrue(ok.code == ShardDecryptCode.SUCCESS)
  val shard = ok.shard ?: error("expected shard")
  bridgeAssertTrue(shard.plaintext.contentEquals(plaintext))

  val authApi = FakeGeneratedRustShardApi(
    decrypt = RustDecryptedShardFfiResult(code = RustShardStableCode.AUTHENTICATION_FAILED, plaintext = ByteArray(0)),
  )
  val auth = GeneratedRustShardBridge(authApi).decryptShard(EpochKeyHandle(99), ByteArray(64) { it.toByte() })
  bridgeAssertTrue(auth.code == ShardDecryptCode.AUTHENTICATION_FAILED)
  bridgeAssertTrue(auth.shard == null)
}

private fun decryptedShardWipeBlocksAccess() {
  val plaintext = ByteArray(32) { 0x55 }
  val shard = DecryptedShard(plaintext)
  bridgeAssertTrue(shard.plaintext.contentEquals(plaintext))
  shard.wipe()
  bridgeExpectThrows("wiped plaintext access") { shard.plaintext }
}

private fun shardDtosRedactCiphertextAndPlaintext() {
  val envelope = EncryptedShardEnvelope(
    envelopeBytes = ByteArray(128) { it.toByte() },
    sha256 = "f".repeat(64),
  )
  val envString = envelope.toString()
  bridgeAssertTrue("envelopeBytes=<redacted>" in envString)
  bridgeAssertTrue("sha256=" + "f".repeat(64) in envString)

  val shard = DecryptedShard(ByteArray(32) { 0x55 })
  bridgeAssertTrue("DecryptedShard(<redacted>)" == shard.toString())

  bridgeExpectThrows("invalid sha256 length") { EncryptedShardEnvelope(ByteArray(8), "abc") }
  bridgeExpectThrows("invalid sha256 chars") { EncryptedShardEnvelope(ByteArray(8), "z".repeat(64)) }
}

// endregion

// region metadata sidecar bridge

private fun metadataSidecarCanonicalMapsOk() {
  val canonical = ByteArray(64) { it.toByte() }
  val expectedCanonical = canonical.copyOf()
  val api = FakeGeneratedRustMetadataSidecarApi(
    canonical = RustBytesFfiResult(code = RustMetadataSidecarStableCode.OK, bytes = canonical),
  )
  val request = CanonicalMetadataSidecarRequest(
    albumId = ByteArray(16) { it.toByte() },
    photoId = ByteArray(16) { it.toByte() },
    epochId = 1,
    encodedFields = ByteArray(8) { it.toByte() },
  )
  val result = GeneratedRustMetadataSidecarBridge(api).canonicalMetadataSidecar(request)
  bridgeAssertTrue(result.code == MetadataSidecarBuildCode.SUCCESS)
  bridgeAssertTrue(result.sidecar?.bytes?.contentEquals(expectedCanonical) == true)
  bridgeAssertTrue(canonical.all { it == 0.toByte() })
}

private fun metadataSidecarEncryptMapsInvalidFormat() {
  val api = FakeGeneratedRustMetadataSidecarApi(
    encryptMedia = RustEncryptedShardFfiResult(
      code = RustMetadataSidecarStableCode.UNSUPPORTED_MEDIA_FORMAT,
      envelopeBytes = ByteArray(0),
      sha256 = "0".repeat(64),
    ),
  )
  val request = EncryptMediaMetadataSidecarRequest(
    epochKeyHandle = EpochKeyHandle(99),
    albumId = ByteArray(16) { it.toByte() },
    photoId = ByteArray(16) { it.toByte() },
    epochId = 1,
    mediaBytes = ByteArray(64) { it.toByte() },
    shardIndex = 0,
  )
  val result = GeneratedRustMetadataSidecarBridge(api).encryptMediaMetadataSidecar(request)
  bridgeAssertTrue(result.code == MetadataSidecarEncryptCode.INVALID_MEDIA_FORMAT)
  bridgeAssertTrue(result.envelope == null)
}

private fun metadataSidecarRequestDtosRedactBytes() {
  val request = CanonicalMetadataSidecarRequest(
    albumId = ByteArray(16) { it.toByte() },
    photoId = ByteArray(16) { it.toByte() },
    epochId = 1,
    encodedFields = ByteArray(8) { it.toByte() },
  )
  val s = request.toString()
  bridgeAssertTrue("albumId=<redacted>" in s)
  bridgeAssertTrue("photoId=<redacted>" in s)
  bridgeAssertTrue("encodedFields=<redacted>" in s)

  val sidecar = CanonicalMetadataSidecar(ByteArray(8))
  bridgeAssertTrue("CanonicalMetadataSidecar(<redacted>)" == sidecar.toString())
}

// endregion

// region album sync bridge

private fun albumSyncBridgeAcceptsInitialStart() {
  val api = FakeGeneratedRustAlbumSyncApi()
  val bridge = GeneratedRustAlbumSyncBridge(api)
  val result = bridge.startAlbumSync(
    AlbumSyncStartRequest(
      albumId = AlbumId("album-1"),
      requestId = AlbumSyncRequestId("req-1"),
      startCursor = AlbumSyncCursor(""),
      nowUnixMs = 1_700_000_000_000,
      maxRetryCount = 3,
    ),
  )
  bridgeAssertTrue(result.code == AlbumSyncHandoffCode.ACCEPTED)
  bridgeAssertTrue(result.phase == "FetchingPage")
  bridgeAssertTrue(result.activeCursor == null || result.activeCursor!!.value == "")
  bridgeAssertTrue(result.retryCount == 0)
}

private fun albumSyncBridgeMapsInvalidTransition() {
  val api = FakeGeneratedRustAlbumSyncApi(initCode = RustClientCoreSyncStableCode.CLIENT_CORE_INVALID_TRANSITION)
  val bridge = GeneratedRustAlbumSyncBridge(api)
  val result = bridge.startAlbumSync(
    AlbumSyncStartRequest(
      albumId = AlbumId("album-1"),
      requestId = AlbumSyncRequestId("req-1"),
      startCursor = AlbumSyncCursor(""),
      nowUnixMs = 1L,
      maxRetryCount = 0,
    ),
  )
  bridgeAssertTrue(result.code == AlbumSyncHandoffCode.INVALID_TRANSITION)
  bridgeAssertTrue(result.phase.isEmpty())
}

private fun albumSyncBridgeMapsRetryBudgetExhaustion() {
  val api = FakeGeneratedRustAlbumSyncApi(advanceCode = RustClientCoreSyncStableCode.CLIENT_CORE_RETRY_BUDGET_EXHAUSTED)
  val bridge = GeneratedRustAlbumSyncBridge(api)
  val result = bridge.startAlbumSync(
    AlbumSyncStartRequest(
      albumId = AlbumId("album-1"),
      requestId = AlbumSyncRequestId("req-1"),
      startCursor = AlbumSyncCursor(""),
      nowUnixMs = 1L,
      maxRetryCount = 0,
    ),
  )
  bridgeAssertTrue(result.code == AlbumSyncHandoffCode.RETRY_BUDGET_EXHAUSTED)
}

private fun albumSyncDtosRedactCursorsAndAssetIds() {
  val cursor = AlbumSyncCursor("cursor-token-12345")
  bridgeAssertTrue("AlbumSyncCursor(<redacted>)" == cursor.toString())

  val requestId = AlbumSyncRequestId("req-1")
  bridgeAssertTrue("AlbumSyncRequestId(<redacted>)" == requestId.toString())

  val event = RustClientCoreAlbumSyncFfiEvent(
    kind = "PageFetched",
    fetchedCursor = "page-1",
    nextCursor = "page-2",
    appliedCount = 0,
    observedAssetIds = listOf("asset-1", "asset-2"),
    retryAfterUnixMs = 0,
    errorCode = 0,
    hasErrorCode = false,
  )
  val s = event.toString()
  bridgeAssertTrue("fetchedCursor=<redacted>" in s)
  bridgeAssertTrue("nextCursor=<redacted>" in s)
  bridgeAssertTrue("observedAssetIds=<redacted>" in s)
}

// endregion

// region diagnostics bridge

private fun diagnosticsProtocolVersion() {
  val api = FakeGeneratedRustDiagnosticsApi(version = "mosaic-v1")
  bridgeAssertTrue(GeneratedRustDiagnosticsBridge(api).protocolVersion() == "mosaic-v1")

  val blankApi = FakeGeneratedRustDiagnosticsApi(version = "")
  bridgeExpectThrows("blank protocol version") { GeneratedRustDiagnosticsBridge(blankApi).protocolVersion() }
}

private fun diagnosticsGoldenVectorRedacted() {
  val ffi = RustDiagnosticsGoldenVectorFfi(
    code = 0,
    envelopeHeader = ByteArray(64) { it.toByte() },
    envelopeEpochId = 1,
    envelopeShardIndex = 0,
    envelopeTier = 1,
    envelopeNonce = ByteArray(24) { it.toByte() },
    manifestTranscript = ByteArray(48) { it.toByte() },
    identityMessage = ByteArray(48) { it.toByte() },
    identitySigningPubkey = ByteArray(32) { 0x11 },
    identityEncryptionPubkey = ByteArray(32) { 0x22 },
    identitySignature = ByteArray(64) { 0x33 },
  )
  val api = FakeGeneratedRustDiagnosticsApi(golden = ffi)
  val snapshot = GeneratedRustDiagnosticsBridge(api).cryptoDomainGoldenVector()
  bridgeAssertTrue(snapshot.envelopeEpochId == 1)
  bridgeAssertTrue(snapshot.envelopeShardIndex == 0)
  bridgeAssertTrue(snapshot.envelopeTier == 1)
  val s = snapshot.toString()
  bridgeAssertTrue("envelopeHeader=<opaque>" in s)
  bridgeAssertTrue("envelopeNonce=<opaque>" in s)
  bridgeAssertTrue("manifestTranscript=<opaque>" in s)
  bridgeAssertTrue("identitySignature=<opaque>" in s)
}

private fun diagnosticsStateMachineSnapshot() {
  val api = FakeGeneratedRustDiagnosticsApi(stateMachineDescriptor = "client-core-state-machines:v1")
  bridgeAssertTrue(GeneratedRustDiagnosticsBridge(api).clientCoreStateMachineSnapshot() == "client-core-state-machines:v1")

  val blankApi = FakeGeneratedRustDiagnosticsApi(stateMachineDescriptor = "")
  bridgeExpectThrows("blank state machine descriptor") {
    GeneratedRustDiagnosticsBridge(blankApi).clientCoreStateMachineSnapshot()
  }
}

// endregion

// region media inspection / tier layout

private fun mediaInspectionMapsOkAndRejectsEmpty() {
  val api = FakeGeneratedRustMediaApiBridge(
    inspect = RustMediaMetadataFfiResult(
      code = RustMediaInspectionStableCode.OK,
      format = "JPEG",
      mimeType = "image/jpeg",
      width = 1024,
      height = 768,
      orientation = 1,
    ),
  )
  val result = GeneratedRustMediaBridge(api).inspectMediaImage(ByteArray(64) { it.toByte() })
  bridgeAssertTrue(result.code == MediaInspectionCode.SUCCESS)
  val md = result.metadata ?: error("expected metadata")
  bridgeAssertTrue(md.format == "JPEG")
  bridgeAssertTrue(md.mimeType == "image/jpeg")
  bridgeAssertTrue(md.width == 1024 && md.height == 768)
  bridgeAssertTrue(md.orientation == 1)

  bridgeExpectThrows("empty bytes") { GeneratedRustMediaBridge(api).inspectMediaImage(ByteArray(0)) }
}

private fun mediaInspectionMapsUnsupportedFormat() {
  val api = FakeGeneratedRustMediaApiBridge(
    inspect = RustMediaMetadataFfiResult(
      code = RustMediaInspectionStableCode.UNSUPPORTED_MEDIA_FORMAT,
      format = "",
      mimeType = "",
      width = 0,
      height = 0,
      orientation = 0,
    ),
  )
  val result = GeneratedRustMediaBridge(api).inspectMediaImage(ByteArray(64))
  bridgeAssertTrue(result.code == MediaInspectionCode.UNSUPPORTED_MEDIA_FORMAT)
  bridgeAssertTrue(result.metadata == null)
}

private fun mediaTierLayoutMapsOk() {
  val api = FakeGeneratedRustMediaApiBridge(
    layout = RustMediaTierLayoutFfiResult(
      code = RustMediaInspectionStableCode.OK,
      thumbnail = RustMediaTierDimensionsFfi(tier = 1, width = 256, height = 192),
      preview = RustMediaTierDimensionsFfi(tier = 2, width = 1024, height = 768),
      original = RustMediaTierDimensionsFfi(tier = 3, width = 4096, height = 3072),
    ),
  )
  val result = GeneratedRustMediaBridge(api).planMediaTierLayout(width = 4096, height = 3072)
  bridgeAssertTrue(result.code == MediaTierLayoutCode.SUCCESS)
  val layout = result.layout ?: error("expected layout")
  bridgeAssertTrue(layout.thumbnail.tier == 1 && layout.thumbnail.width == 256)
  bridgeAssertTrue(layout.preview.tier == 2 && layout.preview.width == 1024)
  bridgeAssertTrue(layout.original.tier == 3 && layout.original.width == 4096)
}

private fun mediaTierLayoutMapsInvalidDimensions() {
  val api = FakeGeneratedRustMediaApiBridge(
    layout = RustMediaTierLayoutFfiResult(
      code = RustMediaInspectionStableCode.INVALID_MEDIA_DIMENSIONS,
      thumbnail = RustMediaTierDimensionsFfi(0, 0, 0),
      preview = RustMediaTierDimensionsFfi(0, 0, 0),
      original = RustMediaTierDimensionsFfi(0, 0, 0),
    ),
  )
  val result = GeneratedRustMediaBridge(api).planMediaTierLayout(width = 1, height = 1)
  bridgeAssertTrue(result.code == MediaTierLayoutCode.INVALID_MEDIA_DIMENSIONS)
  bridgeAssertTrue(result.layout == null)
}

// endregion

// region cross-cutting privacy

private fun publicBridgeDtosAvoidPrivacyForbiddenText() {
  val forbiddenTerms = listOf("IMG_0001", "content://", "file://", "gps", "latitude", "EXIF", "PLAINTEXT")
  val candidates = listOf<Any>(
    IdentityHandle(7).toString(),
    EpochKeyHandle(7).toString(),
    AlbumSyncCursor("anything").toString(),
    AlbumSyncRequestId("req-1").toString(),
    EncryptedShardEnvelope(ByteArray(8), "0".repeat(64)).toString(),
    DecryptedShard(ByteArray(8)).toString(),
    CanonicalMetadataSidecar(ByteArray(8)).toString(),
    CanonicalMetadataSidecarRequest(
      albumId = ByteArray(8) { it.toByte() },
      photoId = ByteArray(8) { it.toByte() },
      epochId = 1,
      encodedFields = ByteArray(8) { it.toByte() },
    ).toString(),
    EncryptMediaMetadataSidecarRequest(
      epochKeyHandle = EpochKeyHandle(99),
      albumId = ByteArray(8) { it.toByte() },
      photoId = ByteArray(8) { it.toByte() },
      epochId = 1,
      mediaBytes = ByteArray(8) { it.toByte() },
      shardIndex = 0,
    ).toString(),
  )
  for (s in candidates) {
    val text = s.toString()
    for (term in forbiddenTerms) {
      bridgeAssertFalse(text.contains(term, ignoreCase = true))
    }
  }
}

// endregion

// region slice-0c DTO redaction (SPEC-CrossPlatformHardening Android shell)

private fun rustLinkKeysFfiResultRedactsBytes() {
  // Use real-shaped bytes (16 + 32) so the size suffix is meaningful but the
  // raw values must not appear in toString output.
  val linkId = ByteArray(16) { 0x11 }
  val wrappingKey = ByteArray(32) { 0x22 }
  val ffi = RustLinkKeysFfiResult(
    code = RustLinkKeysStableCode.OK,
    linkId = linkId,
    wrappingKey = wrappingKey,
  )
  val s = ffi.toString()
  bridgeAssertTrue("linkId=<redacted" in s)
  bridgeAssertTrue("wrappingKey=<redacted" in s)
  // The high-level LinkKeysResult must also redact.
  val high = LinkKeysResult(
    code = LinkKeysCode.SUCCESS,
    linkId = linkId,
    wrappingKey = wrappingKey,
  )
  val highStr = high.toString()
  bridgeAssertTrue("linkId=<redacted" in highStr)
  bridgeAssertTrue("wrappingKey=<redacted" in highStr)
  // No raw byte-pattern (0x11 / 0x22) leaks as text — search for typical hex
  // / decimal renderings that a default toString could have produced.
  for (forbidden in listOf("[17,", "17, 17", "[34,", "34, 34", "[B@")) {
    bridgeAssertFalse(s.contains(forbidden))
    bridgeAssertFalse(highStr.contains(forbidden))
  }
}

private fun rustIdentitySeedFfiResultRedactsBytes() {
  val signing = ByteArray(32) { 0x33 }
  val encryption = ByteArray(32) { 0x44 }
  val signature = ByteArray(64) { 0x55 }
  val ffi = RustIdentitySeedFfiResult(
    code = RustIdentitySeedStableCode.OK,
    signingPubkey = signing,
    encryptionPubkey = encryption,
    signature = signature,
  )
  val s = ffi.toString()
  bridgeAssertTrue("signingPubkey=<redacted" in s)
  bridgeAssertTrue("encryptionPubkey=<redacted" in s)
  bridgeAssertTrue("signature=<redacted" in s)

  val high = IdentityFromSeedResult(
    code = IdentityFromSeedCode.SUCCESS,
    signingPubkey = signing,
    encryptionPubkey = encryption,
    signature = signature,
  )
  val highStr = high.toString()
  bridgeAssertTrue("signingPubkey=<redacted" in highStr)
  bridgeAssertTrue("encryptionPubkey=<redacted" in highStr)
  bridgeAssertTrue("signature=<redacted" in highStr)
  for (forbidden in listOf("[51,", "51, 51", "[68,", "68, 68", "[85,", "85, 85", "[B@")) {
    bridgeAssertFalse(s.contains(forbidden))
    bridgeAssertFalse(highStr.contains(forbidden))
  }
}

private fun rustContentDecryptFfiResultRedactsPlaintext() {
  // Use a non-empty plaintext so the size suffix is non-zero. The bytes are
  // SECRET-EQUIVALENT (decrypted album content) and must never reach logs.
  val plaintext = ByteArray(48) { 0x66 }
  val ffi = RustContentDecryptFfiResult(
    code = RustContentDecryptStableCode.OK,
    plaintext = plaintext,
  )
  val s = ffi.toString()
  bridgeAssertTrue("plaintext=<redacted" in s)

  val high = DecryptedContentResult(
    code = ContentDecryptCode.SUCCESS,
    plaintext = plaintext,
  )
  val highStr = high.toString()
  bridgeAssertTrue("plaintext=<redacted" in highStr)
  for (forbidden in listOf("102, 102", "[102,", "[B@")) {
    bridgeAssertFalse(s.contains(forbidden))
    bridgeAssertFalse(highStr.contains(forbidden))
  }
}

private fun authChallengeResultsRedactBytes() {
  // Transcript bytes are derived from the challenge + username + timestamp and
  // are not themselves secret, but logging the full bytes is privacy-noisy
  // and a future analysis could correlate transcripts to users — redact.
  val transcript = ByteArray(96) { 0x77 }
  val transcriptResult = AuthChallengeTranscriptResult(
    code = AuthChallengeTranscriptCode.SUCCESS,
    transcript = transcript,
  )
  bridgeAssertTrue("transcript=<redacted" in transcriptResult.toString())

  val signature = ByteArray(AuthChallengeSignResult.ED25519_SIGNATURE_BYTES) { 0x88.toByte() }
  val signResult = AuthChallengeSignResult(
    code = AuthChallengeSignCode.SUCCESS,
    signature = signature,
  )
  bridgeAssertTrue("signature=<redacted" in signResult.toString())

  // Negative regression: the default data-class style "[B@..." reference text
  // and raw byte sequences must not appear.
  for (forbidden in listOf("[119,", "119, 119", "[136,", "[B@")) {
    bridgeAssertFalse(transcriptResult.toString().contains(forbidden))
    bridgeAssertFalse(signResult.toString().contains(forbidden))
  }
}

private fun rustOpenedBundleFfiResultRedactsAllSensitiveFields() {
  // Recipient pubkey + epoch_seed + sign_public_key are 32 bytes each. The
  // epoch_seed in particular is SECRET-EQUIVALENT and must never reach logs.
  // Album id is a string but is also a privacy-noisy identifier — redacted
  // as `<redacted-${length}-chars>`.
  val recipient = ByteArray(32) { 0x99.toByte() }
  val epochSeed = ByteArray(32) { 0xAA.toByte() }
  val signPub = ByteArray(32) { 0xBB.toByte() }
  val ffi = RustOpenedBundleFfiResult(
    code = RustSealedBundleStableCode.OK,
    version = 1,
    albumId = "album-id-with-leakable-chars",
    epochId = 7,
    recipientPubkey = recipient,
    epochSeed = epochSeed,
    signPublicKey = signPub,
  )
  val s = ffi.toString()
  bridgeAssertTrue("albumId=<redacted" in s)
  bridgeAssertTrue("recipientPubkey=<redacted" in s)
  bridgeAssertTrue("epochSeed=<redacted" in s)
  bridgeAssertTrue("signPublicKey=<redacted" in s)
  // The literal albumId text must not appear:
  bridgeAssertFalse(s.contains("album-id-with-leakable-chars"))
  for (forbidden in listOf("[153,", "153, 153", "[170,", "170, 170", "[187,", "187, 187", "[B@")) {
    bridgeAssertFalse(s.contains(forbidden))
  }
}

private fun openedBundleResultRedactsBytes() {
  val recipient = ByteArray(32) { 0xCC.toByte() }
  val epochSeed = ByteArray(32) { 0xDD.toByte() }
  val signPub = ByteArray(32) { 0xEE.toByte() }
  val high = OpenedBundleResult(
    code = OpenedBundleCode.SUCCESS,
    version = 1,
    albumId = "secret-album-name",
    epochId = 3,
    recipientPubkey = recipient,
    epochSeed = epochSeed,
    signPublicKey = signPub,
  )
  val s = high.toString()
  bridgeAssertTrue("albumId=<redacted" in s)
  bridgeAssertTrue("recipientPubkey=<redacted" in s)
  bridgeAssertTrue("epochSeed=<redacted" in s)
  bridgeAssertTrue("signPublicKey=<redacted" in s)
  bridgeAssertFalse(s.contains("secret-album-name"))
  for (forbidden in listOf("[204,", "204, 204", "[221,", "221, 221", "[238,", "238, 238", "[B@")) {
    bridgeAssertFalse(s.contains(forbidden))
  }
}

private fun rustAccountUnlockFfiResultRedactsHandle() {
  // The raw handle Long is an opaque capability into an unlocked Rust
  // account-key registry; logging it would defeat the same redaction
  // contract `AccountKeyHandle.toString` already enforces. Default
  // data-class toString prints the raw value, so a custom override is
  // required.
  val ffi = RustAccountUnlockFfiResult(
    code = RustClientStableCode.OK,
    handle = 0x4242_DEAD_BEEFL,
  )
  val s = ffi.toString()
  bridgeAssertTrue("handle=<redacted>" in s)
  bridgeAssertFalse(s.contains("0x4242"))
  bridgeAssertFalse(s.contains("4242"))
  bridgeAssertFalse(s.contains("DEADBEEF"))
  bridgeAssertFalse(s.contains("3735928559")) // 0xDEADBEEF in decimal
}

// endregion

// region fakes

private class FakeGeneratedRustHeaderApi(
  private val canned: RustHeaderParseFfiResult,
) : GeneratedRustHeaderApi {
  override fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult = canned
}

private class FakeGeneratedRustProgressApi(
  private val canned: RustProgressFfiResult,
) : GeneratedRustProgressApi {
  override fun probe(totalSteps: Int, cancelAfter: Int?): RustProgressFfiResult = canned
}

private class FakeGeneratedRustIdentityApi(
  private val create: RustIdentityHandleFfiResult? = null,
  private val open: RustIdentityHandleFfiResult? = null,
  private val signingPubkey: RustBytesFfiResult? = null,
  private val encryptionPubkey: RustBytesFfiResult? = null,
  private val signature: RustBytesFfiResult? = null,
  private val closeCode: Int = RustIdentityStableCode.OK,
) : GeneratedRustIdentityApi {
  override fun createIdentityHandle(accountKeyHandle: Long): RustIdentityHandleFfiResult =
    create ?: error("create not configured")

  override fun openIdentityHandle(wrappedSeed: ByteArray, accountKeyHandle: Long): RustIdentityHandleFfiResult =
    open ?: error("open not configured")

  override fun identitySigningPubkey(handle: Long): RustBytesFfiResult =
    signingPubkey ?: error("signingPubkey not configured")

  override fun identityEncryptionPubkey(handle: Long): RustBytesFfiResult =
    encryptionPubkey ?: error("encryptionPubkey not configured")

  override fun signManifestWithIdentity(handle: Long, transcriptBytes: ByteArray): RustBytesFfiResult =
    signature ?: error("signature not configured")

  override fun closeIdentityHandle(handle: Long): Int = closeCode
}

private class FakeGeneratedRustEpochApi(
  private val create: RustEpochHandleFfiResult? = null,
  private val open: RustEpochHandleFfiResult? = null,
  private val status: RustEpochHandleStatusFfiResult? = null,
  private val closeCode: Int = RustEpochStableCode.OK,
) : GeneratedRustEpochApi {
  override fun createEpochKeyHandle(accountKeyHandle: Long, epochId: Int): RustEpochHandleFfiResult =
    create ?: error("create not configured")

  override fun openEpochKeyHandle(
    wrappedEpochSeed: ByteArray,
    accountKeyHandle: Long,
    epochId: Int,
  ): RustEpochHandleFfiResult = open ?: error("open not configured")

  override fun epochKeyHandleIsOpen(handle: Long): RustEpochHandleStatusFfiResult =
    status ?: error("status not configured")

  override fun closeEpochKeyHandle(handle: Long): Int = closeCode
}

private class FakeGeneratedRustShardApi(
  private val encrypt: RustEncryptedShardFfiResult? = null,
  private val decrypt: RustDecryptedShardFfiResult? = null,
) : GeneratedRustShardApi {
  override fun encryptShardWithEpochHandle(
    epochKeyHandle: Long,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): RustEncryptedShardFfiResult = encrypt ?: error("encrypt not configured")

  override fun decryptShardWithEpochHandle(
    epochKeyHandle: Long,
    envelopeBytes: ByteArray,
  ): RustDecryptedShardFfiResult = decrypt ?: error("decrypt not configured")
}

private class FakeGeneratedRustMetadataSidecarApi(
  private val canonical: RustBytesFfiResult? = null,
  private val canonicalMedia: RustBytesFfiResult? = null,
  private val encrypt: RustEncryptedShardFfiResult? = null,
  private val encryptMedia: RustEncryptedShardFfiResult? = null,
) : GeneratedRustMetadataSidecarApi {
  override fun canonicalMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
  ): RustBytesFfiResult = canonical ?: error("canonical not configured")

  override fun encryptMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult = encrypt ?: error("encrypt not configured")

  override fun canonicalMediaMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
  ): RustBytesFfiResult = canonicalMedia ?: error("canonicalMedia not configured")

  override fun encryptMediaMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult = encryptMedia ?: error("encryptMedia not configured")
}

private class FakeGeneratedRustAlbumSyncApi(
  private val initCode: Int = RustClientCoreSyncStableCode.OK,
  private val advanceCode: Int = RustClientCoreSyncStableCode.OK,
) : GeneratedRustAlbumSyncApi {
  override fun initAlbumSync(request: RustClientCoreAlbumSyncFfiRequest): RustClientCoreAlbumSyncFfiResult =
    RustClientCoreAlbumSyncFfiResult(
      code = initCode,
      snapshot = RustClientCoreAlbumSyncFfiSnapshot(
        schemaVersion = 1,
        albumId = request.albumId,
        phase = "Queued",
        activeCursor = request.startCursor,
        pendingCursor = "",
        rerunRequested = false,
        retryCount = 0,
        maxRetryCount = request.maxRetryCount,
        nextRetryUnixMs = 0,
        lastErrorCode = 0,
        lastErrorStage = "",
        updatedAtUnixMs = request.nowUnixMs,
      ),
    )

  override fun advanceAlbumSync(
    snapshot: RustClientCoreAlbumSyncFfiSnapshot,
    event: RustClientCoreAlbumSyncFfiEvent,
  ): RustClientCoreAlbumSyncTransitionFfiResult = RustClientCoreAlbumSyncTransitionFfiResult(
    code = advanceCode,
    transition = RustClientCoreAlbumSyncFfiTransition(
      snapshot = snapshot.copy(phase = "FetchingPage"),
      effects = listOf(RustClientCoreAlbumSyncFfiEffect(kind = "FetchPage", cursor = snapshot.activeCursor)),
    ),
  )
}

private class FakeGeneratedRustDiagnosticsApi(
  private val version: String = "mosaic-v1",
  private val golden: RustDiagnosticsGoldenVectorFfi? = null,
  private val stateMachineDescriptor: String = "client-core-state-machines:v1",
) : GeneratedRustDiagnosticsApi {
  override fun protocolVersion(): String = version

  override fun cryptoDomainGoldenVectorSnapshot(): RustDiagnosticsGoldenVectorFfi =
    golden ?: error("golden vector not configured")

  override fun clientCoreStateMachineSnapshot(): String = stateMachineDescriptor
}

private class FakeGeneratedRustMediaApiBridge(
  private val plan: RustMediaPlanFfiResult? = null,
  private val inspect: RustMediaMetadataFfiResult? = null,
  private val layout: RustMediaTierLayoutFfiResult? = null,
) : GeneratedRustMediaApi {
  override fun planMediaTiers(request: RustMediaPlanFfiRequest): RustMediaPlanFfiResult =
    plan ?: error("plan not configured")

  override fun inspectMediaImage(bytes: ByteArray): RustMediaMetadataFfiResult =
    inspect ?: error("inspect not configured")

  override fun planMediaTierLayout(width: Int, height: Int): RustMediaTierLayoutFfiResult =
    layout ?: error("layout not configured")
}

// endregion

// region iteration-3: wipe discipline on sensitive byte-array containers

private fun identityCreateResultWipesAllSensitiveBytes() {
  val result = IdentityCreateResult(
    code = IdentityCreateCode.SUCCESS,
    handle = IdentityHandle(1),
    signingPubkey = ByteArray(32) { 1 },
    encryptionPubkey = ByteArray(32) { 2 },
    wrappedSeed = ByteArray(64) { 3 },
  )
  bridgeAssertTrue(result.signingPubkey.any { it != 0.toByte() })
  bridgeAssertTrue(result.encryptionPubkey.any { it != 0.toByte() })
  bridgeAssertTrue(result.wrappedSeed.any { it != 0.toByte() })
  result.wipe()
  bridgeAssertTrue(result.signingPubkey.all { it == 0.toByte() })
  bridgeAssertTrue(result.encryptionPubkey.all { it == 0.toByte() })
  bridgeAssertTrue(result.wrappedSeed.all { it == 0.toByte() })
}

private fun identityOpenResultWipesPubkeys() {
  val result = IdentityOpenResult(
    code = IdentityOpenCode.SUCCESS,
    handle = IdentityHandle(1),
    signingPubkey = ByteArray(32) { 1 },
    encryptionPubkey = ByteArray(32) { 2 },
  )
  result.wipe()
  bridgeAssertTrue(result.signingPubkey.all { it == 0.toByte() })
  bridgeAssertTrue(result.encryptionPubkey.all { it == 0.toByte() })
}

private fun identityPubkeyResultWipesPubkey() {
  val result = IdentityPubkeyResult(
    code = IdentityPubkeyCode.SUCCESS,
    pubkey = ByteArray(32) { 7 },
  )
  result.wipe()
  bridgeAssertTrue(result.pubkey.all { it == 0.toByte() })
}

private fun manifestSignatureResultWipesSignature() {
  val result = ManifestSignatureResult(
    code = IdentitySignCode.SUCCESS,
    signature = ByteArray(64) { 9 },
  )
  result.wipe()
  bridgeAssertTrue(result.signature.all { it == 0.toByte() })
}

private fun epochCreateResultWipesWrappedSeed() {
  val result = EpochCreateResult(
    code = EpochCreateCode.SUCCESS,
    handle = EpochKeyHandle(1),
    epochId = 0,
    wrappedEpochSeed = ByteArray(64) { 5 },
  )
  bridgeAssertTrue(result.wrappedEpochSeed.any { it != 0.toByte() })
  result.wipe()
  bridgeAssertTrue(result.wrappedEpochSeed.all { it == 0.toByte() })
}

private fun decryptedShardFfiResultWipesPlaintext() {
  val ffi = RustDecryptedShardFfiResult(
    code = RustShardStableCode.OK,
    plaintext = ByteArray(32) { 0xCC.toByte() },
  )
  bridgeAssertTrue(ffi.plaintext.any { it != 0.toByte() })
  ffi.wipe()
  bridgeAssertTrue(ffi.plaintext.all { it == 0.toByte() })
}

private fun shardBridgeWipesFfiResultAfterDecrypt() {
  val plaintext = ByteArray(48) { 0x42 }
  val ffi = RustDecryptedShardFfiResult(code = RustShardStableCode.OK, plaintext = plaintext)
  val api = SharedFfiResultShardApi(decryptResult = ffi)
  val result = GeneratedRustShardBridge(api).decryptShard(EpochKeyHandle(1), ByteArray(64) { it.toByte() })
  bridgeAssertTrue(result.code == ShardDecryptCode.SUCCESS)
  // The downstream DecryptedShard has its own copy.
  bridgeAssertTrue(result.shard?.plaintext?.contentEquals(plaintext) == true)
  // The intermediate FFI buffer was zeroed in the bridge's `finally` block.
  bridgeAssertTrue(ffi.plaintext.all { it == 0.toByte() })
}

private fun encryptShardWipingPlaintextWipesCallerPlaintext() {
  val plaintext = ByteArray(32) { 0x77 }
  val api = FakeGeneratedRustShardApi(
    encrypt = RustEncryptedShardFfiResult(
      code = RustShardStableCode.OK,
      envelopeBytes = ByteArray(128) { it.toByte() },
      sha256 = "0".repeat(64),
    ),
  )
  val bridge = GeneratedRustShardBridge(api)
  val result = bridge.encryptShardWipingPlaintext(EpochKeyHandle(1), plaintext, shardIndex = 0, tier = 1)
  bridgeAssertTrue(result.code == ShardEncryptCode.SUCCESS)
  bridgeAssertTrue(plaintext.all { it == 0.toByte() })
}

private fun metadataSidecarRequestsWipeAllBytes() {
  val canonical = CanonicalMetadataSidecarRequest(
    albumId = ByteArray(16) { 1 },
    photoId = ByteArray(16) { 2 },
    epochId = 0,
    encodedFields = ByteArray(8) { 3 },
  )
  canonical.wipe()
  bridgeAssertTrue(canonical.albumId.all { it == 0.toByte() })
  bridgeAssertTrue(canonical.photoId.all { it == 0.toByte() })
  bridgeAssertTrue(canonical.encodedFields.all { it == 0.toByte() })

  val encrypt = EncryptMetadataSidecarRequest(
    epochKeyHandle = EpochKeyHandle(1),
    albumId = ByteArray(16) { 4 },
    photoId = ByteArray(16) { 5 },
    epochId = 0,
    encodedFields = ByteArray(8) { 6 },
    shardIndex = 0,
  )
  encrypt.wipe()
  bridgeAssertTrue(encrypt.albumId.all { it == 0.toByte() })
  bridgeAssertTrue(encrypt.photoId.all { it == 0.toByte() })
  bridgeAssertTrue(encrypt.encodedFields.all { it == 0.toByte() })

  val canonicalMedia = CanonicalMediaMetadataSidecarRequest(
    albumId = ByteArray(16) { 7 },
    photoId = ByteArray(16) { 8 },
    epochId = 0,
    mediaBytes = ByteArray(64) { 9 },
  )
  canonicalMedia.wipe()
  bridgeAssertTrue(canonicalMedia.albumId.all { it == 0.toByte() })
  bridgeAssertTrue(canonicalMedia.photoId.all { it == 0.toByte() })
  bridgeAssertTrue(canonicalMedia.mediaBytes.all { it == 0.toByte() })

  val encryptMedia = EncryptMediaMetadataSidecarRequest(
    epochKeyHandle = EpochKeyHandle(1),
    albumId = ByteArray(16) { 10 },
    photoId = ByteArray(16) { 11 },
    epochId = 0,
    mediaBytes = ByteArray(64) { 12 },
    shardIndex = 0,
  )
  encryptMedia.wipe()
  bridgeAssertTrue(encryptMedia.albumId.all { it == 0.toByte() })
  bridgeAssertTrue(encryptMedia.photoId.all { it == 0.toByte() })
  bridgeAssertTrue(encryptMedia.mediaBytes.all { it == 0.toByte() })
}

private fun canonicalMetadataSidecarWipes() {
  val sidecar = CanonicalMetadataSidecar(ByteArray(16) { 0xAA.toByte() })
  bridgeAssertTrue(sidecar.bytes.any { it != 0.toByte() })
  sidecar.wipe()
  bridgeAssertTrue(sidecar.bytes.all { it == 0.toByte() })
}

private class SharedFfiResultShardApi(
  private val decryptResult: RustDecryptedShardFfiResult,
) : GeneratedRustShardApi {
  override fun encryptShardWithEpochHandle(
    epochKeyHandle: Long,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): RustEncryptedShardFfiResult = error("encrypt not used")

  override fun decryptShardWithEpochHandle(
    epochKeyHandle: Long,
    envelopeBytes: ByteArray,
  ): RustDecryptedShardFfiResult = decryptResult
}

private fun epochBridgeOpenWipesFfiSeed() {
  val seed = ByteArray(48) { 0x55 }
  val expectedSeed = seed.copyOf()
  val api = FakeGeneratedRustEpochApi(
    open = RustEpochHandleFfiResult(
      code = RustEpochStableCode.OK,
      handle = 17,
      epochId = 9,
      wrappedEpochSeed = seed,
      signPublicKey = ByteArray(32),
    ),
  )
  val result = GeneratedRustEpochBridge(api).openEpoch(ByteArray(64), AccountKeyHandle(7), epochId = 9)
  bridgeAssertTrue(result.code == EpochOpenCode.SUCCESS)
  bridgeAssertTrue(result.handle?.value == 17L)
  // FFI buffer was zeroed by bridge finally; downstream EpochOpenResult does not carry the seed.
  bridgeAssertTrue(seed.all { it == 0.toByte() })
  // Seed values were captured before wipe.
  bridgeAssertTrue(expectedSeed.any { it != 0.toByte() })
}

private fun identityBridgeOpenWipesFfi() {
  val signing = ByteArray(32) { 0x66 }
  val encryption = ByteArray(32) { 0x77 }
  val ignored = ByteArray(64) { 0x88.toByte() }
  val api = FakeGeneratedRustIdentityApi(
    open = RustIdentityHandleFfiResult(
      code = RustIdentityStableCode.OK,
      handle = 5,
      signingPubkey = signing,
      encryptionPubkey = encryption,
      wrappedSeed = ignored,
    ),
  )
  val result = GeneratedRustIdentityBridge(api).openIdentity(ByteArray(64), AccountKeyHandle(7))
  bridgeAssertTrue(result.code == IdentityOpenCode.SUCCESS)
  bridgeAssertTrue(signing.all { it == 0.toByte() })
  bridgeAssertTrue(encryption.all { it == 0.toByte() })
  bridgeAssertTrue(ignored.all { it == 0.toByte() })
}

private fun identityBridgeSignManifestWipesFfi() {
  val sig = ByteArray(64) { 0x99.toByte() }
  val expectedSig = sig.copyOf()
  val api = FakeGeneratedRustIdentityApi(
    signature = RustBytesFfiResult(code = RustIdentityStableCode.OK, bytes = sig),
  )
  val result = GeneratedRustIdentityBridge(api).signManifest(IdentityHandle(7), ByteArray(32))
  bridgeAssertTrue(result.code == IdentitySignCode.SUCCESS)
  bridgeAssertTrue(result.signature.contentEquals(expectedSig))
  // FFI signature buffer is now zeroed; downstream ManifestSignatureResult kept its own copy.
  bridgeAssertTrue(sig.all { it == 0.toByte() })
}

private fun identityBridgePubkeyOpsWipeFfi() {
  val signingBytes = ByteArray(32) { 0xAA.toByte() }
  val encryptionBytes = ByteArray(32) { 0xBB.toByte() }
  val signApi = FakeGeneratedRustIdentityApi(
    signingPubkey = RustBytesFfiResult(code = RustIdentityStableCode.OK, bytes = signingBytes),
    encryptionPubkey = RustBytesFfiResult(code = RustIdentityStableCode.OK, bytes = encryptionBytes),
  )
  val bridge = GeneratedRustIdentityBridge(signApi)
  val signResult = bridge.signingPubkey(IdentityHandle(1))
  bridgeAssertTrue(signResult.code == IdentityPubkeyCode.SUCCESS)
  bridgeAssertTrue(signingBytes.all { it == 0.toByte() })
  val encResult = bridge.encryptionPubkey(IdentityHandle(1))
  bridgeAssertTrue(encResult.code == IdentityPubkeyCode.SUCCESS)
  bridgeAssertTrue(encryptionBytes.all { it == 0.toByte() })
}

private fun metadataSidecarEncryptOpsWipeFfi() {
  val envelope1 = ByteArray(96) { 0xCC.toByte() }
  val envelope2 = ByteArray(96) { 0xDD.toByte() }
  val api = FakeGeneratedRustMetadataSidecarApi(
    encrypt = RustEncryptedShardFfiResult(
      code = RustMetadataSidecarStableCode.OK,
      envelopeBytes = envelope1,
      sha256 = "0".repeat(64),
    ),
    encryptMedia = RustEncryptedShardFfiResult(
      code = RustMetadataSidecarStableCode.OK,
      envelopeBytes = envelope2,
      sha256 = "1".repeat(64),
    ),
  )
  val bridge = GeneratedRustMetadataSidecarBridge(api)

  val res1 = bridge.encryptMetadataSidecar(
    EncryptMetadataSidecarRequest(
      epochKeyHandle = EpochKeyHandle(1),
      albumId = ByteArray(16) { 1 },
      photoId = ByteArray(16) { 2 },
      epochId = 0,
      encodedFields = ByteArray(8) { 3 },
      shardIndex = 0,
    ),
  )
  bridgeAssertTrue(res1.code == MetadataSidecarEncryptCode.SUCCESS)
  bridgeAssertTrue(envelope1.all { it == 0.toByte() })

  val res2 = bridge.encryptMediaMetadataSidecar(
    EncryptMediaMetadataSidecarRequest(
      epochKeyHandle = EpochKeyHandle(1),
      albumId = ByteArray(16) { 1 },
      photoId = ByteArray(16) { 2 },
      epochId = 0,
      mediaBytes = ByteArray(64) { 4 },
      shardIndex = 0,
    ),
  )
  bridgeAssertTrue(res2.code == MetadataSidecarEncryptCode.SUCCESS)
  bridgeAssertTrue(envelope2.all { it == 0.toByte() })
}

private fun metadataSidecarCanonicalMediaWipesFfi() {
  val canonical = ByteArray(96) { 0xEE.toByte() }
  val expectedCanonical = canonical.copyOf()
  val api = FakeGeneratedRustMetadataSidecarApi(
    canonicalMedia = RustBytesFfiResult(code = RustMetadataSidecarStableCode.OK, bytes = canonical),
  )
  val req = CanonicalMediaMetadataSidecarRequest(
    albumId = ByteArray(16) { 1 },
    photoId = ByteArray(16) { 2 },
    epochId = 0,
    mediaBytes = ByteArray(64) { 4 },
  )
  val result = GeneratedRustMetadataSidecarBridge(api).canonicalMediaMetadataSidecar(req)
  bridgeAssertTrue(result.code == MetadataSidecarBuildCode.SUCCESS)
  bridgeAssertTrue(result.sidecar?.bytes?.contentEquals(expectedCanonical) == true)
  bridgeAssertTrue(canonical.all { it == 0.toByte() })
}

private fun diagnosticsBridgeWipesFfiGoldenVector() {
  val header = ByteArray(64) { 0x01 }
  val nonce = ByteArray(24) { 0x02 }
  val transcript = ByteArray(96) { 0x03 }
  val message = ByteArray(64) { 0x04 }
  val signingKey = ByteArray(32) { 0x05 }
  val encryptionKey = ByteArray(32) { 0x06 }
  val signature = ByteArray(64) { 0x07 }
  val expectedHeader = header.copyOf()
  val ffi = RustDiagnosticsGoldenVectorFfi(
    code = 0,
    envelopeHeader = header,
    envelopeEpochId = 1,
    envelopeShardIndex = 0,
    envelopeTier = 1,
    envelopeNonce = nonce,
    manifestTranscript = transcript,
    identityMessage = message,
    identitySigningPubkey = signingKey,
    identityEncryptionPubkey = encryptionKey,
    identitySignature = signature,
  )
  val api = FakeGeneratedRustDiagnosticsApi(golden = ffi)
  val snapshot = GeneratedRustDiagnosticsBridge(api).cryptoDomainGoldenVector()
  // Domain-model snapshot has an independent copy.
  bridgeAssertTrue(snapshot.envelopeHeader.contentEquals(expectedHeader))
  // FFI's 7 byte arrays are all zeroed by bridge finally.
  bridgeAssertTrue(header.all { it == 0.toByte() })
  bridgeAssertTrue(nonce.all { it == 0.toByte() })
  bridgeAssertTrue(transcript.all { it == 0.toByte() })
  bridgeAssertTrue(message.all { it == 0.toByte() })
  bridgeAssertTrue(signingKey.all { it == 0.toByte() })
  bridgeAssertTrue(encryptionKey.all { it == 0.toByte() })
  bridgeAssertTrue(signature.all { it == 0.toByte() })
}

private fun diagnosticsFfiGoldenVectorWipeZerosAll() {
  val ffi = RustDiagnosticsGoldenVectorFfi(
    code = 0,
    envelopeHeader = ByteArray(64) { 1 },
    envelopeEpochId = 0,
    envelopeShardIndex = 0,
    envelopeTier = 1,
    envelopeNonce = ByteArray(24) { 2 },
    manifestTranscript = ByteArray(96) { 3 },
    identityMessage = ByteArray(64) { 4 },
    identitySigningPubkey = ByteArray(32) { 5 },
    identityEncryptionPubkey = ByteArray(32) { 6 },
    identitySignature = ByteArray(64) { 7 },
  )
  ffi.wipe()
  bridgeAssertTrue(ffi.envelopeHeader.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.envelopeNonce.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.manifestTranscript.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.identityMessage.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.identitySigningPubkey.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.identityEncryptionPubkey.all { it == 0.toByte() })
  bridgeAssertTrue(ffi.identitySignature.all { it == 0.toByte() })
}

private fun openIdentityWipingWrappedSeedWipesCallerBuffer() {
  val wrappedSeed = ByteArray(64) { 0x12 }
  val api = FakeGeneratedRustIdentityApi(
    open = RustIdentityHandleFfiResult(
      code = RustIdentityStableCode.OK,
      handle = 1,
      signingPubkey = ByteArray(32),
      encryptionPubkey = ByteArray(32),
      wrappedSeed = ByteArray(64),
    ),
  )
  val bridge = GeneratedRustIdentityBridge(api)
  val result = bridge.openIdentityWipingWrappedSeed(wrappedSeed, AccountKeyHandle(7))
  bridgeAssertTrue(result.code == IdentityOpenCode.SUCCESS)
  bridgeAssertTrue(wrappedSeed.all { it == 0.toByte() })
}

private fun openEpochWipingWrappedSeedWipesCallerBuffer() {
  val wrappedSeed = ByteArray(48) { 0x34 }
  val api = FakeGeneratedRustEpochApi(
    open = RustEpochHandleFfiResult(
      code = RustEpochStableCode.OK,
      handle = 9,
      epochId = 3,
      wrappedEpochSeed = ByteArray(48),
      signPublicKey = ByteArray(32),
    ),
  )
  val bridge = GeneratedRustEpochBridge(api)
  val result = bridge.openEpochWipingWrappedSeed(wrappedSeed, AccountKeyHandle(7), epochId = 3)
  bridgeAssertTrue(result.code == EpochOpenCode.SUCCESS)
  bridgeAssertTrue(wrappedSeed.all { it == 0.toByte() })
}

private fun decryptShardWipingEnvelopeWipesCallerBuffer() {
  val envelope = ByteArray(128) { 0x56 }
  val plaintext = ByteArray(64) { 0x78 }
  val expectedPlaintext = plaintext.copyOf()
  val api = FakeGeneratedRustShardApi(
    decrypt = RustDecryptedShardFfiResult(code = RustShardStableCode.OK, plaintext = plaintext),
  )
  val bridge = GeneratedRustShardBridge(api)
  val result = bridge.decryptShardWipingEnvelope(EpochKeyHandle(1), envelope)
  bridgeAssertTrue(result.code == ShardDecryptCode.SUCCESS)
  // Decrypted shard kept its own copy.
  bridgeAssertTrue(result.shard?.plaintext?.contentEquals(expectedPlaintext) == true)
  // Caller's envelope buffer is now zeroed.
  bridgeAssertTrue(envelope.all { it == 0.toByte() })
}

private fun signManifestWipingTranscriptWipesCallerBuffer() {
  val transcript = ByteArray(96) { 0x9A.toByte() }
  val api = FakeGeneratedRustIdentityApi(
    signature = RustBytesFfiResult(code = RustIdentityStableCode.OK, bytes = ByteArray(64) { 0xBC.toByte() }),
  )
  val bridge = GeneratedRustIdentityBridge(api)
  val result = bridge.signManifestWipingTranscript(IdentityHandle(1), transcript)
  bridgeAssertTrue(result.code == IdentitySignCode.SUCCESS)
  bridgeAssertTrue(transcript.all { it == 0.toByte() })
}

// endregion

// region inline assertions (uses distinct names from AndroidShellFoundationTest.kt
// to avoid file-private redeclaration issues when both files are compiled together)

private fun bridgeAssertTrue(value: Boolean) {
  if (!value) throw IllegalStateException("expected true")
}

private fun bridgeAssertFalse(value: Boolean) {
  if (value) throw IllegalStateException("expected false")
}

private fun bridgeExpectThrows(label: String, body: () -> Unit) {
  try {
    body()
  } catch (_: Throwable) {
    return
  }
  throw IllegalStateException("expected $label to throw")
}

// endregion
