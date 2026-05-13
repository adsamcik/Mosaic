package org.mosaic.android.main.crypto

import org.mosaic.android.foundation.AccountKeyHandle
import org.mosaic.android.foundation.EpochKeyHandle
import org.mosaic.android.foundation.EpochOpenCode
import org.mosaic.android.foundation.GeneratedRustEpochBridge
import org.mosaic.android.foundation.RustEpochBridge
import org.mosaic.android.foundation.openEpochWipingWrappedSeed
import org.mosaic.android.main.bridge.AndroidRustEpochApi
import org.mosaic.android.main.db.AlbumEpochKeyDao

internal interface EpochHandleResolver {
  fun openEpochHandle(albumId: String, epochId: Int): OpenedEpochHandle?
}

internal class OpenedEpochHandle(
  val id: Long,
  private val closeHandle: () -> Unit,
) : AutoCloseable {
  override fun close() = closeHandle()
}

internal interface ActiveAccountHandleProvider {
  fun currentAccountKeyHandle(): AccountKeyHandle?
}

internal object ProcessActiveAccountHandleProvider : ActiveAccountHandleProvider {
  @Volatile
  private var accountKeyHandle: AccountKeyHandle? = null

  override fun currentAccountKeyHandle(): AccountKeyHandle? = accountKeyHandle

  fun setCurrentAccountKeyHandle(handle: AccountKeyHandle) {
    accountKeyHandle = handle
  }

  fun clear() {
    accountKeyHandle = null
  }
}

internal class RoomEpochHandleResolver(
  private val epochKeyDao: AlbumEpochKeyDao,
  private val accountHandleProvider: ActiveAccountHandleProvider = ProcessActiveAccountHandleProvider,
  private val epochBridge: RustEpochBridge = GeneratedRustEpochBridge(AndroidRustEpochApi()),
) : EpochHandleResolver {
  override fun openEpochHandle(albumId: String, epochId: Int): OpenedEpochHandle? {
    val accountHandle = accountHandleProvider.currentAccountKeyHandle() ?: return null
    val wrappedEpochSeed = epochKeyDao.get(albumId, epochId)?.wrappedEpochSeed ?: return null
    val opened = epochBridge.openEpochWipingWrappedSeed(wrappedEpochSeed, accountHandle, epochId)
    if (opened.code != EpochOpenCode.SUCCESS) return null
    val handle = opened.handle ?: return null
    return OpenedEpochHandle(handle.idAsLong()) {
      epochBridge.closeEpoch(handle)
    }
  }
}

private fun EpochKeyHandle.idAsLong(): Long = value.toLong()
