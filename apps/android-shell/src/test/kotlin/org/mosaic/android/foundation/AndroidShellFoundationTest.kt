package org.mosaic.android.foundation

import java.nio.file.Files
import java.nio.file.Paths

private data class TestCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    TestCase("server authenticated and crypto unlocked state are distinct", ::serverAndCryptoStateAreDistinct),
    TestCase("crypto handle string output is redacted", ::cryptoHandleStringOutputIsRedacted),
    TestCase("upload queue rejects privacy-forbidden fields", ::uploadQueueRejectsPrivacyForbiddenFields),
    TestCase("crypto unlock before server authentication is rejected", ::cryptoUnlockBeforeServerAuthenticationRejected),
    TestCase("photo picker contract stages immediate reads before queueing", ::photoPickerStagesImmediateReads),
    TestCase("photo picker selection string output redacts raw URI", ::photoPickerSelectionStringOutputRedactsRawUri),
    TestCase("manual upload receipt and queue reject raw URI and zero bytes", ::manualUploadReceiptAndQueueRejectRawUriAndZeroBytes),
    TestCase("manual upload rejects queueing before server auth", ::manualUploadRejectsQueueingBeforeServerAuth),
    TestCase("manual upload rejects queueing before crypto unlock", ::manualUploadRejectsQueueingBeforeCryptoUnlock),
    TestCase("manual upload rejects missing destination album", ::manualUploadRejectsMissingDestinationAlbum),
    TestCase("manual upload queues from staged receipt without retaining raw URI", ::manualUploadQueuesFromStagedReceipt),
    TestCase("manual upload result strings redact staged sources and handles", ::manualUploadResultStringsRedactStagedSourcesAndHandles),
    TestCase("client core handoff DTO carries only opaque upload fields", ::clientCoreHandoffDtoCarriesOnlyOpaqueUploadFields),
    TestCase("generated rust upload bridge maps manual handoff to client core state machine", ::generatedRustUploadBridgeMapsManualHandoffToClientCoreStateMachine),
    TestCase("generated rust upload bridge maps invalid transition and init errors safely", ::generatedRustUploadBridgeMapsInvalidTransitionAndInitErrorsSafely),
    TestCase("generated rust upload bridge strings redact staged source and client secrets", ::generatedRustUploadBridgeStringsRedactStagedSourceAndClientSecrets),
    TestCase("manual upload coordinator optionally prepares client core handoff", ::manualUploadCoordinatorOptionallyPreparesClientCoreHandoff),
    TestCase("cross-client fixture maps to opaque manual upload handoff", ::crossClientFixtureMapsToOpaqueManualUploadHandoff),
    TestCase("fake rust bridge models account unlock lifecycle", ::fakeRustBridgeModelsUnlockLifecycle),
    TestCase("generated rust bridge maps UniFFI account calls", ::generatedRustBridgeMapsUniFfiAccountCalls),
    TestCase("work policy defaults to foreground dataSync", ::workPolicyDefaultsToForegroundDataSync),
    TestCase("media port exposes a stub and fake seam", ::mediaPortExposesStubAndFakeSeam),
    TestCase("generated rust media bridge plans without raw picker data", ::generatedRustMediaBridgePlansWithoutRawPickerData),
    TestCase("generated rust media bridge maps deferred and error statuses safely", ::generatedRustMediaBridgeMapsDeferredAndErrorStatusesSafely),
    TestCase("public Android shell DTO strings avoid privacy-forbidden media text", ::publicAndroidShellDtoStringsAvoidPrivacyForbiddenMediaText),
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
    throw IllegalStateException("$failed Android shell foundation tests failed")
  }

  println("PASS ${tests.size} Android shell foundation tests")
}

private fun serverAndCryptoStateAreDistinct() {
  val initial = ShellSessionState.initial()
  assertFalse(initial.isServerAuthenticated)
  assertFalse(initial.isCryptoUnlocked)
  assertFalse(initial.canQueueUploads)

  val serverOnly = initial.withServerAuthenticated(ServerAccountId("server-account-1"))
  assertTrue(serverOnly.isServerAuthenticated)
  assertFalse(serverOnly.isCryptoUnlocked)
  assertFalse(serverOnly.canQueueUploads)

  val unlocked = serverOnly.withCryptoUnlocked(AccountKeyHandle(42), "mosaic-v1")
  assertTrue(unlocked.isServerAuthenticated)
  assertTrue(unlocked.isCryptoUnlocked)
  assertTrue(unlocked.canQueueUploads)

  val signedOut = unlocked.withServerSignedOut()
  assertFalse(signedOut.isServerAuthenticated)
  assertFalse(signedOut.isCryptoUnlocked)
  assertFalse(signedOut.canQueueUploads)
}

private fun cryptoHandleStringOutputIsRedacted() {
  val unlocked = ShellSessionState.initial()
    .withServerAuthenticated(ServerAccountId("server-account-1"))
    .withCryptoUnlocked(AccountKeyHandle(42), "mosaic-v1")

  assertFalse(AccountKeyHandle(42).toString().contains("42"))
  assertFalse(unlocked.cryptoUnlockState.toString().contains("42"))
  assertFalse(unlocked.toString().contains("42"))
  assertTrue(unlocked.cryptoUnlockState.toString().contains("<redacted>"))
}

private fun cryptoUnlockBeforeServerAuthenticationRejected() {
  val initial = ShellSessionState.initial()
  expectThrows("crypto unlock requires server auth") {
    initial.withCryptoUnlocked(AccountKeyHandle(7), "mosaic-v1")
  }
}

