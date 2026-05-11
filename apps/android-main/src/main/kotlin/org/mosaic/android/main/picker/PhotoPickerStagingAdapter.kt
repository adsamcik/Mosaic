package org.mosaic.android.main.picker

import android.content.ContentResolver
import android.net.Uri
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.upload.RustContentHasher

class PhotoPickerStagingAdapter internal constructor(
  private val stageUri: (Uri) -> StagedFile,
  private val unstageFile: (StagedFile) -> Unit,
  private val contentResolver: ContentResolver,
  private val ioDispatcher: CoroutineDispatcher,
  private val albumContentHashFor: (Uri) -> String,
) {
  constructor(
    staging: AppPrivateStagingManager,
    contentResolver: ContentResolver,
  ) : this(
    stageUri = staging::stage,
    unstageFile = staging::unstage,
    contentResolver = contentResolver,
    ioDispatcher = Dispatchers.IO,
    albumContentHashFor = { sourceUri -> computeAlbumContentHash(contentResolver, sourceUri) },
  )

  suspend fun stagePickedItems(
    uris: List<Uri>,
  ): List<StagedItem> = withContext(ioDispatcher) {
    val stagedItems = mutableListOf<StagedItem>()

    try {
      uris.map { uri ->
        val mimeType = contentResolver.getType(uri) ?: DEFAULT_MIME_TYPE
        val albumContentHashHex = albumContentHashFor(uri)
        val stagedItem = StagedItem(
          stagedFile = stageUri(uri),
          mimeType = mimeType,
          albumContentHashHex = albumContentHashHex,
        )
        stagedItems += stagedItem
        stagedItem
      }
    } catch (failure: Throwable) {
      stagedItems.forEach { item ->
        runCatching { unstageFile(item.stagedFile) }
          .onFailure { rollbackFailure -> failure.addSuppressed(rollbackFailure) }
      }
      throw failure
    }
  }

  private companion object {
    const val DEFAULT_MIME_TYPE = "application/octet-stream"

    fun computeAlbumContentHash(contentResolver: ContentResolver, sourceUri: Uri): String {
      val sourceBytes = contentResolver.openInputStream(sourceUri).use { input ->
        requireNotNull(input) { "Unable to open source URI for content hashing" }
        input.readBytes()
      }
      return RustContentHasher.sha256Hex(sourceBytes)
    }
  }
}

data class StagedItem(
  val stagedFile: StagedFile,
  val mimeType: String,
  val albumContentHashHex: String,
)
