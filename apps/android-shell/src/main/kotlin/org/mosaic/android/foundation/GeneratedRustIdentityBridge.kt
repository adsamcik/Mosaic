package org.mosaic.android.foundation

object RustIdentityStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val AUTHENTICATION_FAILED: Int = 205
  const val INVALID_SIGNATURE_LENGTH: Int = 211
  const val INVALID_PUBLIC_KEY: Int = 212
  const val SECRET_HANDLE_NOT_FOUND: Int = 400
  const val IDENTITY_HANDLE_NOT_FOUND: Int = 401
  const val HANDLE_SPACE_EXHAUSTED: Int = 402
  const val INTERNAL_STATE_POISONED: Int = 500
}

@JvmInline
value class IdentityHandle(val value: Long) {
  init {
    require(value > 0) { "identity handle must be positive" }
  }

  override fun toString(): String = "IdentityHandle(<redacted>)"
}

enum class IdentityCreateCode {
  SUCCESS,
  ACCOUNT_HANDLE_NOT_FOUND,
  HANDLE_SPACE_EXHAUSTED,
  INTERNAL_ERROR,
}

enum class IdentityOpenCode {
  SUCCESS,
  ACCOUNT_HANDLE_NOT_FOUND,
  AUTHENTICATION_FAILED,
  INVALID_INPUT_LENGTH,
  HANDLE_SPACE_EXHAUSTED,
  INTERNAL_ERROR,
}

enum class IdentityPubkeyCode {
  SUCCESS,
  IDENTITY_HANDLE_NOT_FOUND,
  INTERNAL_ERROR,
}

enum class IdentitySignCode {
  SUCCESS,
  IDENTITY_HANDLE_NOT_FOUND,
  INVALID_INPUT_LENGTH,
  INTERNAL_ERROR,
}

enum class IdentityCloseCode {
  SUCCESS,
  NOT_FOUND,
  INTERNAL_ERROR,
}

class IdentityCreateResult(
  val code: IdentityCreateCode,
  val handle: IdentityHandle?,
  signingPubkey: ByteArray,
  encryptionPubkey: ByteArray,
  wrappedSeed: ByteArray,
) {
  init {
    require((code == IdentityCreateCode.SUCCESS) == (handle != null)) {
      "successful identity creates require a handle; failures must not include one"
    }
  }

  private val signingPubkeyBytes: ByteArray = signingPubkey.copyOf()
  private val encryptionPubkeyBytes: ByteArray = encryptionPubkey.copyOf()
  private val wrappedSeedBytes: ByteArray = wrappedSeed.copyOf()

  val signingPubkey: ByteArray
    get() = signingPubkeyBytes.copyOf()

  val encryptionPubkey: ByteArray
    get() = encryptionPubkeyBytes.copyOf()

  val wrappedSeed: ByteArray
    get() = wrappedSeedBytes.copyOf()

  fun wipe() {
    signingPubkeyBytes.fill(0)
    encryptionPubkeyBytes.fill(0)
    wrappedSeedBytes.fill(0)
  }

  override fun toString(): String =
    "IdentityCreateResult(code=$code, handle=$handle, signingPubkey=<redacted>, " +
      "encryptionPubkey=<redacted>, wrappedSeed=<redacted>)"
}

class IdentityOpenResult(
  val code: IdentityOpenCode,
  val handle: IdentityHandle?,
  signingPubkey: ByteArray,
  encryptionPubkey: ByteArray,
) {
  init {
    require((code == IdentityOpenCode.SUCCESS) == (handle != null)) {
      "successful identity opens require a handle; failures must not include one"
    }
  }

  private val signingPubkeyBytes: ByteArray = signingPubkey.copyOf()
  private val encryptionPubkeyBytes: ByteArray = encryptionPubkey.copyOf()

  val signingPubkey: ByteArray
    get() = signingPubkeyBytes.copyOf()

  val encryptionPubkey: ByteArray
    get() = encryptionPubkeyBytes.copyOf()

  fun wipe() {
    signingPubkeyBytes.fill(0)
    encryptionPubkeyBytes.fill(0)
  }

  override fun toString(): String =
    "IdentityOpenResult(code=$code, handle=$handle, signingPubkey=<redacted>, encryptionPubkey=<redacted>)"
}