private fun uploadQueueRejectsPrivacyForbiddenFields() {
  val valid = PrivacySafeUploadQueueRecord.create(
    id = QueueRecordId("queue-1"),
    serverAccountId = ServerAccountId("server-account-1"),
    albumId = AlbumId("album-1"),
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-1/source"),
    contentLengthBytes = 128,
    createdAtEpochMillis = 1000,
  )

  assertEquals("queue-1", valid.id.value)
  assertFalse(valid.toString().contains("content://"))
  assertFalse(valid.toString().contains("mosaic-staged://"))

  expectThrows("filename rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(filename = "IMG_0001.jpg"))
  }
  expectThrows("caption rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(caption = "private caption"))
  }
  expectThrows("EXIF rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(exif = mapOf("DateTimeOriginal" to "2026:01:01")))
  }
  expectThrows("GPS rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(gps = "50.087,14.421"))
  }
  expectThrows("device metadata rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(deviceMetadata = mapOf("Make" to "Pixel")))
  }
  expectThrows("raw key rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(rawKeys = listOf(byteArrayOf(1, 2, 3))))
  }
  expectThrows("decrypted metadata rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(decryptedMetadata = mapOf("title" to "secret")))
  }
  expectThrows("raw URI rejected") {
    validQueueRecord(prohibited = ProhibitedQueuePayload(rawUri = "content://media/external/images/1"))
  }
  expectThrows("content URI staging rejected") {
    StagedMediaReference.of("content://media/external/images/1")
  }
  expectThrows("file URI staging rejected") {
    StagedMediaReference.of("file:///sdcard/DCIM/IMG_0001.jpg")
  }
  expectThrows("embedded URI staging rejected") {
    StagedMediaReference.of("mosaic-staged://queue-1/android.resource://private")
  }
}

private fun photoPickerStagesImmediateReads() {
  val reader = FakePhotoPickerImmediateReader(
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-2/source"),
  )
  val selection = PhotoPickerSelection(
    contentUri = EphemeralContentUri("content://picker/session/item"),
    selectedAtEpochMillis = 2000,
  )

  val receipt = reader.readImmediately(selection)
  assertEquals("content://picker/session/item", reader.lastSelection?.contentUri?.value)
  assertEquals("mosaic-staged://queue-2/source", receipt.stagedSource.value)

  val queued = PrivacySafeUploadQueueRecord.create(
    id = QueueRecordId("queue-2"),
    serverAccountId = ServerAccountId("server-account-1"),
    albumId = AlbumId("album-1"),
    stagedSource = receipt.stagedSource,
    contentLengthBytes = receipt.contentLengthBytes,
    createdAtEpochMillis = receipt.stagedAtEpochMillis,
  )

  assertFalse(queued.toString().contains(selection.contentUri.value))
  assertFalse(queued.toString().contains(receipt.stagedSource.value))
}

private fun photoPickerSelectionStringOutputRedactsRawUri() {
  val selection = PhotoPickerSelection(
    contentUri = EphemeralContentUri("content://picker/session/raw-item"),
    selectedAtEpochMillis = 2100,
  )

  assertEquals("content://picker/session/raw-item", selection.contentUri.value)
  assertFalse(selection.toString().contains(selection.contentUri.value))
  assertFalse(selection.toString().contains("content://"))
  assertTrue(selection.toString().contains("<redacted>"))
}

private fun manualUploadReceiptAndQueueRejectRawUriAndZeroBytes() {
  expectThrows("content URI receipt staging rejected") {
    PhotoPickerReadReceipt(
      stagedSource = StagedMediaReference.of("content://picker/session/item"),
      contentLengthBytes = 2048,
      stagedAtEpochMillis = 2200,
    )
  }
  expectThrows("file URI receipt staging rejected") {
    PhotoPickerReadReceipt(
      stagedSource = StagedMediaReference.of("file:///sdcard/DCIM/raw.jpg"),
      contentLengthBytes = 2048,
      stagedAtEpochMillis = 2200,
    )
  }
  expectThrows("manual upload receipt zero length rejected") {
    PhotoPickerReadReceipt(
      stagedSource = StagedMediaReference.of("mosaic-staged://queue-2/zero"),
      contentLengthBytes = 0,
      stagedAtEpochMillis = 2200,
    )
  }
  expectThrows("queued manual upload zero length rejected") {
    PrivacySafeUploadQueueRecord.create(
      id = QueueRecordId("queue-zero"),
      serverAccountId = ServerAccountId("server-account-1"),
      albumId = AlbumId("album-1"),
      stagedSource = StagedMediaReference.of("mosaic-staged://queue-zero/source"),
      contentLengthBytes = 0,
      createdAtEpochMillis = 2200,
    )
  }

  val genericCandidate = MediaImportCandidate(
    stagedSource = StagedMediaReference.of("mosaic-staged://generic/empty"),
    contentLengthBytes = 0,
  )
  assertEquals(0, genericCandidate.contentLengthBytes)
}

private fun manualUploadRejectsQueueingBeforeServerAuth() {
  val coordinator = manualUploadCoordinator()

  val result = coordinator.queueOnePhoto(
    sessionState = ShellSessionState.initial(),
    destinationAlbumId = AlbumId("album-1"),
    receipt = stagedUploadReceipt(),
  )

  assertEquals(ManualUploadStatus.NEEDS_AUTH, result.status)
  assertEquals(null, result.queueRecord)
  assertEquals(null, result.clientCoreHandoffRequest)
}

private fun manualUploadRejectsQueueingBeforeCryptoUnlock() {
  val coordinator = manualUploadCoordinator()
  val serverOnly = ShellSessionState.initial()
    .withServerAuthenticated(ServerAccountId("server-account-1"))

  val result = coordinator.queueOnePhoto(
    sessionState = serverOnly,
    destinationAlbumId = AlbumId("album-1"),
    receipt = stagedUploadReceipt(),
  )

  assertEquals(ManualUploadStatus.NEEDS_CRYPTO_UNLOCK, result.status)
  assertEquals(null, result.queueRecord)
  assertEquals(null, result.clientCoreHandoffRequest)
}

