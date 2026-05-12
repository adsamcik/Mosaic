package org.mosaic.android.main.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ZeroizeTest {
  @Test
  fun zeroizeFillsArrayWithZeros() {
    val bytes = byteArrayOf(1, 2, 3, 4)

    bytes.zeroize()

    assertArrayEquals(byteArrayOf(0, 0, 0, 0), bytes)
  }

  @Test
  fun useZeroizedRunsBlockAndZerosArray() {
    val bytes = byteArrayOf(1, 2, 3, 4)

    val result = bytes.useZeroized { plaintext -> plaintext.sum() }

    assertEquals(10, result)
    assertArrayEquals(byteArrayOf(0, 0, 0, 0), bytes)
  }

  @Test
  fun useZeroizedZerosArrayWhenBlockThrows() {
    val bytes = byteArrayOf(1, 2, 3, 4)

    assertThrows(IllegalStateException::class.java) {
      bytes.useZeroized { error("boom") }
    }

    assertArrayEquals(byteArrayOf(0, 0, 0, 0), bytes)
  }
}
