package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.MediaPlanStatus
import org.mosaic.android.foundation.MediaImportCandidate
import org.mosaic.android.foundation.StagedMediaReference

class AndroidRustMediaApiRoundTripTest {

  @Test
  fun planMediaTiersReturnsDeferredForUnsurfacedComposite() {
    // The composite "URI → tier plan id" operation is not yet exposed through
    // UniFFI; the adapter explicitly returns DEFERRED.
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustMediaApi()
    val candidate = MediaImportCandidate(
      stagedSource = StagedMediaReference.of("mosaic-staged://example/abc"),
      contentLengthBytes = 1024,
    )
    val plan = api.planMediaTiers(
      org.mosaic.android.foundation.RustMediaPlanFfiRequest.from(candidate),
    )
    assertEquals(450, plan.code)
  }

  @Test
  fun inspectMediaImageRejectsEmptyBytesAtBridgeLevel() {
    val api = AndroidRustMediaApi()
    val ex = runCatching { api.inspectMediaImage(ByteArray(0)) }.exceptionOrNull()
    assertNotEquals(null, ex)
  }

  @Test
  fun inspectMediaImageRejectsGarbageBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustMediaApi()
    val result = api.inspectMediaImage(ByteArray(64) { it.toByte() })
    assertNotEquals(0, result.code)
  }

  @Test
  fun planMediaTierLayoutReturnsValidDimensionsForSquareImage() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustMediaApi()
    val result = api.planMediaTierLayout(width = 4096, height = 4096)
    assertEquals(0, result.code)
    assertEquals(1, result.thumbnail.tier)
    assertEquals(2, result.preview.tier)
    assertEquals(3, result.original.tier)
    assertTrue(result.thumbnail.width > 0 && result.thumbnail.width <= 4096)
    assertTrue(result.preview.width >= result.thumbnail.width)
    assertTrue(result.original.width >= result.preview.width)
  }

  @Test
  fun planMediaTierLayoutRejectsZeroDimensions() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustMediaApi()
    val result = api.planMediaTierLayout(width = 0, height = 0)
    assertNotEquals(0, result.code)
  }
}
