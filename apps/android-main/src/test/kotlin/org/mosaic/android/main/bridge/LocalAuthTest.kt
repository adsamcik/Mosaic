package org.mosaic.android.main.bridge

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class LocalAuthTest {
  @Test
  fun normalizePasswordForKdfUsesNfkcUtf8Bytes() {
    val nfd = normalizePasswordForKdf("cafe\u0301")
    val nfc = normalizePasswordForKdf("caf\u00e9")

    assertArrayEquals(nfc, nfd)
    assertArrayEquals(byteArrayOf(0x63, 0x61, 0x66, 0xc3.toByte(), 0xa9.toByte()), nfc)

    nfd.fill(0)
    nfc.fill(0)
  }
}