private fun manualUploadRejectsMissingDestinationAlbum() {
  val coordinator = manualUploadCoordinator()

  val ready = coordinator.readiness(
    sessionState = authenticatedUnlockedSession(),
    destinationAlbumId = AlbumId("album-1"),
  )
  assertEquals(ManualUploadStatus.READY_TO_QUEUE, ready)

  val result = coordinator.queueOnePhoto(
    sessionState = authenticatedUnlockedSession(),
    destinationAlbumId = null,
    receipt = stagedUploadReceipt(),
  )

  assertEquals(ManualUploadStatus.NEEDS_ALBUM, result.status)
  assertEquals(null, result.queueRecord)
  assertEquals(null, result.clientCoreHandoffRequest)
}

private fun manualUploadQueuesFromStagedReceipt() {
  val store = FakeManualUploadQueueStore()
  val coordinator = manualUploadCoordinator(store)
  val reader = FakePhotoPickerImmediateReader(
    stagedSource = StagedMediaReference.of("mosaic-staged://manual-upload/source-1"),
  )
  val selection = PhotoPickerSelection(
    contentUri = EphemeralContentUri("content://picker/session/manual-upload-1"),
    selectedAtEpochMillis = 7000,
  )
  val receipt = reader.readImmediately(selection)

  val result = coordinator.queueOnePhoto(
    sessionState = authenticatedUnlockedSession(),
    destinationAlbumId = AlbumId("album-1"),
    receipt = receipt,
  )

  assertEquals(ManualUploadStatus.QUEUED, result.status)
  val record = requireNotNull(result.queueRecord) { "queued result must include queue record" }
  assertEquals(QueueRecordId("queue-manual-1"), record.id)
  assertEquals(AlbumId("album-1"), record.albumId)
  assertEquals(receipt.stagedSource, record.stagedSource)
  assertEquals(receipt.contentLengthBytes, record.contentLengthBytes)
  assertEquals(receipt.stagedAtEpochMillis, record.createdAtEpochMillis)
  assertEquals(record, store.lastRecord)

  val handoffRequest = requireNotNull(result.clientCoreHandoffRequest) {
    "queued result must include a future client-core handoff request"
  }
  assertEquals(record.id, handoffRequest.queueRecordId)
  assertEquals(record.albumId, handoffRequest.albumId)
  assertEquals(record.stagedSource, handoffRequest.stagedSource)
  assertEquals(record.contentLengthBytes, handoffRequest.byteCount)

  assertFalse(record.toString().contains(selection.contentUri.value))
  assertFalse(result.toString().contains(selection.contentUri.value))
  assertFalse(handoffRequest.toString().contains(selection.contentUri.value))
}

private fun manualUploadResultStringsRedactStagedSourcesAndHandles() {
  val coordinator = manualUploadCoordinator()
  val session = ShellSessionState.initial()
    .withServerAuthenticated(ServerAccountId("server-account-1"))
    .withCryptoUnlocked(AccountKeyHandle(4242), "mosaic-v1")

  val result = coordinator.queueOnePhoto(
    sessionState = session,
    destinationAlbumId = AlbumId("album-1"),
    receipt = stagedUploadReceipt(),
  )

  assertEquals(ManualUploadStatus.QUEUED, result.status)
  val resultText = result.toString()
  val handoffText = requireNotNull(result.clientCoreHandoffRequest).toString()

  assertFalse(resultText.contains("mosaic-staged://"))
  assertFalse(resultText.contains("content://"))
  assertFalse(resultText.contains("4242"))
  assertTrue(resultText.contains("<redacted>"))
  assertFalse(handoffText.contains("mosaic-staged://"))
  assertFalse(handoffText.contains("content://"))
  assertFalse(handoffText.contains("4242"))
  assertTrue(handoffText.contains("<redacted>"))
}

private fun clientCoreHandoffDtoCarriesOnlyOpaqueUploadFields() {
  val record = validQueueRecord()
  val request = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
    record = record,
    uploadJobId = ManualUploadJobId("upload-job-1"),
    assetId = ManualUploadAssetId("asset-1"),
  )
  val handoff = FakeManualUploadClientCoreHandoff()

  val result = handoff.prepareManualUpload(request)

  assertEquals(ManualUploadClientCoreHandoffStatus.ACCEPTED, result.status)
  assertEquals(ManualUploadJobId("upload-job-1"), result.uploadJobId)
  assertEquals(record.contentLengthBytes, result.acceptedByteCount)
  assertEquals(request, handoff.lastRequest)

  val text = request.toString()
  val forbiddenTerms = listOf(
    "content://",
    "mosaic-staged://",
    "filename",
    "IMG_0001.jpg",
    "EXIF",
    "GPS",
    "camera",
    "device",
    "private",
    "secret",
  )
  forbiddenTerms.forEach { forbidden ->
    assertFalse(text.contains(forbidden, ignoreCase = true))
  }

  expectThrows("handoff DTO rejects forbidden plaintext fields") {
    ManualUploadClientCoreHandoffRequest.fromQueueRecord(
      record = record,
      prohibited = ProhibitedQueuePayload(
        filename = "IMG_0001.jpg",
        exif = mapOf("Model" to "camera"),
        gps = "50.087,14.421",
        deviceMetadata = mapOf("Make" to "device"),
        rawUri = "content://media/external/images/1",
      ),
    )
  }
}

