package org.mosaic.android.foundation

private data class AutoImportMediaPolicyTestCase(
  val name: String,
  val body: () -> Unit,
)

fun runAutoImportMediaPolicyTests(): Int {
  val tests = listOf(
    AutoImportMediaPolicyTestCase(
      "auto-import defaults stay disabled with Wi-Fi and battery safeguards",
      ::autoImportDefaultsStayDisabledWithSafeConstraints,
    ),
    AutoImportMediaPolicyTestCase("auto-import permission decisions are API-level aware", ::autoImportPermissionDecisionsAreApiAware),
    AutoImportMediaPolicyTestCase("auto-import requires selected album opt-in", ::autoImportRequiresSelectedAlbumOptIn),
    AutoImportMediaPolicyTestCase("auto-import durable media records reject raw URIs", ::autoImportDurableRecordsRejectRawUris),
    AutoImportMediaPolicyTestCase("auto-import durable records reject plaintext metadata", ::autoImportDurableRecordsRejectPlaintextMetadata),
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
    throw IllegalStateException("$failed Android auto-import media policy tests failed")
  }

  return tests.size
}

fun main() {
  val testCount = runAutoImportMediaPolicyTests()
  println("PASS $testCount auto-import media policy tests")
}

private fun autoImportDefaultsStayDisabledWithSafeConstraints() {
  val policy = AutoImportMediaPolicyRecord.defaultDisabled()
  val decision = AutoImportMediaPermissionPolicy.decisionFor(
    apiLevel = AndroidMediaApiLevel(33),
    mediaTypes = setOf(AutoImportMediaType.PHOTO),
  )

  assertFalse(policy.enabled)
  assertEquals(null, policy.selectedAlbumOptIn)
  assertTrue(policy.constraints.requiresWifi)
  assertTrue(policy.constraints.requiresBatteryNotLow)
  assertEquals(AutoImportMediaPolicyStatus.DISABLED_BY_DEFAULT, policy.evaluate(decision).status)
  assertFalse(policy.toString().contains("content://"))
  assertFalse(policy.toString().contains("mosaic-staged://"))
}

private fun autoImportPermissionDecisionsAreApiAware() {
  val photoOnly = AutoImportMediaPermissionPolicy.decisionFor(
    apiLevel = AndroidMediaApiLevel(33),
    mediaTypes = setOf(AutoImportMediaType.PHOTO),
  )
  assertEquals(AutoImportPermissionModel.MODERN_PHOTO_VIDEO_READ, photoOnly.permissionModel)
  assertEquals(setOf(AutoImportMediaRuntimePermission.READ_MEDIA_IMAGES), photoOnly.runtimePermissions)
  assertEquals(AutoImportLibraryScope.SELECTED_ALBUM_OPT_IN_ONLY, photoOnly.libraryScope)
  assertFalse(photoOnly.requestsAllFilesAccess)
  assertEquals(emptyList<String>(), photoOnly.staticPolicyViolations())

  val photoAndVideo = AutoImportMediaPermissionPolicy.decisionFor(
    apiLevel = AndroidMediaApiLevel(34),
    mediaTypes = setOf(AutoImportMediaType.PHOTO, AutoImportMediaType.VIDEO),
  )
  assertEquals(
    setOf(AutoImportMediaRuntimePermission.READ_MEDIA_IMAGES, AutoImportMediaRuntimePermission.READ_MEDIA_VIDEO),
    photoAndVideo.runtimePermissions,
  )

  val olderStorageStyle = AutoImportMediaPermissionPolicy.decisionFor(
    apiLevel = AndroidMediaApiLevel(32),
    mediaTypes = setOf(AutoImportMediaType.PHOTO, AutoImportMediaType.VIDEO),
  )
  assertEquals(AutoImportPermissionModel.LEGACY_STORAGE_READ, olderStorageStyle.permissionModel)
  assertEquals(setOf(AutoImportMediaRuntimePermission.READ_EXTERNAL_STORAGE), olderStorageStyle.runtimePermissions)
  assertFalse(olderStorageStyle.requestsAllFilesAccess)

  val invalid = olderStorageStyle.copy(requestsAllFilesAccess = true)
  assertEquals(
    listOf("auto-import must not request Android all-files storage access"),
    invalid.staticPolicyViolations(),
  )
}

