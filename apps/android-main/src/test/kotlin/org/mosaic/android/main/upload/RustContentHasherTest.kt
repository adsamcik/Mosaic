package org.mosaic.android.main.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class RustContentHasherTest {
  @Test
  fun sha256HexMatchesStandardVectors() {
    assertEquals(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      RustContentHasher.sha256Hex(ByteArray(0)),
    )
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      RustContentHasher.sha256Hex("abc".toByteArray(Charsets.UTF_8)),
    )
  }
}