private fun generatedRustUploadBridgeMapsManualHandoffToClientCoreStateMachine() {
  val api = FakeGeneratedRustUploadApi()
  val bridge = GeneratedRustUploadBridge(
    api = api,
    nowUnixMs = { 1_700_000_000_000 },
    maxRetryCount = 3,
  )
  val record = validQueueRecord()
  val request = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
    record = record,
    uploadJobId = ManualUploadJobId("upload-job-1"),
    assetId = ManualUploadAssetId("asset-1"),
  )

  val result = bridge.prepareManualUpload(request)

  assertEquals(ManualUploadClientCoreHandoffStatus.ACCEPTED, result.status)
  assertEquals(ManualUploadJobId("upload-job-1"), result.uploadJobId)
  assertEquals(record.contentLengthBytes, result.acceptedByteCount)
  assertEquals(RustClientCoreUploadStableCode.OK, result.stableCode)
  assertEquals("AwaitingPreparedMedia", result.clientCorePhase)
  assertEquals(listOf("PrepareMedia"), result.clientCoreEffects)

  val initRequest = requireNotNull(api.lastInitRequest) { "bridge must initialize upload state machine" }
  assertEquals("upload-job-1", initRequest.jobId)
  assertEquals("album-1", initRequest.albumId)
  assertEquals("asset-1", initRequest.assetId)
  assertEquals(0, initRequest.epochId)
  assertEquals(1_700_000_000_000, initRequest.nowUnixMs)
  assertEquals(3, initRequest.maxRetryCount)
  assertEquals("StartRequested", api.lastAdvanceEvent?.kind)
}

private fun generatedRustUploadBridgeMapsInvalidTransitionAndInitErrorsSafely() {
  val invalidTransitionApi = FakeGeneratedRustUploadApi(
    advanceCode = RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_TRANSITION,
  )
  val invalidTransition = GeneratedRustUploadBridge(invalidTransitionApi)
    .prepareManualUpload(clientCoreUploadRequestWithSecrets())

  assertEquals(ManualUploadClientCoreHandoffStatus.REJECTED, invalidTransition.status)
  assertEquals(RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_TRANSITION, invalidTransition.stableCode)
  assertEquals(null, invalidTransition.uploadJobId)
  assertEquals(null, invalidTransition.acceptedByteCount)

  val invalidSnapshotApi = FakeGeneratedRustUploadApi(
    initCode = RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_SNAPSHOT,
  )
  val invalidSnapshot = GeneratedRustUploadBridge(invalidSnapshotApi)
    .prepareManualUpload(clientCoreUploadRequestWithSecrets())

  assertEquals(ManualUploadClientCoreHandoffStatus.REJECTED, invalidSnapshot.status)
  assertEquals(RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_SNAPSHOT, invalidSnapshot.stableCode)
  assertEquals(null, invalidSnapshot.uploadJobId)
  assertEquals(null, invalidSnapshot.acceptedByteCount)
}

private fun generatedRustUploadBridgeStringsRedactStagedSourceAndClientSecrets() {
  val request = clientCoreUploadRequestWithSecrets()
  val ffiRequest = RustClientCoreUploadJobFfiRequest.from(
    request = request,
    nowUnixMs = 1_700_000_000_000,
    maxRetryCount = 2,
  )
  val snapshot = RustClientCoreUploadJobFfiSnapshot.initialFrom(ffiRequest)
  val snapshotWithRefs = snapshot.copy(
    completedShards = listOf(
      RustClientCoreUploadShardRef(
        tier = 1,
        shardIndex = 2,
        shardId = "raw-client-secret-shard",
        sha256 = "raw-client-secret-sha256",
        uploaded = true,
      ),
    ),
    hasManifestReceipt = true,
    manifestReceipt = RustClientCoreManifestReceipt(
      manifestId = "raw-client-secret-manifest",
      manifestVersion = 1,
    ),
  )
  val event = RustClientCoreUploadJobFfiEvent.startRequested()
  val result = GeneratedRustUploadBridge(FakeGeneratedRustUploadApi())
    .prepareManualUpload(request)

  val rendered = listOf(
    ffiRequest.toString(),
    snapshot.toString(),
    snapshotWithRefs.toString(),
    event.toString(),
    RustClientCoreUploadJobFfiEffect.prepareMedia().toString(),
    result.toString(),
  )
  val forbidden = listOf(
    "mosaic-staged://",
    "content://",
    "client-secret",
    "raw-client-secret",
    "raw picker",
    "filename",
    "EXIF",
    "GPS",
  )

  for (text in rendered) {
    for (term in forbidden) {
      assertFalse(text.contains(term, ignoreCase = true))
    }
  }
}

private fun manualUploadCoordinatorOptionallyPreparesClientCoreHandoff() {
  val handoff = FakeManualUploadClientCoreHandoff()
  val coordinator = manualUploadCoordinator(
    store = FakeManualUploadQueueStore(),
    handoff = handoff,
  )

  val result = coordinator.queueOnePhoto(
    sessionState = authenticatedUnlockedSession(),
    destinationAlbumId = AlbumId("album-1"),
    receipt = stagedUploadReceipt(),
  )

  assertEquals(ManualUploadStatus.QUEUED, result.status)
  val request = requireNotNull(result.clientCoreHandoffRequest) { "queued result must include handoff request" }
  assertEquals(request, handoff.lastRequest)
  val handoffResult = requireNotNull(result.clientCoreHandoffResult) {
    "coordinator must retain optional client-core handoff result"
  }
  assertEquals(ManualUploadClientCoreHandoffStatus.ACCEPTED, handoffResult.status)
  assertEquals(request.byteCount, handoffResult.acceptedByteCount)
}

