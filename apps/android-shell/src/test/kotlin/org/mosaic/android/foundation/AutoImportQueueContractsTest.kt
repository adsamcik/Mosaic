package org.mosaic.android.foundation

private data class AutoImportQueueContractTestCase(
  val name: String,
  val body: () -> Unit,
)

fun main() {
  val tests = listOf(
    AutoImportQueueContractTestCase("auto-import queue records reject privacy-forbidden fields", ::autoImportQueueRejectsPrivacyForbiddenFields),
    AutoImportQueueContractTestCase("manual picker uploads cannot replace logical photo records", ::manualPickerUploadsCannotReplaceLogicalPhotos),
    AutoImportQueueContractTestCase("retry backoff cancel and resume metadata stays privacy-safe", ::retryBackoffCancelAndResumeIsPrivacySafe),
    AutoImportQueueContractTestCase("asset drift creates replacement versions under same logical photo", ::assetDriftCreatesReplacementVersions),
    AutoImportQueueContractTestCase("TUS offset reconciliation is deterministic", ::tusOffsetReconciliationIsDeterministic),
    AutoImportQueueContractTestCase("manifest finalization is idempotent", ::manifestFinalizationIsIdempotent),
    AutoImportQueueContractTestCase("stuck encrypted staged data retention defaults to seven days", ::retentionDefaultsToSevenDays),
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
    throw IllegalStateException("$failed auto-import queue contract tests failed")
  }

  println("PASS ${tests.size} auto-import queue contract tests")
}

private fun autoImportQueueRejectsPrivacyForbiddenFields() {
  val record = validAutoImportRecord()

  val text = record.toString()
  val forbiddenTerms = listOf(
    "content://",
    "file://",
    "/sdcard/DCIM",
    "IMG_0001.jpg",
    "EXIF",
    "GPS",
    "Pixel",
    "hash",
    "fingerprint",
    "mosaic-local-asset://asset-1",
    "mosaic-encrypted://blob-1",
  )
  forbiddenTerms.forEach { forbidden ->
    assertFalse(text.contains(forbidden, ignoreCase = true))
  }
  assertTrue(text.contains("<redacted>"))

  expectThrows("raw URI rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(rawUri = "content://media/external/images/1"),
    )
  }
  expectThrows("plaintext path rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(plaintextPath = "/sdcard/DCIM/IMG_0001.jpg"),
    )
  }
  expectThrows("filename rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(filename = "IMG_0001.jpg"),
    )
  }
  expectThrows("EXIF rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(exif = mapOf("DateTimeOriginal" to "2026:01:01")),
    )
  }
  expectThrows("GPS rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(gps = "50.087,14.421"),
    )
  }
  expectThrows("device metadata rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(deviceMetadata = mapOf("Model" to "Pixel")),
    )
  }
  expectThrows("content hash rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(plaintextContentHash = "sha256:secret"),
    )
  }
  expectThrows("perceptual fingerprint rejected") {
    validAutoImportRecord(
      prohibited = AutoImportProhibitedPayload(perceptualFingerprint = "phash-secret"),
    )
  }
  expectThrows("raw content URI local identity rejected") {
    AutoImportLocalAssetIdentity.of("content://media/external/images/1")
  }
  expectThrows("plaintext path local identity rejected") {
    AutoImportLocalAssetIdentity.of("/sdcard/DCIM/IMG_0001.jpg")
  }
}

private fun manualPickerUploadsCannotReplaceLogicalPhotos() {
  val manualCreate = LogicalPhotoWriteContract.manualPickerUpload()

  assertEquals(LogicalPhotoWriteMode.CREATE_NEW_PHOTO, manualCreate.mode)
  assertEquals(null, manualCreate.logicalPhotoRecordId)

  expectThrows("manual picker update rejected") {
    LogicalPhotoWriteContract.manualPickerReplacement(LogicalPhotoRecordId("logical-1"))
  }

  val autoCreate = LogicalPhotoWriteContract.autoImportFirstVersion(localIdentity())
  assertEquals(LogicalPhotoWriteMode.CREATE_NEW_PHOTO, autoCreate.mode)
  assertEquals(localIdentity(), autoCreate.localAssetIdentity)

  val autoReplacement = LogicalPhotoWriteContract.autoImportReplacement(
    localAssetIdentity = localIdentity(),
    logicalPhotoRecordId = LogicalPhotoRecordId("logical-1"),
  )
  assertEquals(LogicalPhotoWriteMode.REPLACE_EXISTING_PHOTO_CONTENT, autoReplacement.mode)
  assertEquals(LogicalPhotoRecordId("logical-1"), autoReplacement.logicalPhotoRecordId)
  assertEquals(localIdentity(), autoReplacement.localAssetIdentity)
}

