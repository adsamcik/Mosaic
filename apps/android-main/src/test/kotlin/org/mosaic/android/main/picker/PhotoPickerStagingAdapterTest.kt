package org.mosaic.android.main.picker

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.staging.StagedFile
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhotoPickerStagingAdapterTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val stagedFiles = mutableListOf<StagedFile>()
  private val unstagedFiles = mutableListOf<StagedFile>()

  @Before
  fun setUp() {
    MimeProvider.mimeTypes.clear()
    ShadowContentResolver.registerProviderInternal(AUTHORITY, MimeProvider())
  }

  @After
  fun tearDown() {
    stagedFiles.clear()
    unstagedFiles.clear()
    MimeProvider.mimeTypes.clear()
    File(context.filesDir, "picker-test").deleteRecursively()
  }

  @Test
  fun stagePickedItemsStagesThreeUrisWithOriginalMimeTypes() = runBlocking {
    val uris = listOf(uri("one"), uri("two"), uri("three"))
    MimeProvider.mimeTypes[uris[0].toString()] = "image/jpeg"
    MimeProvider.mimeTypes[uris[1].toString()] = "image/png"
    MimeProvider.mimeTypes[uris[2].toString()] = "image/heic"
    val adapter = adapter()

    val result = adapter.stagePickedItems(uris)

    assertEquals(3, result.size)
    assertEquals(listOf("image/jpeg", "image/png", "image/heic"), result.map { it.mimeType })
    assertEquals(uris.map { it.toString() }, stagedFiles.map { it.displayName })
  }

  @Test
  fun stagePickedItemsDefaultsUnknownMimeTypeToOctetStream() = runBlocking {
    val adapter = adapter()

    val result = adapter.stagePickedItems(listOf(uri("unknown")))

    assertEquals("application/octet-stream", result.single().mimeType)
  }

  @Test
  fun stagePickedItemsPropagatesFailureAndRollsBackPreviouslyStagedItems() = runBlocking {
    val uris = listOf(uri("one"), uri("fail"), uri("three"))
    val adapter = adapter(failOn = uris[1])

    val thrown = runCatching { adapter.stagePickedItems(uris) }.exceptionOrNull()

    assertTrue(thrown is IllegalStateException)
    assertEquals("staging failed", thrown?.message)
    assertEquals(1, stagedFiles.size)
    assertEquals(stagedFiles, unstagedFiles)
  }

  @Test
  fun stagePickedItemsStagesSameUriTwiceAsDistinctFiles() = runBlocking {
    val repeated = uri("same")
    MimeProvider.mimeTypes[repeated.toString()] = "image/webp"
    val adapter = adapter()

    val result = adapter.stagePickedItems(listOf(repeated, repeated))

    assertEquals(2, result.size)
    assertNotEquals(result[0].stagedFile.id, result[1].stagedFile.id)
    assertEquals(listOf("image/webp", "image/webp"), result.map { it.mimeType })
  }

  private fun adapter(failOn: Uri? = null): PhotoPickerStagingAdapter = PhotoPickerStagingAdapter(
    stageUri = { source ->
      if (source == failOn) error("staging failed")
      stagedFile(source).also { stagedFiles += it }
    },
    unstageFile = { staged -> unstagedFiles += staged },
    contentResolver = context.contentResolver,
    ioDispatcher = Dispatchers.Unconfined,
  )

  private fun stagedFile(source: Uri): StagedFile {
    val index = stagedFiles.size + 1
    val directory = File(context.filesDir, "picker-test").also { it.mkdirs() }
    val file = File(directory, "staged-$index.blob").apply { writeText("staged-$index") }
    return StagedFile(
      id = "staged-$index",
      uri = Uri.Builder().scheme("mosaic-staged").authority("staged-$index").build(),
      file = file,
      displayName = source.toString(),
      sizeBytes = file.length(),
      createdAtMs = index.toLong(),
      lastAccessMs = index.toLong(),
    )
  }

  private fun uri(path: String): Uri = Uri.parse("content://$AUTHORITY/$path")

  class MimeProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String? = mimeTypes[uri.toString()]

    override fun query(
      uri: Uri,
      projection: Array<out String>?,
      selection: String?,
      selectionArgs: Array<out String>?,
      sortOrder: String?,
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
      uri: Uri,
      values: ContentValues?,
      selection: String?,
      selectionArgs: Array<out String>?,
    ): Int = 0

    companion object {
      val mimeTypes: MutableMap<String, String> = mutableMapOf()
    }
  }

  private companion object {
    const val AUTHORITY = "org.mosaic.android.main.picker.test"
  }
}
