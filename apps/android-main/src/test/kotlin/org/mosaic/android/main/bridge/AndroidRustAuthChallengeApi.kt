package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustAuthChallengeApi
import org.mosaic.android.foundation.RustAuthChallengeVerifyFfiResult
import org.mosaic.android.foundation.RustBytesFfiResult
import uniffi.mosaic_uniffi.buildAuthChallengeTranscriptBytes as rustBuildAuthTranscript
import uniffi.mosaic_uniffi.signAuthChallengeWithRawSeed as rustSignAuthChallenge
import uniffi.mosaic_uniffi.verifyAuthChallengeSignature as rustVerifyAuthChallenge

/**
 * Real implementation of [GeneratedRustAuthChallengeApi] backed by the Rust
 * UniFFI core. Delegates to the cross-client raw-seed auth-challenge
 * exports.
 *
 * SECURITY: Production auth flows must use the handle-based account
 * helpers; only Slice 0C round-trip tests are permitted to reference this
 * class.
 */
class AndroidRustAuthChallengeApi : GeneratedRustAuthChallengeApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun buildAuthChallengeTranscriptBytes(
    username: String,
    timestampMs: Long,
    challenge: ByteArray,
  ): RustBytesFfiResult {
    require(username.length <= MAX_USERNAME_CHARS) {
      "username must be at most $MAX_USERNAME_CHARS characters"
    }
    require(challenge.size <= MAX_CHALLENGE_BYTES) {
      "challenge must be at most $MAX_CHALLENGE_BYTES bytes"
    }
    val result = rustBuildAuthTranscript(username, timestampMs, challenge)
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun signAuthChallengeWithRawSeed(
    transcript: ByteArray,
    authSigningSeed: ByteArray,
  ): RustBytesFfiResult {
    require(transcript.size <= MAX_TRANSCRIPT_BYTES) {
      "auth transcript must be at most $MAX_TRANSCRIPT_BYTES bytes"
    }
    require(authSigningSeed.size <= MAX_SEED_BYTES) {
      "auth signing seed must be at most $MAX_SEED_BYTES bytes"
    }
    val result = rustSignAuthChallenge(transcript, authSigningSeed)
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun verifyAuthChallengeSignature(
    transcript: ByteArray,
    signature: ByteArray,
    authPublicKey: ByteArray,
  ): RustAuthChallengeVerifyFfiResult {
    require(transcript.size <= MAX_TRANSCRIPT_BYTES) {
      "auth transcript must be at most $MAX_TRANSCRIPT_BYTES bytes"
    }
    require(signature.size <= MAX_SIGNATURE_BYTES) {
      "signature must be at most $MAX_SIGNATURE_BYTES bytes"
    }
    require(authPublicKey.size <= MAX_PUBLIC_KEY_BYTES) {
      "auth public key must be at most $MAX_PUBLIC_KEY_BYTES bytes"
    }
    val result = rustVerifyAuthChallenge(transcript, signature, authPublicKey)
    return RustAuthChallengeVerifyFfiResult(code = result.code.toInt(), valid = result.valid)
  }

  companion object {
    private const val MAX_USERNAME_CHARS: Int = 256
    private const val MAX_CHALLENGE_BYTES: Int = 256
    private const val MAX_TRANSCRIPT_BYTES: Int = 4 * 1024
    private const val MAX_SEED_BYTES: Int = 64
    private const val MAX_SIGNATURE_BYTES: Int = 128
    private const val MAX_PUBLIC_KEY_BYTES: Int = 64
  }
}