private fun crossClientFixtureMapsToOpaqueManualUploadHandoff() {
  val fixture = crossClientContractFixture()
  val record = PrivacySafeUploadQueueRecord.create(
    id = QueueRecordId(fixtureString(fixture, "queueRecordId")),
    serverAccountId = ServerAccountId("server-account-band3-contract"),
    albumId = AlbumId(fixtureString(fixture, "albumId")),
    stagedSource = StagedMediaReference.of(fixtureString(fixture, "stagedSource")),
    contentLengthBytes = fixtureLong(fixture, "byteCount"),
    createdAtEpochMillis = 1_700_000_000_000,
  )
  val request = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
    record = record,
    uploadJobId = ManualUploadJobId(fixtureString(fixture, "uploadJobId")),
    assetId = ManualUploadAssetId(fixtureString(fixture, "assetId")),
  )
  val handoff = FakeManualUploadClientCoreHandoff()

  val accepted = handoff.prepareManualUpload(request)

  assertEquals(ManualUploadClientCoreHandoffStatus.ACCEPTED, accepted.status)
  assertEquals(request.uploadJobId, accepted.uploadJobId)
  assertEquals(record.contentLengthBytes, accepted.acceptedByteCount)
  assertEquals(record.albumId, request.albumId)
  assertEquals(record.id, request.queueRecordId)
  assertEquals(record.stagedSource, request.stagedSource)
  assertEquals(ManualUploadHandoffStage.STAGED_SOURCE_READY, request.stage)
  assertTrue(fixture.contains("\"backendManifestRequest\""))
  assertTrue(fixture.contains("\"webSyncManifest\""))
  assertTrue(fixture.contains("\"tieredShards\""))

  val rendered = listOf(record.toString(), request.toString(), accepted.toString()).joinToString("\n")
  fixtureForbiddenTerms(fixture).forEach { forbidden ->
    assertFalse(rendered.contains(forbidden, ignoreCase = true))
  }
}

private fun fakeRustBridgeModelsUnlockLifecycle() {
  val bridge = FakeRustAccountBridge()
  assertEquals("mosaic-v1", bridge.protocolVersion())

  val wrongPassword = "wrong".encodeToByteArray()
  val failed = bridge.unlockAccountAndWipePassword(wrongPassword, unlockRequest())
  assertEquals(AccountUnlockCode.AUTHENTICATION_FAILED, failed.code)
  assertEquals(null, failed.handle)
  assertTrue(wrongPassword.all { it == 0.toByte() })

  val password = "correct horse battery staple".encodeToByteArray()
  val unlocked = bridge.unlockAccountAndWipePassword(password, unlockRequest())
  assertEquals(AccountUnlockCode.SUCCESS, unlocked.code)
  assertTrue(password.all { it == 0.toByte() })
  val handle = requireNotNull(unlocked.handle) { "success must include handle" }
  assertTrue(bridge.isAccountKeyHandleOpen(handle))

  assertEquals(AccountCloseCode.SUCCESS, bridge.closeAccountKeyHandle(handle))
  assertFalse(bridge.isAccountKeyHandleOpen(handle))
  assertEquals(AccountCloseCode.NOT_FOUND, bridge.closeAccountKeyHandle(handle))
}

private fun generatedRustBridgeMapsUniFfiAccountCalls() {
  val api = FakeGeneratedRustAccountApi()
  val bridge = GeneratedRustAccountBridge(api)
  assertEquals("mosaic-v1", bridge.protocolVersion())

  val invalidSaltPassword = "correct horse battery staple".encodeToByteArray()
  val invalidSalt = bridge.unlockAccountAndWipePassword(
    invalidSaltPassword,
    AccountUnlockRequest(
      userSalt = ByteArray(15) { 1 },
      accountSalt = ByteArray(16) { 2 },
      wrappedAccountKey = ByteArray(64) { 3 },
      kdfProfile = KdfProfile(memoryKiB = 65536, iterations = 3, parallelism = 1),
    ),
  )
  assertEquals(AccountUnlockCode.INVALID_SALT_LENGTH, invalidSalt.code)
  assertEquals(null, invalidSalt.handle)
  assertTrue(invalidSaltPassword.all { it == 0.toByte() })
  assertEquals(15, api.lastUnlockRequest?.userSalt?.size)
  assertFalse(api.lastUnlockRequest.toString().contains("[B@"))

  val weakKdfPassword = "correct horse battery staple".encodeToByteArray()
  val weakKdf = bridge.unlockAccountAndWipePassword(
    weakKdfPassword,
    AccountUnlockRequest(
      userSalt = ByteArray(16) { 1 },
      accountSalt = ByteArray(16) { 2 },
      wrappedAccountKey = ByteArray(64) { 3 },
      kdfProfile = KdfProfile(memoryKiB = 32768, iterations = 3, parallelism = 1),
    ),
  )
  assertEquals(AccountUnlockCode.KDF_PROFILE_TOO_WEAK, weakKdf.code)
  assertEquals(null, weakKdf.handle)
  assertTrue(weakKdfPassword.all { it == 0.toByte() })

  val password = "correct horse battery staple".encodeToByteArray()
  val unlocked = bridge.unlockAccountAndWipePassword(password, unlockRequest())
  assertEquals(AccountUnlockCode.SUCCESS, unlocked.code)
  assertTrue(password.all { it == 0.toByte() })
  val handle = requireNotNull(unlocked.handle) { "success must include handle" }
  assertEquals(1L, handle.value)
  assertEquals(65536, api.lastUnlockRequest?.kdfMemoryKiB)
  assertEquals(3, api.lastUnlockRequest?.kdfIterations)
  assertEquals(1, api.lastUnlockRequest?.kdfParallelism)

  assertTrue(bridge.isAccountKeyHandleOpen(handle))
  assertEquals(AccountCloseCode.SUCCESS, bridge.closeAccountKeyHandle(handle))
  assertFalse(bridge.isAccountKeyHandleOpen(handle))
  assertEquals(AccountCloseCode.NOT_FOUND, bridge.closeAccountKeyHandle(handle))
}

