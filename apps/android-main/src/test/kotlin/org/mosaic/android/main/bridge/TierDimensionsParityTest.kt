package org.mosaic.android.main.bridge

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

class TierDimensionsParityTest {

  @Test
  fun androidTierDimensionsMatchCanonicalFromRustCore() {
    assumeTrue(NativeLibraryAvailability.isAvailable)

    val canonical = AndroidRustMediaApi().planMediaTierLayout(width = 4096, height = 4096)

    assertEquals(0, canonical.code)
    assertEquals(1, canonical.thumbnail.tier)
    assertEquals(256, canonical.thumbnail.width)
    assertEquals(256, canonical.thumbnail.height)
    assertEquals(2, canonical.preview.tier)
    assertEquals(1024, canonical.preview.width)
    assertEquals(1024, canonical.preview.height)
    assertEquals(3, canonical.original.tier)
    assertEquals(4096, canonical.original.width)
    assertEquals(4096, canonical.original.height)
  }
}