class IdentityPubkeyResult(
  val code: IdentityPubkeyCode,
  pubkey: ByteArray,
) {
  init {
    if (code == IdentityPubkeyCode.SUCCESS) {
      require(pubkey.isNotEmpty()) { "successful pubkey results must include bytes" }
    }
  }

  private val pubkeyBytes: ByteArray = pubkey.copyOf()

  val pubkey: ByteArray
    get() = pubkeyBytes.copyOf()

  fun wipe() {
    pubkeyBytes.fill(0)
  }

  override fun toString(): String = "IdentityPubkeyResult(code=$code, pubkey=<redacted>)"
}

class ManifestSignatureResult(
  val code: IdentitySignCode,
  signature: ByteArray,
) {
  init {
    if (code == IdentitySignCode.SUCCESS) {
      require(signature.isNotEmpty()) { "successful signature results must include bytes" }
    }
  }

  private val signatureBytes: ByteArray = signature.copyOf()

  val signature: ByteArray
    get() = signatureBytes.copyOf()

  fun wipe() {
    signatureBytes.fill(0)
  }

  override fun toString(): String = "ManifestSignatureResult(code=$code, signature=<redacted>)"
}

interface RustIdentityBridge {
  fun createIdentity(accountKeyHandle: AccountKeyHandle): IdentityCreateResult

  fun openIdentity(wrappedSeed: ByteArray, accountKeyHandle: AccountKeyHandle): IdentityOpenResult

  fun signingPubkey(handle: IdentityHandle): IdentityPubkeyResult

  fun encryptionPubkey(handle: IdentityHandle): IdentityPubkeyResult

  fun signManifest(handle: IdentityHandle, transcriptBytes: ByteArray): ManifestSignatureResult

  fun closeIdentity(handle: IdentityHandle): IdentityCloseCode
}

data class RustIdentityHandleFfiResult(
  val code: Int,
  val handle: Long,
  val signingPubkey: ByteArray,
  val encryptionPubkey: ByteArray,
  val wrappedSeed: ByteArray,
) {
  init {
    require(code >= 0) { "identity code must not be negative" }
    require(handle >= 0) { "identity handle must not be negative" }
  }

  fun wipe() {
    signingPubkey.fill(0)
    encryptionPubkey.fill(0)
    wrappedSeed.fill(0)
  }

  override fun toString(): String =
    "RustIdentityHandleFfiResult(code=$code, handle=<redacted>, signingPubkey=<redacted>, " +
      "encryptionPubkey=<redacted>, wrappedSeed=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustIdentityHandleFfiResult) return false
    return code == other.code &&
      handle == other.handle &&
      signingPubkey.contentEquals(other.signingPubkey) &&
      encryptionPubkey.contentEquals(other.encryptionPubkey) &&
      wrappedSeed.contentEquals(other.wrappedSeed)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + handle.hashCode()
    result = 31 * result + signingPubkey.contentHashCode()
    result = 31 * result + encryptionPubkey.contentHashCode()
    result = 31 * result + wrappedSeed.contentHashCode()
    return result
  }
}

data class RustBytesFfiResult(
  val code: Int,
  val bytes: ByteArray,
) {
  init {
    require(code >= 0) { "bytes result code must not be negative" }
  }

  fun wipe() {
    bytes.fill(0)
  }

  override fun toString(): String = "RustBytesFfiResult(code=$code, bytes=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustBytesFfiResult) return false
    return code == other.code && bytes.contentEquals(other.bytes)
  }

  override fun hashCode(): Int = 31 * code + bytes.contentHashCode()
}

interface GeneratedRustIdentityApi {
  fun createIdentityHandle(accountKeyHandle: Long): RustIdentityHandleFfiResult

  fun openIdentityHandle(wrappedSeed: ByteArray, accountKeyHandle: Long): RustIdentityHandleFfiResult

  fun identitySigningPubkey(handle: Long): RustBytesFfiResult

  fun identityEncryptionPubkey(handle: Long): RustBytesFfiResult