private fun workPolicyDefaultsToForegroundDataSync() {
  val policy = AndroidWorkPolicies.uploadDrainPolicy

  assertEquals(WorkKind.UPLOAD_QUEUE_DRAIN, policy.kind)
  assertTrue(policy.requiresForegroundService)
  assertEquals(ForegroundServiceType.DATA_SYNC, policy.foregroundServiceType)
  assertTrue(policy.requiresUserVisibleNotification)
  assertFalse(policy.requestsBroadStorageAccess)
  assertEquals(emptyList<String>(), policy.staticPolicyViolations())

  val invalid = policy.copy(
    requiresForegroundService = false,
    foregroundServiceType = ForegroundServiceType.NONE,
    requiresUserVisibleNotification = false,
    requestsBroadStorageAccess = true,
  )
  assertEquals(
    listOf(
      "upload queue drain must run as foreground work",
      "upload queue drain must declare foregroundServiceType=dataSync",
      "upload queue drain must show a user-visible notification",
      "upload queue drain must not request broad storage access",
    ),
    invalid.staticPolicyViolations(),
  )
}

private fun mediaPortExposesStubAndFakeSeam() {
  val candidate = MediaImportCandidate(
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-3/source"),
    contentLengthBytes = 4096,
  )

  val deferred = StubMediaPort.planTiers(candidate)
  assertEquals(MediaPlanStatus.DEFERRED, deferred.status)
  assertEquals(null, deferred.planId)

  val fake = FakeMediaPort(MediaTierPlanId("fake-plan-1"))
  val planned = fake.planTiers(candidate)
  assertEquals(MediaPlanStatus.PLANNED, planned.status)
  assertEquals(MediaTierPlanId("fake-plan-1"), planned.planId)
  assertEquals(candidate, fake.lastCandidate)
}

private fun generatedRustMediaBridgePlansWithoutRawPickerData() {
  val api = FakeGeneratedRustMediaApi(
    results = ArrayDeque(
      listOf(
        RustMediaPlanFfiResult(
          code = RustMediaPlanStableCode.OK,
          planId = "opaque-plan-1",
        ),
      ),
    ),
  )
  val bridge = GeneratedRustMediaBridge(api)
  val rawUri = "content://picker/session/should-not-leak"
  val candidate = MediaImportCandidate(
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-3/source"),
    contentLengthBytes = 4096,
  )

  val planned = bridge.planTiers(candidate)

  assertEquals(MediaPlanStatus.PLANNED, planned.status)
  assertEquals(MediaTierPlanId("opaque-plan-1"), planned.planId)
  assertEquals(candidate.stagedSource, api.lastRequest?.stagedSource)
  assertEquals(4096, api.lastRequest?.contentLengthBytes)
  assertFalse(api.lastRequest.toString().contains(candidate.stagedSource.value))
  assertFalse(api.lastRequest.toString().contains(rawUri))
  assertFalse(planned.toString().contains(candidate.stagedSource.value))
  assertFalse(planned.toString().contains(rawUri))
  assertFalse(planned.toString().contains("opaque-plan-1"))
}

private fun generatedRustMediaBridgeMapsDeferredAndErrorStatusesSafely() {
  val api = FakeGeneratedRustMediaApi(
    results = ArrayDeque(
      listOf(
        RustMediaPlanFfiResult(code = RustMediaPlanStableCode.UNSUPPORTED, planId = "must-ignore-1"),
        RustMediaPlanFfiResult(code = RustMediaPlanStableCode.DEFERRED, planId = "must-ignore-2"),
        RustMediaPlanFfiResult(code = RustMediaPlanStableCode.INTERNAL_ERROR, planId = "must-ignore-3"),
        RustMediaPlanFfiResult(code = 99999, planId = "must-ignore-4"),
        RustMediaPlanFfiResult(code = RustMediaPlanStableCode.OK, planId = ""),
      ),
    ),
  )
  val bridge = GeneratedRustMediaBridge(api)
  val candidate = MediaImportCandidate(
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-4/source"),
    contentLengthBytes = 4096,
  )

  repeat(5) {
    val deferred = bridge.planTiers(candidate)
    assertEquals(MediaPlanStatus.DEFERRED, deferred.status)
    assertEquals(null, deferred.planId)
  }
}

private fun publicAndroidShellDtoStringsAvoidPrivacyForbiddenMediaText() {
  val staged = StagedMediaReference.of("mosaic-staged://safe-token/source")
  val safeDtos = listOf(
    EphemeralContentUri("content://picker/session/redacted").toString(),
    PhotoPickerSelection(
      contentUri = EphemeralContentUri("content://picker/session/redacted"),
      selectedAtEpochMillis = 2300,
    ).toString(),
    PhotoPickerReadReceipt(
      stagedSource = staged,
      contentLengthBytes = 2048,
      stagedAtEpochMillis = 2301,
    ).toString(),
    staged.toString(),
    MediaImportCandidate(staged, contentLengthBytes = 2048).toString(),
    MediaPlanResult(MediaPlanStatus.PLANNED, MediaTierPlanId("opaque-plan-safe")).toString(),
    MediaPlanResult(MediaPlanStatus.DEFERRED, null).toString(),
    RustMediaPlanFfiRequest.from(MediaImportCandidate(staged, contentLengthBytes = 2048)).toString(),
    RustMediaPlanFfiResult(RustMediaPlanStableCode.OK, "opaque-plan-safe").toString(),
    validQueueRecordForPublicStringScan(staged).toString(),
  )
  val forbidden = listOf("content://", "file://", "filename", "EXIF", "GPS", "camera", "device", "private", "secret")

  for (dto in safeDtos) {
    val dtoLower = dto.lowercase()
    for (term in forbidden) {
      assertFalse(dtoLower.contains(term.lowercase()))
    }
  }
}

