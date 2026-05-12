package org.mosaic.android.main.security

import java.util.Arrays

fun ByteArray.zeroize() {
  Arrays.fill(this, 0)
}

inline fun <T> ByteArray.useZeroized(block: (ByteArray) -> T): T =
  try {
    block(this)
  } finally {
    zeroize()
  }
