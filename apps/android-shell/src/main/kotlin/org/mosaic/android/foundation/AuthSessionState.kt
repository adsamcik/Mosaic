package org.mosaic.android.foundation

@JvmInline
value class ServerAccountId(val value: String) {
  init {
    require(value.isNotBlank()) { "server account id is required" }
  }
}

@JvmInline
value class AccountKeyHandle(val value: Long) {
  init {
    require(value > 0) { "account key handle must be positive" }
  }

  override fun toString(): String = "AccountKeyHandle(<redacted>)"
}

sealed interface ServerAuthState {
  data object SignedOut : ServerAuthState
  data class Authenticated(val accountId: ServerAccountId) : ServerAuthState
}

sealed interface CryptoUnlockState {
  data object Locked : CryptoUnlockState
  data class Unlocked(
    val accountKeyHandle: AccountKeyHandle,
    val protocolVersion: String,
  ) : CryptoUnlockState {
    init {
      require(protocolVersion.isNotBlank()) { "protocol version is required" }
    }

    override fun toString(): String =
      "Unlocked(accountKeyHandle=<redacted>, protocolVersion=$protocolVersion)"
  }
}

data class ShellSessionState(
  val serverAuthState: ServerAuthState,
  val cryptoUnlockState: CryptoUnlockState,
) {
  val isServerAuthenticated: Boolean
    get() = serverAuthState is ServerAuthState.Authenticated

  val isCryptoUnlocked: Boolean
    get() = cryptoUnlockState is CryptoUnlockState.Unlocked

  val canQueueUploads: Boolean
    get() = isServerAuthenticated && isCryptoUnlocked

  fun withServerAuthenticated(accountId: ServerAccountId): ShellSessionState = copy(
    serverAuthState = ServerAuthState.Authenticated(accountId),
  )

  fun withServerSignedOut(): ShellSessionState = ShellSessionState(
    serverAuthState = ServerAuthState.SignedOut,
    cryptoUnlockState = CryptoUnlockState.Locked,
  )

  fun withCryptoUnlocked(handle: AccountKeyHandle, protocolVersion: String): ShellSessionState {
    require(isServerAuthenticated) { "server authentication must be established before crypto unlock" }
    return copy(
      cryptoUnlockState = CryptoUnlockState.Unlocked(
        accountKeyHandle = handle,
        protocolVersion = protocolVersion,
      ),
    )
  }

  fun withCryptoLocked(): ShellSessionState = copy(cryptoUnlockState = CryptoUnlockState.Locked)

  override fun toString(): String =
    "ShellSessionState(serverAuthState=$serverAuthState, cryptoUnlockState=$cryptoUnlockState)"

  companion object {
    fun initial(): ShellSessionState = ShellSessionState(
      serverAuthState = ServerAuthState.SignedOut,
      cryptoUnlockState = CryptoUnlockState.Locked,
    )
  }
}