private fun validQueueRecord(prohibited: ProhibitedQueuePayload = ProhibitedQueuePayload.None): PrivacySafeUploadQueueRecord =
  PrivacySafeUploadQueueRecord.create(
    id = QueueRecordId("queue-private-test"),
    serverAccountId = ServerAccountId("server-account-1"),
    albumId = AlbumId("album-1"),
    stagedSource = StagedMediaReference.of("mosaic-staged://queue-private-test/source"),
    contentLengthBytes = 512,
    createdAtEpochMillis = 3000,
    prohibited = prohibited,
  )

private fun validQueueRecordForPublicStringScan(staged: StagedMediaReference): PrivacySafeUploadQueueRecord =
  PrivacySafeUploadQueueRecord.create(
    id = QueueRecordId("queue-safe-scan"),
    serverAccountId = ServerAccountId("server-account-scan"),
    albumId = AlbumId("album-scan"),
    stagedSource = staged,
    contentLengthBytes = 2048,
    createdAtEpochMillis = 3001,
  )

private fun clientCoreUploadRequestWithSecrets(): ManualUploadClientCoreHandoffRequest =
  ManualUploadClientCoreHandoffRequest.fromQueueRecord(
    record = PrivacySafeUploadQueueRecord.create(
      id = QueueRecordId("raw-client-secret-queue"),
      serverAccountId = ServerAccountId("server-account-1"),
      albumId = AlbumId("album-1"),
      stagedSource = StagedMediaReference.of("mosaic-staged://raw-client-secret/source"),
      contentLengthBytes = 512,
      createdAtEpochMillis = 3002,
    ),
    uploadJobId = ManualUploadJobId("raw-client-secret-upload-job"),
    assetId = ManualUploadAssetId("raw-client-secret-asset"),
  )

private fun authenticatedUnlockedSession(): ShellSessionState = ShellSessionState.initial()
  .withServerAuthenticated(ServerAccountId("server-account-1"))
  .withCryptoUnlocked(AccountKeyHandle(42), "mosaic-v1")

private fun stagedUploadReceipt(): PhotoPickerReadReceipt = PhotoPickerReadReceipt(
  stagedSource = StagedMediaReference.of("mosaic-staged://manual-upload/source-1"),
  contentLengthBytes = 2048,
  stagedAtEpochMillis = 7001,
)

private fun crossClientContractFixture(): String {
  val start = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
  val fixture = generateSequence(start) { it.parent }
    .map { it.resolve("tests").resolve("contracts").resolve("android-manual-upload-cross-client.json") }
    .firstOrNull { Files.exists(it) }
    ?: throw IllegalStateException("Unable to locate android manual upload cross-client contract fixture")
  return Files.readString(fixture)
}

private fun fixtureString(fixture: String, property: String): String =
  Regex("\"${Regex.escape(property)}\"\\s*:\\s*\"([^\"]+)\"")
    .find(fixture)
    ?.groupValues
    ?.get(1)
    ?: throw AssertionError("Missing string fixture property $property")

private fun fixtureLong(fixture: String, property: String): Long =
  Regex("\"${Regex.escape(property)}\"\\s*:\\s*(\\d+)")
    .find(fixture)
    ?.groupValues
    ?.get(1)
    ?.toLong()
    ?: throw AssertionError("Missing numeric fixture property $property")

private fun fixtureForbiddenTerms(fixture: String): List<String> {
  val terms = Regex(
    "\"forbiddenPlaintextTerms\"\\s*:\\s*\\[(.*?)]",
    setOf(RegexOption.DOT_MATCHES_ALL),
  ).find(fixture)
    ?.groupValues
    ?.get(1)
    ?: throw AssertionError("Missing forbidden plaintext terms in fixture")

  return Regex("\"([^\"]+)\"").findAll(terms).map { it.groupValues[1] }.toList()
}

private fun manualUploadCoordinator(
  store: ManualUploadQueueStore = FakeManualUploadQueueStore(),
  handoff: ManualUploadClientCoreHandoff? = null,
): AndroidManualUploadCoordinator = AndroidManualUploadCoordinator(
  idFactory = ManualUploadQueueRecordIdFactory { _, _ -> QueueRecordId("queue-manual-1") },
  queueStore = store,
  clientCoreHandoff = handoff,
)

private fun unlockRequest(): AccountUnlockRequest = AccountUnlockRequest(
  userSalt = ByteArray(16) { 1 },
  accountSalt = ByteArray(16) { 2 },
  wrappedAccountKey = ByteArray(64) { 3 },
  kdfProfile = KdfProfile(memoryKiB = 65536, iterations = 3, parallelism = 1),
)

private class FakeRustAccountBridge : RustAccountBridge {
  private var nextHandle = 1L
  private val openHandles = mutableSetOf<AccountKeyHandle>()
  private val correctPassword = "correct horse battery staple".encodeToByteArray()

  override fun protocolVersion(): String = "mosaic-v1"

  override fun unlockAccount(password: ByteArray, request: AccountUnlockRequest): AccountUnlockResult {
    if (!request.hasValidSaltLengths()) {
      return AccountUnlockResult(AccountUnlockCode.INVALID_SALT_LENGTH, null)
    }

    return if (password.contentEquals(correctPassword)) {
      val handle = AccountKeyHandle(nextHandle++)
      openHandles += handle
      AccountUnlockResult(AccountUnlockCode.SUCCESS, handle)
    } else {
      AccountUnlockResult(AccountUnlockCode.AUTHENTICATION_FAILED, null)
    }
  }

  override fun isAccountKeyHandleOpen(handle: AccountKeyHandle): Boolean = handle in openHandles

  override fun closeAccountKeyHandle(handle: AccountKeyHandle): AccountCloseCode =
    if (openHandles.remove(handle)) AccountCloseCode.SUCCESS else AccountCloseCode.NOT_FOUND
}

private class FakeGeneratedRustAccountApi : GeneratedRustAccountApi {
  private var nextHandle = 1L
  private val openHandles = mutableSetOf<Long>()
  private val correctPassword = "correct horse battery staple".encodeToByteArray()

