package org.mosaic.android.main.picker

import android.content.ContentResolver
import android.net.Uri
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import java.security.MessageDigest

class PhotoPickerStagingAdapter internal constructor(
  private val stageUri: (Uri) -> StagedFile,
  private val unstageFile: (StagedFile) -> Unit,
  private val contentResolver: ContentResolver,
  private val ioDispatcher: CoroutineDispatcher,
  private val albumContentHashFor: (StagedFile) -> String,
) {
  constructor(
    staging: AppPrivateStagingManager,
    contentResolver: ContentResolver,
  ) : this(
    stageUri = staging::stage,
    unstageFile = staging::unstage,
    contentResolver = contentResolver,
    ioDispatcher = Dispatchers.IO,
    albumContentHashFor = { staged -> computeAlbumContentHash(staged) },
  )

  suspend fun stagePickedItems(
    uris: List<Uri>,
  ): List<StagedItem> = withContext(ioDispatcher) {
    val stagedItems = mutableListOf<StagedItem>()

    try {
      uris.map { uri ->
        val mimeType = contentResolver.getType(uri) ?: DEFAULT_MIME_TYPE
        val stagedFile = stageUri(uri)
        try {
          val albumContentHashHex = albumContentHashFor(stagedFile)
          val stagedItem = StagedItem(
            stagedFile = stagedFile,
            mimeType = mimeType,
            albumContentHashHex = albumContentHashHex,
          )
          stagedItems += stagedItem
          stagedItem
        } catch (failure: Throwable) {
          runCatching { unstageFile(stagedFile) }
            .onFailure { rollbackFailure -> failure.addSuppressed(rollbackFailure) }
          throw failure
        }
      }
    } catch (failure: Throwable) {
      stagedItems.forEach { item ->
        runCatching { unstageFile(item.stagedFile) }
          .onFailure { rollbackFailure -> failure.addSuppressed(rollbackFailure) }
      }
      throw failure
    }
  }

  internal companion object {
    const val DEFAULT_MIME_TYPE = "application/octet-stream"
    private const val HASH_BUFFER_BYTES = 1024 * 1024

    fun computeAlbumContentHash(stagedFile: StagedFile): String {
      val digest = MessageDigest.getInstance("SHA-256")
      stagedFile.file.inputStream().buffered().use { input ->
        val buffer = ByteArray(HASH_BUFFER_BYTES)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (read > 0) digest.update(buffer, 0, read)
        }
      }
      return digest.digest().toHex()
    }

    private fun ByteArray.toHex(): String = joinToString(separator = "") { byte -> "%02x".format(byte) }
  }
}

data class StagedItem(
  val stagedFile: StagedFile,
  val mimeType: String,
  val albumContentHashHex: String,
)
