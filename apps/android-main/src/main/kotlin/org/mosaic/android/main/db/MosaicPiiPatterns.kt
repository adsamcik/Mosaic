package org.mosaic.android.main.db

object MosaicPiiPatterns {
  const val EMAIL_SQL_LIKE: String = "%@%.%"

  val EMAIL: Regex = Regex("@.*\\.", RegexOption.IGNORE_CASE)
  val CRYPTO_KEY_HEX_32_BYTE: Regex = Regex("""(?i)\b[0-9a-f]{64}\b""")
  val CRYPTO_KEY_HEX_64_BYTE: Regex = Regex("""(?i)\b[0-9a-f]{128}\b""")
  val CRYPTO_KEY_BASE64_32_BYTE: Regex = Regex("""(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43}=(?![A-Za-z0-9+/_-])""")
  val CRYPTO_KEY_BASE64_64_BYTE: Regex = Regex("""(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{86}==(?![A-Za-z0-9+/_-])""")
  val EXIF_GPS_COORDINATE: Regex = Regex(
    """(?i)\b(?:lat(?:itude)?|lon(?:gitude)?)\s*[:=]\s*[-+]?(?:\d{1,2}|1[0-7]\d|180)\.\d{5,}\b|""" +
      """\b[-+]?(?:\d{1,2}|1[0-7]\d|180)\.\d{5,}\s*,\s*[-+]?(?:\d{1,2}|1[0-7]\d|180)\.\d{5,}\b""",
  )
  val ANDROID_CAMERA_FILENAME: Regex = Regex("""(?i)\bIMG_\d{8}_[A-Z0-9_-]+\.jpe?g\b""")
  val E164_PHONE_NUMBER: Regex = Regex("""(?<![\w+])\+[1-9]\d{7,14}(?!\w)""")

  val ALL: List<NamedPrivacyPattern> = listOf(
    NamedPrivacyPattern("email", EMAIL),
    NamedPrivacyPattern("crypto-key-hex-32-byte", CRYPTO_KEY_HEX_32_BYTE),
    NamedPrivacyPattern("crypto-key-hex-64-byte", CRYPTO_KEY_HEX_64_BYTE),
    NamedPrivacyPattern("crypto-key-base64-32-byte", CRYPTO_KEY_BASE64_32_BYTE),
    NamedPrivacyPattern("crypto-key-base64-64-byte", CRYPTO_KEY_BASE64_64_BYTE),
    NamedPrivacyPattern("exif-gps-coordinate", EXIF_GPS_COORDINATE),
    NamedPrivacyPattern("android-camera-filename", ANDROID_CAMERA_FILENAME),
    NamedPrivacyPattern("e164-phone-number", E164_PHONE_NUMBER),
  )
}

data class NamedPrivacyPattern(
  val name: String,
  val regex: Regex,
)