  var lastUnlockRequest: RustAccountUnlockFfiRequest? = null
    private set

  override fun protocolVersion(): String = "mosaic-v1"

  override fun unlockAccountKey(
    password: ByteArray,
    request: RustAccountUnlockFfiRequest,
  ): RustAccountUnlockFfiResult {
    lastUnlockRequest = request
    if (request.userSalt.size != AccountUnlockRequest.SALT_LENGTH ||
      request.accountSalt.size != AccountUnlockRequest.SALT_LENGTH
    ) {
      return RustAccountUnlockFfiResult(RustClientStableCode.INVALID_SALT_LENGTH, 0)
    }
    if (request.kdfMemoryKiB < 65536) {
      return RustAccountUnlockFfiResult(RustClientStableCode.KDF_PROFILE_TOO_WEAK, 0)
    }
    if (!password.contentEquals(correctPassword)) {
      return RustAccountUnlockFfiResult(RustClientStableCode.AUTHENTICATION_FAILED, 0)
    }

    val handle = nextHandle++
    openHandles += handle
    return RustAccountUnlockFfiResult(RustClientStableCode.OK, handle)
  }

  override fun accountKeyHandleIsOpen(handle: Long): RustAccountKeyHandleStatusFfiResult =
    RustAccountKeyHandleStatusFfiResult(RustClientStableCode.OK, handle in openHandles)

  override fun closeAccountKeyHandle(handle: Long): Int =
    if (openHandles.remove(handle)) RustClientStableCode.OK else RustClientStableCode.SECRET_HANDLE_NOT_FOUND
}

private class FakeGeneratedRustMediaApi(
  private val results: ArrayDeque<RustMediaPlanFfiResult>,
) : GeneratedRustMediaApi {
  var lastRequest: RustMediaPlanFfiRequest? = null
    private set

  override fun planMediaTiers(request: RustMediaPlanFfiRequest): RustMediaPlanFfiResult {
    lastRequest = request
    return results.removeFirst()
  }
}

private class FakeGeneratedRustUploadApi(
  private val initCode: Int = RustClientCoreUploadStableCode.OK,
  private val advanceCode: Int = RustClientCoreUploadStableCode.OK,
) : GeneratedRustUploadApi {
  var lastInitRequest: RustClientCoreUploadJobFfiRequest? = null
    private set
  var lastAdvanceSnapshot: RustClientCoreUploadJobFfiSnapshot? = null
    private set
  var lastAdvanceEvent: RustClientCoreUploadJobFfiEvent? = null
    private set

  override fun initUploadJob(request: RustClientCoreUploadJobFfiRequest): RustClientCoreUploadJobFfiResult {
    lastInitRequest = request
    return RustClientCoreUploadJobFfiResult(
      code = initCode,
      snapshot = RustClientCoreUploadJobFfiSnapshot.initialFrom(request),
    )
  }

  override fun advanceUploadJob(
    snapshot: RustClientCoreUploadJobFfiSnapshot,
    event: RustClientCoreUploadJobFfiEvent,
  ): RustClientCoreUploadJobTransitionFfiResult {
    lastAdvanceSnapshot = snapshot
    lastAdvanceEvent = event
    return RustClientCoreUploadJobTransitionFfiResult(
      code = advanceCode,
      transition = RustClientCoreUploadJobFfiTransition.awaitingPreparedMedia(snapshot),
    )
  }
}

private class FakePhotoPickerImmediateReader(
  private val stagedSource: StagedMediaReference,
) : PhotoPickerImmediateReadPort {
  var lastSelection: PhotoPickerSelection? = null
    private set

  override fun readImmediately(selection: PhotoPickerSelection): PhotoPickerReadReceipt {
    lastSelection = selection
    return PhotoPickerReadReceipt(
      stagedSource = stagedSource,
      contentLengthBytes = 2048,
      stagedAtEpochMillis = selection.selectedAtEpochMillis + 1,
    )
  }
}

private class FakeManualUploadQueueStore : ManualUploadQueueStore {
  var lastRecord: PrivacySafeUploadQueueRecord? = null
    private set

  override fun createOrReturn(record: PrivacySafeUploadQueueRecord): PrivacySafeUploadQueueRecord {
    lastRecord = record
    return record
  }
}

private class FakeManualUploadClientCoreHandoff : ManualUploadClientCoreHandoff {
  var lastRequest: ManualUploadClientCoreHandoffRequest? = null
    private set

  override fun prepareManualUpload(
    request: ManualUploadClientCoreHandoffRequest,
  ): ManualUploadClientCoreHandoffResult {
    lastRequest = request
    return ManualUploadClientCoreHandoffResult(
      status = ManualUploadClientCoreHandoffStatus.ACCEPTED,
      uploadJobId = request.uploadJobId,
      acceptedByteCount = request.byteCount,
    )
  }
}

private class FakeMediaPort(
  private val planId: MediaTierPlanId,
) : MediaPort {
  var lastCandidate: MediaImportCandidate? = null
    private set

  override fun planTiers(candidate: MediaImportCandidate): MediaPlanResult {
    lastCandidate = candidate
    return MediaPlanResult(status = MediaPlanStatus.PLANNED, planId = planId)
  }
}

private fun assertTrue(value: Boolean) {
  if (!value) {
    throw AssertionError("Expected true")
  }
}

private fun assertFalse(value: Boolean) {
  if (value) {
    throw AssertionError("Expected false")
  }
}

private fun <T> assertEquals(expected: T, actual: T) {
  if (expected != actual) {
    throw AssertionError("Expected <$expected> but was <$actual>")
  }
}

private fun expectThrows(label: String, body: () -> Unit) {
  try {
    body()
  } catch (_: IllegalArgumentException) {
    return
  }
  throw AssertionError("Expected IllegalArgumentException for $label")
}
