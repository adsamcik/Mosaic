package org.mosaic.android.main.staging

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.time.Instant
import java.util.Properties
import java.util.UUID

private const val STAGING_SCHEME = "mosaic-staged"
private const val DATA_EXTENSION = ".blob"
private const val META_EXTENSION = ".properties"

/**
 * Copies SAF grants into app-private staging files under filesDir/staging.
 *
 * Staging bytes are intentionally not encrypted a second time by Mosaic. Android
 * app-private storage is protected by platform filesystem encryption (AES-based
 * file-based encryption by default since Android 7.0), survives reboot, and is
 * removed at app uninstall. The later A8 encryption worker consumes staged bytes
 * and produces Mosaic encrypted shards before network upload.
 */
class AppPrivateStagingManager(
  private val context: Context,
  private val clock: () -> Long = { System.currentTimeMillis() },
) {
  private val stagingDir: File
    get() = File(context.filesDir, "staging").also { directory -> directory.mkdirs() }

  fun stage(sourceUri: Uri): StagedFile {
    val id = UUID.randomUUID().toString()
    val dataFile = dataFile(id)
    val now = clock()
    val displayName = displayName(sourceUri)

    context.contentResolver.openInputStream(sourceUri).use { input ->
      requireNotNull(input) { "Unable to open source URI for staging" }
      dataFile.outputStream().use { output -> input.copyTo(output) }
    }

    val staged = StagedFile(
      id = id,
      uri = Uri.Builder().scheme(STAGING_SCHEME).authority(id).build(),
      file = dataFile,
      displayName = displayName,
      sizeBytes = dataFile.length(),
      createdAtMs = now,
      lastAccessMs = now,
    )
    writeMetadata(staged, Properties())
    return staged
  }

  fun unstage(staged: StagedFile) {
    staged.file.delete()
    metadataFile(staged.id).delete()
  }

  fun cleanup(maxAgeMs: Long): Int {
    require(maxAgeMs >= 0) { "maxAgeMs must not be negative" }
    val cutoff = clock() - maxAgeMs
    var deleted = 0
    stagingDir.listFiles().orEmpty()
      .filter { file -> file.isFile && file.extension == "blob" }
      .forEach { file ->
        val id = file.name.removeSuffix(DATA_EXTENSION)
        val props = readRawMetadata(id)
        val lastAccess = props.getProperty("lastAccessMs")?.toLongOrNull() ?: file.lastModified()
        if (lastAccess <= cutoff) {
          if (file.delete()) deleted++
          metadataFile(id).delete()
        }
      }
    recordCleanup(clock())
    return deleted
  }

  fun listStagedFiles(): List<StagedFile> =
    stagingDir.listFiles().orEmpty()
      .filter { file -> file.isFile && file.extension == "blob" }
      .map { file ->
        val id = file.name.removeSuffix(DATA_EXTENSION)
        val props = readRawMetadata(id)
        StagedFile(
          id = id,
          uri = props.getProperty("uri")?.let(Uri::parse) ?: Uri.Builder().scheme(STAGING_SCHEME).authority(id).build(),
          file = file,
          displayName = props.getProperty("displayName")?.takeIf { it.isNotBlank() },
          sizeBytes = props.getProperty("sizeBytes")?.toLongOrNull() ?: file.length(),
          createdAtMs = props.getProperty("createdAtMs")?.toLongOrNull() ?: file.lastModified(),
          lastAccessMs = props.getProperty("lastAccessMs")?.toLongOrNull() ?: file.lastModified(),
        )
      }
      .sortedBy { staged -> staged.createdAtMs }

  fun lastCleanupAt(): Instant? {
    val value = context.getSharedPreferences(CLEANUP_PREFS_NAME, Context.MODE_PRIVATE)
      .getLong(LAST_CLEANUP_AT_MS_KEY, Long.MIN_VALUE)
    return if (value == Long.MIN_VALUE) null else Instant.ofEpochMilli(value)
  }

  fun resolveAsContentResolver(staged: StagedFile): ContentResolver {
    require(staged.uri.scheme == STAGING_SCHEME) { "not a Mosaic staged URI" }
    require(staged.file.canonicalFile.parentFile == stagingDir.canonicalFile) { "staged file outside staging dir" }
    touch(staged)
    return context.contentResolver
  }

  fun openInputStream(staged: StagedFile): InputStream {
    require(staged.file.exists()) { "staged file no longer exists" }
    touch(staged)
    return FileInputStream(staged.file)
  }

  fun readUploadState(staged: StagedFile): StagedUploadState {
    val props = readRawMetadata(staged.id)
    return StagedUploadState(
      uploadUrl = props.getProperty("uploadUrl")?.takeIf { it.isNotBlank() },
      offset = props.getProperty("offset")?.toLongOrNull() ?: 0L,
      finalized = props.getProperty("finalized") == "true",
    )
  }

  fun writeUploadState(staged: StagedFile, state: StagedUploadState) {
    val props = readRawMetadata(staged.id)
    if (state.uploadUrl == null) props.remove("uploadUrl") else props.setProperty("uploadUrl", state.uploadUrl)
    props.setProperty("offset", state.offset.toString())
    props.setProperty("finalized", state.finalized.toString())
    writeMetadata(staged.copy(lastAccessMs = clock()), props)
  }

  private fun touch(staged: StagedFile) {
    val props = readRawMetadata(staged.id)
    props.setProperty("lastAccessMs", clock().toString())
    writeMetadata(staged.copy(lastAccessMs = clock()), props)
  }

  private fun writeMetadata(staged: StagedFile, extra: Properties) {
    val props = Properties()
    props.putAll(extra)
    props.setProperty("id", staged.id)
    props.setProperty("uri", staged.uri.toString())
    props.setProperty("fileName", staged.file.name)
    props.setProperty("displayName", staged.displayName.orEmpty())
    props.setProperty("sizeBytes", staged.sizeBytes.toString())
    props.setProperty("createdAtMs", staged.createdAtMs.toString())
    props.setProperty("lastAccessMs", staged.lastAccessMs.toString())
    metadataFile(staged.id).outputStream().use { output -> props.store(output, "mosaic staged file") }
  }

  private fun readRawMetadata(id: String): Properties {
    val props = Properties()
    val file = metadataFile(id)
    if (file.exists()) file.inputStream().use { input -> props.load(input) }
    return props
  }

  private fun displayName(uri: Uri): String? {
    if (uri.scheme == ContentResolver.SCHEME_FILE) return uri.lastPathSegment
    return context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    }
  }

  private fun dataFile(id: String): File = File(stagingDir, "$id$DATA_EXTENSION")

  private fun metadataFile(id: String): File = File(stagingDir, "$id$META_EXTENSION")

  private fun recordCleanup(cleanupAtMs: Long) {
    context.getSharedPreferences(CLEANUP_PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putLong(LAST_CLEANUP_AT_MS_KEY, cleanupAtMs)
      .apply()
  }

  private companion object {
    const val CLEANUP_PREFS_NAME: String = "mosaic_staging_privacy"
    const val LAST_CLEANUP_AT_MS_KEY: String = "last_cleanup_at_ms"
  }
}

data class StagedFile(
  val id: String,
  val uri: Uri,
  val file: File,
  val displayName: String?,
  val sizeBytes: Long,
  val createdAtMs: Long,
  val lastAccessMs: Long,
)

data class StagedUploadState(
  val uploadUrl: String?,
  val offset: Long,
  val finalized: Boolean,
)
