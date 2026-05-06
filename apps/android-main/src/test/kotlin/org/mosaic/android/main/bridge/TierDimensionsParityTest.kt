package org.mosaic.android.main.bridge

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.mosaic_uniffi.canonicalTierLayout as rustCanonicalTierLayout

class TierDimensionsParityTest {

  @Test
  fun androidTierDimensionsMatchCanonicalFromRustCore() {
    AndroidRustCoreLibraryLoader.warmUp()

    val canonical = rustCanonicalTierLayout()
    val planned = AndroidRustMediaApi().planMediaTierLayout(
      width = canonical.original.width.toInt(),
      height = canonical.original.height.toInt(),
    )

    assertEquals(0, canonical.code.toInt())
    assertEquals(canonical.code.toInt(), planned.code)
    assertEquals(canonical.thumbnail.tier.toInt(), planned.thumbnail.tier)
    assertEquals(canonical.thumbnail.width.toInt(), planned.thumbnail.width)
    assertEquals(canonical.thumbnail.height.toInt(), planned.thumbnail.height)
    assertEquals(canonical.preview.tier.toInt(), planned.preview.tier)
    assertEquals(canonical.preview.width.toInt(), planned.preview.width)
    assertEquals(canonical.preview.height.toInt(), planned.preview.height)
    assertEquals(canonical.original.tier.toInt(), planned.original.tier)
    assertEquals(canonical.original.width.toInt(), planned.original.width)
    assertEquals(canonical.original.height.toInt(), planned.original.height)
  }
}