private fun autoImportRequiresSelectedAlbumOptIn() {
  val decision = AutoImportMediaPermissionPolicy.decisionFor(
    apiLevel = AndroidMediaApiLevel(34),
    mediaTypes = setOf(AutoImportMediaType.PHOTO),
  )
  val enabledWithoutAlbum = AutoImportMediaPolicyRecord.create(enabled = true, selectedAlbumOptIn = null)

  assertEquals(AutoImportMediaPolicyStatus.NEEDS_SELECTED_ALBUM_OPT_IN, enabledWithoutAlbum.evaluate(decision).status)

  val optIn = AutoImportSelectedAlbumOptIn.create(
    localAlbumIdentity = OpaqueLocalAlbumIdentity("local-album-token-1"),
    destinationAlbumId = AlbumId("mosaic-album-1"),
  )
  val ready = AutoImportMediaPolicyRecord.create(enabled = true, selectedAlbumOptIn = optIn).evaluate(decision)

  assertEquals(AutoImportUxFraming.IMPORT_UPLOAD_CONVENIENCE_NOT_BACKUP, optIn.uxFraming)
  assertEquals(AutoImportMediaPolicyStatus.READY_FOR_PERMISSION_CHECK, ready.status)
  assertTrue(optIn.toString().contains("IMPORT_UPLOAD_CONVENIENCE_NOT_BACKUP"))
  assertFalse(optIn.toString().contains("backup copy", ignoreCase = true))
}

private fun autoImportDurableRecordsRejectRawUris() {
  expectThrows("raw content URI album identity rejected") {
    OpaqueLocalAlbumIdentity("content://media/external/images/1")
  }
  expectThrows("raw file URI asset identity rejected") {
    OpaqueLocalMediaAssetIdentity("file:///sdcard/DCIM/IMG_0001.jpg")
  }
  expectThrows("raw URI durable record rejected") {
    durableMediaRecord(
      prohibited = AutoImportProhibitedDurableFields(rawContentUri = "content://media/external/images/1"),
    )
  }

  val record = durableMediaRecord()
  val text = record.toString()

  assertEquals(OpaqueLocalMediaAssetIdentity("asset-token-1"), record.localAssetIdentity)
  assertFalse(text.contains("content://"))
  assertFalse(text.contains("file://"))
  assertFalse(text.contains("mosaic-staged://"))
  assertTrue(text.contains("<redacted>"))
}

private fun autoImportDurableRecordsRejectPlaintextMetadata() {
  val rejectedFields = listOf(
    AutoImportProhibitedDurableFields(filename = "IMG_0001.jpg"),
    AutoImportProhibitedDurableFields(caption = "private caption"),
    AutoImportProhibitedDurableFields(exif = mapOf("DateTimeOriginal" to "2026:01:01")),
    AutoImportProhibitedDurableFields(gps = "50.087,14.421"),
    AutoImportProhibitedDurableFields(deviceMetadata = mapOf("Make" to "Pixel camera")),
  )

  rejectedFields.forEachIndexed { index, prohibited ->
    expectThrows("durable plaintext metadata rejected $index") {
      durableMediaRecord(prohibited = prohibited)
    }
  }

  val optIn = AutoImportSelectedAlbumOptIn.create(
    localAlbumIdentity = OpaqueLocalAlbumIdentity("local-album-token-privacy"),
    destinationAlbumId = AlbumId("mosaic-album-privacy"),
  )
  val policy = AutoImportMediaPolicyRecord.create(enabled = true, selectedAlbumOptIn = optIn)
  val record = durableMediaRecord()
  val safeDtos = listOf(
    optIn.toString(),
    policy.toString(),
    record.toString(),
    AutoImportProhibitedDurableFields(filename = "IMG_0001.jpg", rawContentUri = "content://raw").toString(),
  )
  val forbiddenTerms = listOf(
    "content://",
    "file://",
    "mosaic-staged://",
    "filename",
    "IMG_0001.jpg",
    "EXIF",
    "GPS",
    "camera",
    "device",
    "private",
    "secret",
    "DCIM",
    ".jpg",
  )

  for (dto in safeDtos) {
    for (term in forbiddenTerms) {
      assertFalse(dto.contains(term, ignoreCase = true))
    }
  }
}

private fun durableMediaRecord(
  prohibited: AutoImportProhibitedDurableFields = AutoImportProhibitedDurableFields.None,
): AutoImportDurableMediaRecord = AutoImportDurableMediaRecord.create(
  localAssetIdentity = OpaqueLocalMediaAssetIdentity("asset-token-1"),
  selectedAlbumIdentity = OpaqueLocalAlbumIdentity("local-album-token-1"),
  encryptedStagedSource = StagedMediaReference.of("mosaic-staged://auto-import/encrypted-source-1"),
  discoveredAtEpochMillis = 9000,
  prohibited = prohibited,
)

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
