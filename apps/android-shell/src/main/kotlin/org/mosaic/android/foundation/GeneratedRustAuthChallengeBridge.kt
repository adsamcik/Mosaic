package org.mosaic.android.foundation

/**
 * Slice 0C — auth-challenge transcript / sign / verify bridge.
 *
 * Drives the cross-client `tests/vectors/auth_challenge.json` byte-equality
 * test. Production code paths must use the handle-based account auth
 * helpers; this bridge takes raw signing seeds and is exclusively for
 * the cross-client differential corpus.
 */
object RustAuthChallengeStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val AUTHENTICATION_FAILED: Int = 205
  const val INVALID_SIGNATURE_LENGTH: Int = 211
  const val INVALID_PUBLIC_KEY: Int = 212
  const val INVALID_USERNAME: Int = 213
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class AuthChallengeTranscriptCode {
  SUCCESS,
  INVALID_USERNAME,
  INVALID_INPUT_LENGTH,
  INTERNAL_ERROR,
}

enum class AuthChallengeSignCode {
  SUCCESS,
  INVALID_KEY_LENGTH,
  INTERNAL_ERROR,
}

enum class AuthChallengeVerifyCode {
  SUCCESS,
  AUTHENTICATION_FAILED,
  INVALID_SIGNATURE_LENGTH,
  INVALID_PUBLIC_KEY,
  INVALID_KEY_LENGTH,
  INTERNAL_ERROR,
}

class AuthChallengeTranscriptResult(
  val code: AuthChallengeTranscriptCode,
  transcript: ByteArray,
) {
  init {
    require((code == AuthChallengeTranscriptCode.SUCCESS) == transcript.isNotEmpty()) {
      "successful transcript builds must include bytes; failures must include none"
    }
  }

  private val transcriptBytes: ByteArray = transcript.copyOf()

  val transcript: ByteArray
    get() = transcriptBytes.copyOf()

  override fun toString(): String =
    "AuthChallengeTranscriptResult(code=$code, transcript=<redacted-${transcriptBytes.size}-bytes>)"
}

class AuthChallengeSignResult(
  val code: AuthChallengeSignCode,
  signature: ByteArray,
) {
  init {
    require((code == AuthChallengeSignCode.SUCCESS) == signature.isNotEmpty()) {
      "successful signs must include a 64-byte signature; failures must include none"
    }
    if (code == AuthChallengeSignCode.SUCCESS) {
      require(signature.size == ED25519_SIGNATURE_BYTES) { "signature must be exactly $ED25519_SIGNATURE_BYTES bytes" }
    }
  }

  private val signatureBytes: ByteArray = signature.copyOf()

  val signature: ByteArray
    get() = signatureBytes.copyOf()

  override fun toString(): String =
    "AuthChallengeSignResult(code=$code, signature=<redacted-${signatureBytes.size}-bytes>)"

  companion object {
    const val ED25519_SIGNATURE_BYTES: Int = 64
  }
}

data class AuthChallengeVerifyResult(
  val code: AuthChallengeVerifyCode,
  val valid: Boolean,
) {
  init {
    if (code == AuthChallengeVerifyCode.SUCCESS) {
      require(valid) { "verify SUCCESS implies valid=true" }
    } else {
      require(!valid) { "non-SUCCESS verify must have valid=false" }
    }
  }
}

interface RustAuthChallengeBridge {
  fun buildTranscript(username: String, timestampMs: Long?, challenge: ByteArray): AuthChallengeTranscriptResult

  fun sign(transcript: ByteArray, authSigningSeed: ByteArray): AuthChallengeSignResult

  fun verify(transcript: ByteArray, signature: ByteArray, authPublicKey: ByteArray): AuthChallengeVerifyResult
}

data class RustAuthChallengeVerifyFfiResult(
  val code: Int,
  val valid: Boolean,
) {
  init {
    require(code >= 0) { "auth-verify code must not be negative" }
  }
}

interface GeneratedRustAuthChallengeApi {
  /**
   * `timestampMs < 0` selects the no-timestamp transcript variant.
   */
  fun buildAuthChallengeTranscriptBytes(username: String, timestampMs: Long, challenge: ByteArray): RustBytesFfiResult