  fun signManifestWithIdentity(handle: Long, transcriptBytes: ByteArray): RustBytesFfiResult

  fun closeIdentityHandle(handle: Long): Int
}

class GeneratedRustIdentityBridge(
  private val api: GeneratedRustIdentityApi,
) : RustIdentityBridge {
  override fun createIdentity(accountKeyHandle: AccountKeyHandle): IdentityCreateResult {
    val result = api.createIdentityHandle(accountKeyHandle.value)
    return try {
      val code = createCodeFor(result.code)
      val handle = if (code == IdentityCreateCode.SUCCESS && result.handle > 0) {
        IdentityHandle(result.handle)
      } else null
      val safeCode = if (code == IdentityCreateCode.SUCCESS && handle == null) {
        IdentityCreateCode.INTERNAL_ERROR
      } else code
      IdentityCreateResult(
        code = safeCode,
        handle = if (safeCode == IdentityCreateCode.SUCCESS) handle else null,
        signingPubkey = if (safeCode == IdentityCreateCode.SUCCESS) result.signingPubkey else EMPTY_BYTES,
        encryptionPubkey = if (safeCode == IdentityCreateCode.SUCCESS) result.encryptionPubkey else EMPTY_BYTES,
        wrappedSeed = if (safeCode == IdentityCreateCode.SUCCESS) result.wrappedSeed else EMPTY_BYTES,
      )
    } finally {
      result.wipe()
    }
  }

  override fun openIdentity(wrappedSeed: ByteArray, accountKeyHandle: AccountKeyHandle): IdentityOpenResult {
    val result = api.openIdentityHandle(wrappedSeed, accountKeyHandle.value)
    return try {
      val code = openCodeFor(result.code)
      val handle = if (code == IdentityOpenCode.SUCCESS && result.handle > 0) {
        IdentityHandle(result.handle)
      } else null
      val safeCode = if (code == IdentityOpenCode.SUCCESS && handle == null) {
        IdentityOpenCode.INTERNAL_ERROR
      } else code
      IdentityOpenResult(
        code = safeCode,
        handle = if (safeCode == IdentityOpenCode.SUCCESS) handle else null,
        signingPubkey = if (safeCode == IdentityOpenCode.SUCCESS) result.signingPubkey else EMPTY_BYTES,
        encryptionPubkey = if (safeCode == IdentityOpenCode.SUCCESS) result.encryptionPubkey else EMPTY_BYTES,
      )
    } finally {
      result.wipe()
    }
  }

  override fun signingPubkey(handle: IdentityHandle): IdentityPubkeyResult {
    val result = api.identitySigningPubkey(handle.value)
    return try {
      mapPubkeyResult(result)
    } finally {
      result.wipe()
    }
  }

  override fun encryptionPubkey(handle: IdentityHandle): IdentityPubkeyResult {
    val result = api.identityEncryptionPubkey(handle.value)
    return try {
      mapPubkeyResult(result)
    } finally {
      result.wipe()
    }
  }

  override fun signManifest(handle: IdentityHandle, transcriptBytes: ByteArray): ManifestSignatureResult {
    val result = api.signManifestWithIdentity(handle.value, transcriptBytes)
    return try {
      val code = when (result.code) {
        RustIdentityStableCode.OK -> IdentitySignCode.SUCCESS
        RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND -> IdentitySignCode.IDENTITY_HANDLE_NOT_FOUND
        RustIdentityStableCode.INVALID_INPUT_LENGTH,
        RustIdentityStableCode.INVALID_KEY_LENGTH,
        -> IdentitySignCode.INVALID_INPUT_LENGTH
        else -> IdentitySignCode.INTERNAL_ERROR
      }
      val signature = if (code == IdentitySignCode.SUCCESS) result.bytes else EMPTY_BYTES
      val safeCode = if (code == IdentitySignCode.SUCCESS && signature.isEmpty()) {
        IdentitySignCode.INTERNAL_ERROR
      } else code
      ManifestSignatureResult(safeCode, if (safeCode == IdentitySignCode.SUCCESS) signature else EMPTY_BYTES)
    } finally {
      result.wipe()
    }
  }

  override fun closeIdentity(handle: IdentityHandle): IdentityCloseCode = when (api.closeIdentityHandle(handle.value)) {
    RustIdentityStableCode.OK -> IdentityCloseCode.SUCCESS
    RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND,
    RustIdentityStableCode.SECRET_HANDLE_NOT_FOUND,
    -> IdentityCloseCode.NOT_FOUND
    else -> IdentityCloseCode.INTERNAL_ERROR
  }

  private fun mapPubkeyResult(result: RustBytesFfiResult): IdentityPubkeyResult {
    val code = when (result.code) {
      RustIdentityStableCode.OK -> IdentityPubkeyCode.SUCCESS
      RustIdentityStableCode.IDENTITY_HANDLE_NOT_FOUND -> IdentityPubkeyCode.IDENTITY_HANDLE_NOT_FOUND
      else -> IdentityPubkeyCode.INTERNAL_ERROR
    }
    val pubkey = if (code == IdentityPubkeyCode.SUCCESS) result.bytes else EMPTY_BYTES
    val safeCode = if (code == IdentityPubkeyCode.SUCCESS && pubkey.isEmpty()) {
      IdentityPubkeyCode.INTERNAL_ERROR
    } else code
    return IdentityPubkeyResult(safeCode, if (safeCode == IdentityPubkeyCode.SUCCESS) pubkey else EMPTY_BYTES)
  }

  private fun createCodeFor(code: Int): IdentityCreateCode = when (code) {
    RustIdentityStableCode.OK -> IdentityCreateCode.SUCCESS
    RustIdentityStableCode.SECRET_HANDLE_NOT_FOUND -> IdentityCreateCode.ACCOUNT_HANDLE_NOT_FOUND
    RustIdentityStableCode.HANDLE_SPACE_EXHAUSTED -> IdentityCreateCode.HANDLE_SPACE_EXHAUSTED
    else -> IdentityCreateCode.INTERNAL_ERROR
  }

  private fun openCodeFor(code: Int): IdentityOpenCode = when (code) {
    RustIdentityStableCode.OK -> IdentityOpenCode.SUCCESS
    RustIdentityStableCode.SECRET_HANDLE_NOT_FOUND -> IdentityOpenCode.ACCOUNT_HANDLE_NOT_FOUND
    RustIdentityStableCode.AUTHENTICATION_FAILED -> IdentityOpenCode.AUTHENTICATION_FAILED
    RustIdentityStableCode.INVALID_INPUT_LENGTH,
    RustIdentityStableCode.INVALID_KEY_LENGTH,
    -> IdentityOpenCode.INVALID_INPUT_LENGTH
    RustIdentityStableCode.HANDLE_SPACE_EXHAUSTED -> IdentityOpenCode.HANDLE_SPACE_EXHAUSTED
    else -> IdentityOpenCode.INTERNAL_ERROR
  }

  companion object {
    private val EMPTY_BYTES: ByteArray = ByteArray(0)
  }
}

/**
 * Opens an identity handle and wipes the caller-owned `wrappedSeed` (a wrapped
 * Ed25519+X25519 seed) after the bridge returns. Use this in any flow where
 * the caller will not need the wrapped seed bytes after the call.
 */
fun RustIdentityBridge.openIdentityWipingWrappedSeed(
  wrappedSeed: ByteArray,
  accountKeyHandle: AccountKeyHandle,
): IdentityOpenResult =
  try {
    openIdentity(wrappedSeed, accountKeyHandle)
  } finally {
    wrappedSeed.fill(0)
  }

/**
 * Signs a manifest transcript and wipes the caller-owned `transcriptBytes`
 * after the bridge returns. The transcript is a deterministic byte sequence
 * derived from the manifest contents; once signed, the caller usually only
 * needs the resulting signature, not the transcript.
 */
fun RustIdentityBridge.signManifestWipingTranscript(
  handle: IdentityHandle,
  transcriptBytes: ByteArray,
): ManifestSignatureResult =
  try {
    signManifest(handle, transcriptBytes)
  } finally {
    transcriptBytes.fill(0)
  }