private fun retryBackoffCancelAndResumeIsPrivacySafe() {
  val policy = AutoImportBackoffPolicy(baseDelayMillis = 1000, maxDelayMillis = 8000)
  val firstFailure = AutoImportRetryState.initial().recordRetryableFailure(
    nowEpochMillis = 5000,
    category = AutoImportFailureCategory.TRANSIENT_NETWORK,
    backoffPolicy = policy,
  )

  assertEquals(AutoImportQueueStatus.RETRY_WAITING, firstFailure.status)
  assertEquals(1, firstFailure.retryCount)
  assertEquals(6000L, firstFailure.nextAttemptAtEpochMillis)
  assertEquals(AutoImportFailureCategory.TRANSIENT_NETWORK, firstFailure.lastFailureCategory)

  val cancelled = firstFailure.cancel(nowEpochMillis = 7000)
  assertEquals(AutoImportQueueStatus.CANCELLED, cancelled.status)
  assertEquals(null, cancelled.nextAttemptAtEpochMillis)
  assertEquals(7000L, cancelled.cancelledAtEpochMillis)

  val resumed = cancelled.resume(nowEpochMillis = 8000)
  assertEquals(AutoImportQueueStatus.READY, resumed.status)
  assertEquals(1, resumed.retryCount)
  assertEquals(null, resumed.nextAttemptAtEpochMillis)
  assertEquals(null, resumed.cancelledAtEpochMillis)
  assertEquals(8000L, resumed.lastResumedAtEpochMillis)

  val retryText = resumed.toString()
  val forbiddenTerms = listOf("content://", "file://", "/sdcard/DCIM", "IMG_0001.jpg", "EXIF", "GPS")
  forbiddenTerms.forEach { forbidden ->
    assertFalse(retryText.contains(forbidden, ignoreCase = true))
  }
}

private fun assetDriftCreatesReplacementVersions() {
  val previous = AutoImportAssetSnapshot(
    localAssetIdentity = localIdentity(),
    localVersionToken = AutoImportLocalVersionToken("version-1"),
    contentLengthBytes = 1024,
    observedAtEpochMillis = 10_000,
  )
  val unchanged = previous.copy(observedAtEpochMillis = 11_000)
  val edited = previous.copy(
    localVersionToken = AutoImportLocalVersionToken("version-2"),
    contentLengthBytes = 2048,
    observedAtEpochMillis = 12_000,
  )

  assertEquals(AutoImportDriftStatus.UNCHANGED, unchanged.detectDriftFrom(previous).status)
  val drift = edited.detectDriftFrom(previous)
  assertEquals(AutoImportDriftStatus.CONTENT_CHANGED, drift.status)
  assertEquals(previous, drift.previousSnapshot)
  assertEquals(edited, drift.currentSnapshot)

  val plan = AutoImportContentReplacementPlan.create(
    logicalPhotoRecordId = LogicalPhotoRecordId("logical-1"),
    previousVersionId = EncryptedContentVersionId("version-old"),
    replacementVersionId = EncryptedContentVersionId("version-new"),
    replacementEncryptedBlobRef = EncryptedBlobReference.of("mosaic-encrypted://blob-new"),
    replacementManifestFinalizationKey = ManifestFinalizationIdempotencyKey("finalize-1"),
    drift = drift,
  )

  assertEquals(LogicalPhotoRecordId("logical-1"), plan.logicalPhotoRecordId)
  assertEquals(EncryptedContentVersionId("version-old"), plan.previousVersionId)
  assertEquals(EncryptedContentVersionId("version-new"), plan.replacementVersionId)
  assertFalse(plan.isPreviousVersionGcEligible(ManifestFinalizationLedger.pending(ManifestFinalizationIdempotencyKey("finalize-1"))))

  val unrelatedFinalized = ManifestFinalizationLedger.pending(ManifestFinalizationIdempotencyKey("finalize-other"))
    .recordSuccess(
      idempotencyKey = ManifestFinalizationIdempotencyKey("finalize-other"),
      manifestRef = EncryptedManifestReference.of("mosaic-encrypted://manifest-other"),
      finalizedAtEpochMillis = 12_500,
    )
    .ledger
  assertFalse(plan.isPreviousVersionGcEligible(unrelatedFinalized))

  val finalized = ManifestFinalizationLedger.pending(ManifestFinalizationIdempotencyKey("finalize-1"))
    .recordSuccess(
      idempotencyKey = ManifestFinalizationIdempotencyKey("finalize-1"),
      manifestRef = EncryptedManifestReference.of("mosaic-encrypted://manifest-new"),
      finalizedAtEpochMillis = 13_000,
    )
    .ledger

  assertTrue(plan.isPreviousVersionGcEligible(finalized))
}

