package org.mosaic.android.foundation

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
    TestCase("fake rust bridge models account unlock lifecycle", ::fakeRustBridgeModelsUnlockLifecycle),
    TestCase("generated rust bridge maps UniFFI account calls", ::generatedRustBridgeMapsUniFfiAccountCalls),
    TestCase("work policy defaults to foreground dataSync", ::workPolicyDefaultsToForegroundDataSync),
    TestCase("media port exposes a stub and fake seam", ::mediaPortExposesStubAndFakeSeam),
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