  fun signAuthChallengeWithRawSeed(transcript: ByteArray, authSigningSeed: ByteArray): RustBytesFfiResult

  fun verifyAuthChallengeSignature(
    transcript: ByteArray,
    signature: ByteArray,
    authPublicKey: ByteArray,
  ): RustAuthChallengeVerifyFfiResult
}

class GeneratedRustAuthChallengeBridge(
  private val api: GeneratedRustAuthChallengeApi,
) : RustAuthChallengeBridge {
  override fun buildTranscript(
    username: String,
    timestampMs: Long?,
    challenge: ByteArray,
  ): AuthChallengeTranscriptResult {
    val tsArg = timestampMs ?: -1L
    val result = api.buildAuthChallengeTranscriptBytes(username, tsArg, challenge)
    return try {
      val code = when (result.code) {
        RustAuthChallengeStableCode.OK -> AuthChallengeTranscriptCode.SUCCESS
        RustAuthChallengeStableCode.INVALID_USERNAME -> AuthChallengeTranscriptCode.INVALID_USERNAME
        RustAuthChallengeStableCode.INVALID_INPUT_LENGTH -> AuthChallengeTranscriptCode.INVALID_INPUT_LENGTH
        else -> AuthChallengeTranscriptCode.INTERNAL_ERROR
      }
      if (code == AuthChallengeTranscriptCode.SUCCESS) {
        AuthChallengeTranscriptResult(code, transcript = result.bytes)
      } else {
        AuthChallengeTranscriptResult(code, transcript = ByteArray(0))
      }
    } finally {
      result.wipe()
    }
  }

  override fun sign(transcript: ByteArray, authSigningSeed: ByteArray): AuthChallengeSignResult {
    val result = api.signAuthChallengeWithRawSeed(transcript, authSigningSeed)
    return try {
      val code = when (result.code) {
        RustAuthChallengeStableCode.OK -> AuthChallengeSignCode.SUCCESS
        RustAuthChallengeStableCode.INVALID_KEY_LENGTH -> AuthChallengeSignCode.INVALID_KEY_LENGTH
        else -> AuthChallengeSignCode.INTERNAL_ERROR
      }
      if (code == AuthChallengeSignCode.SUCCESS && result.bytes.size == AuthChallengeSignResult.ED25519_SIGNATURE_BYTES) {
        AuthChallengeSignResult(code, signature = result.bytes)
      } else {
        AuthChallengeSignResult(
          if (code == AuthChallengeSignCode.SUCCESS) AuthChallengeSignCode.INTERNAL_ERROR else code,
          signature = ByteArray(0),
        )
      }
    } finally {
      result.wipe()
    }
  }

  override fun verify(
    transcript: ByteArray,
    signature: ByteArray,
    authPublicKey: ByteArray,
  ): AuthChallengeVerifyResult {
    val result = api.verifyAuthChallengeSignature(transcript, signature, authPublicKey)
    val code = when (result.code) {
      RustAuthChallengeStableCode.OK -> AuthChallengeVerifyCode.SUCCESS
      RustAuthChallengeStableCode.AUTHENTICATION_FAILED -> AuthChallengeVerifyCode.AUTHENTICATION_FAILED
      RustAuthChallengeStableCode.INVALID_SIGNATURE_LENGTH -> AuthChallengeVerifyCode.INVALID_SIGNATURE_LENGTH
      RustAuthChallengeStableCode.INVALID_PUBLIC_KEY -> AuthChallengeVerifyCode.INVALID_PUBLIC_KEY
      RustAuthChallengeStableCode.INVALID_KEY_LENGTH -> AuthChallengeVerifyCode.INVALID_KEY_LENGTH
      else -> AuthChallengeVerifyCode.INTERNAL_ERROR
    }
    val valid = code == AuthChallengeVerifyCode.SUCCESS && result.valid
    return AuthChallengeVerifyResult(if (valid) code else if (code == AuthChallengeVerifyCode.SUCCESS) AuthChallengeVerifyCode.AUTHENTICATION_FAILED else code, valid)
  }
}