private fun tusOffsetReconciliationIsDeterministic() {
  val offset = TusOffsetState(
    uploadSessionId = TusUploadSessionId("upload-1"),
    totalBytes = 1000,
    localCommittedOffset = 400,
  )

  val unchanged = offset.reconcile(serverOffset = 400, observedAtEpochMillis = 20_000)
  assertEquals(TusOffsetDecision.ALREADY_IN_SYNC, unchanged.decision)
  assertEquals(400, unchanged.state.localCommittedOffset)

  val rewind = offset.reconcile(serverOffset = 250, observedAtEpochMillis = 20_001)
  assertEquals(TusOffsetDecision.REWIND_LOCAL_TO_SERVER, rewind.decision)
  assertEquals(250, rewind.state.localCommittedOffset)

  val fastForward = offset.reconcile(serverOffset = 800, observedAtEpochMillis = 20_002)
  assertEquals(TusOffsetDecision.FAST_FORWARD_LOCAL_TO_SERVER, fastForward.decision)
  assertEquals(800, fastForward.state.localCommittedOffset)

  val complete = offset.reconcile(serverOffset = 1000, observedAtEpochMillis = 20_003)
  assertEquals(TusOffsetDecision.SERVER_HAS_COMPLETE_UPLOAD, complete.decision)
  assertEquals(1000, complete.state.localCommittedOffset)

  expectThrows("server offset beyond encrypted blob rejected") {
    offset.reconcile(serverOffset = 1001, observedAtEpochMillis = 20_004)
  }
}

private fun manifestFinalizationIsIdempotent() {
  val pending = ManifestFinalizationLedger.pending(ManifestFinalizationIdempotencyKey("finalize-1"))
  val success = pending.recordSuccess(
    idempotencyKey = ManifestFinalizationIdempotencyKey("finalize-1"),
    manifestRef = EncryptedManifestReference.of("mosaic-encrypted://manifest-1"),
    finalizedAtEpochMillis = 30_000,
  )

  assertEquals(ManifestFinalizationTransition.FINALIZED_NOW, success.transition)
  assertTrue(success.ledger.isFinalized)

  val replay = success.ledger.recordSuccess(
    idempotencyKey = ManifestFinalizationIdempotencyKey("finalize-1"),
    manifestRef = EncryptedManifestReference.of("mosaic-encrypted://manifest-1"),
    finalizedAtEpochMillis = 31_000,
  )

  assertEquals(ManifestFinalizationTransition.IDEMPOTENT_REPLAY, replay.transition)
  assertEquals(success.ledger, replay.ledger)

  expectThrows("different finalized manifest rejected") {
    success.ledger.recordSuccess(
      idempotencyKey = ManifestFinalizationIdempotencyKey("finalize-1"),
      manifestRef = EncryptedManifestReference.of("mosaic-encrypted://manifest-2"),
      finalizedAtEpochMillis = 32_000,
    )
  }
}

private fun retentionDefaultsToSevenDays() {
  val policy = AutoImportRetentionPolicy.default()
  val stagedAt = 40_000L

  assertEquals(7, policy.stuckEncryptedStagingRetentionDays)
  assertEquals(stagedAt + 7L * 24L * 60L * 60L * 1000L, policy.expiresAtEpochMillis(stagedAt))
  assertFalse(policy.isExpired(stagedAtEpochMillis = stagedAt, nowEpochMillis = stagedAt + 7L * 24L * 60L * 60L * 1000L - 1))
  assertTrue(policy.isExpired(stagedAtEpochMillis = stagedAt, nowEpochMillis = stagedAt + 7L * 24L * 60L * 60L * 1000L))
}

private fun validAutoImportRecord(
  prohibited: AutoImportProhibitedPayload = AutoImportProhibitedPayload.None,
): AutoImportQueueRecord =
  AutoImportQueueRecord.create(
    id = AutoImportQueueRecordId("auto-queue-1"),
    serverAccountId = ServerAccountId("server-account-1"),
    albumId = AlbumId("album-1"),
    localAssetIdentity = localIdentity(),
    logicalPhotoRecordId = LogicalPhotoRecordId("logical-1"),
    stagedEncryptedBlobRef = EncryptedBlobReference.of("mosaic-encrypted://blob-1"),
    contentLengthBytes = 1024,
    createdAtEpochMillis = 1000,
    retryState = AutoImportRetryState.initial(),
    prohibited = prohibited,
  )

private fun localIdentity(): AutoImportLocalAssetIdentity =
  AutoImportLocalAssetIdentity.of("mosaic-local-asset://asset-1")

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
