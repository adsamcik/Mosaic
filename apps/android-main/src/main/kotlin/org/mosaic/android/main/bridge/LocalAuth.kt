package org.mosaic.android.main.bridge

import java.text.Normalizer

fun normalizePasswordForKdf(password: String): ByteArray =
  Normalizer.normalize(password, Normalizer.Form.NFKC).toByteArray(Charsets.UTF_8)
