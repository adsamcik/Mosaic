package org.mosaic.android.main.tus

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Base64
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.net.dto.ShardId
import org.mosaic.android.main.net.dto.UploadJobId
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.staging.StagedUploadState
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TusUploadSessionTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val stagingManager = AppPrivateStagingManager(context)
  private val server = MockWebServer()

  @After
  fun tearDown() {
    server.shutdown()
    File(context.filesDir, "staging").deleteRecursively()
  }

  @Test
  fun uploadPerformsInitPatchAndFinalizesManifestEntry() {
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/shard-1"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "6"))
    server.start()
    val staged = stageBytes("abcdef")
    val expectedSha256 = sha256Hex("abcdef".toByteArray(Charsets.UTF_8))
    val client = TusClientFactory.create(server.url("/files"), OkHttpClient())
    val session = TusUploadSession(client, stagingManager, chunkSizeBytes = 16)

    val manifest = session.upload(staged, mapOf("filename" to "shard.bin", "content-sha256" to expectedSha256))

    assertEquals(server.url("/uploads/shard-1").toString(), manifest.uploadUrl)
    assertEquals(6L, manifest.uploadedBytes)
    assertEquals(expectedSha256, manifest.sha256)
    val post = server.takeRequest()
    assertEquals("POST", post.method)
    assertEquals("6", post.getHeader("Upload-Length"))
    val metadata = parseTusMetadata(post.getHeader("Upload-Metadata")!!)
    assertEquals("shard.bin", metadata["filename"])
    assertEquals(expectedSha256, metadata["content-sha256"])
    val patch = server.takeRequest()
    assertEquals("PATCH", patch.method)
    assertEquals("0", patch.getHeader("Upload-Offset"))
    assertEquals("abcdef", patch.body.readUtf8())
    assertTrue(stagingManager.readUploadState(staged).finalized)
  }

  @Test
  fun uploadResumesFromPersistedOffsetAfterProcessDeath() {
    server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", "3"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "6"))
    server.start()
    val staged = stageBytes("abcdef")
    val uploadUrl = server.url("/uploads/resume").toString()
    stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl, offset = 3L, finalized = false))
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 16)

    val manifest = session.upload(staged)

    assertEquals(6L, manifest.uploadedBytes)
    assertEquals("HEAD", server.takeRequest().method)
    val patch = server.takeRequest()
    assertEquals("PATCH", patch.method)
    assertEquals("3", patch.getHeader("Upload-Offset"))
    assertEquals("def", patch.body.readUtf8())
  }

  @Test
  fun largeFileOverflow_doesNotTruncate() {
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/large"))
    server.enqueue(MockResponse().setResponseCode(500))
    server.enqueue(MockResponse().setResponseCode(500))
    server.start()
    val staged = stageSparseFile("large-overflow", 4L * 1024L * 1024L * 1024L)
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 1024)

    assertThrows(TusUploadException.HeadFailed::class.java) {
      session.upload(staged)
    }

    assertEquals("POST", server.takeRequest().method)
    val patch = server.takeRequest()
    assertEquals("PATCH", patch.method)
    assertEquals("0", patch.getHeader("Upload-Offset"))
    assertEquals(1024L, patch.body.size)
  }

  @Test
  fun streamingSha256_doesNotAllocateFullFile() {
    val fileSize = 500L * 1024L * 1024L
    server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", fileSize.toString()))
    server.start()
    val staged = stageSparseFile("streaming-sha", fileSize)
    val uploadUrl = server.url("/uploads/already-complete").toString()
    stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl, offset = fileSize, finalized = false))
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 8192)
    System.gc()
    val usedBefore = usedHeapBytes()

    val manifest = session.upload(staged)

    System.gc()
    val usedAfter = usedHeapBytes()
    assertEquals(fileSize, manifest.uploadedBytes)
    assertEquals(zeroSha256Hex(fileSize), manifest.sha256)
    assertTrue("SHA-256 should be streamed with bounded retained heap", usedAfter - usedBefore < 64L * 1024L * 1024L)
    assertEquals("HEAD", server.takeRequest().method)
  }

  @Test
  fun patchRetry_resyncsOffsetOn409() {
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/resync"))
    server.enqueue(MockResponse().setResponseCode(502))
    server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", "3"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "6"))
    server.start()
    val staged = stageBytes("abcdef")
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 6)

    val manifest = session.upload(staged)

    assertEquals(6L, manifest.uploadedBytes)
    assertEquals("POST", server.takeRequest().method)
    val firstPatch = server.takeRequest()
    assertEquals("PATCH", firstPatch.method)
    assertEquals("0", firstPatch.getHeader("Upload-Offset"))
    assertEquals("abcdef", firstPatch.body.readUtf8())
    assertEquals("HEAD", server.takeRequest().method)
    val secondPatch = server.takeRequest()
    assertEquals("PATCH", secondPatch.method)
    assertEquals("3", secondPatch.getHeader("Upload-Offset"))
    assertEquals("def", secondPatch.body.readUtf8())
  }

  @Test
  fun patchIncludesIdempotencyKey() {
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/idempotent"))
    server.enqueue(MockResponse().setResponseCode(502))
    server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", "0"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "6"))
    server.start()
    val staged = stageBytes("abcdef")
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 6)
    val jobId = UploadJobId("018f9f8d-99df-7b42-8f0d-333333333333")
    val shardId = ShardId("018f9f8d-99df-7b42-8f0d-444444444444")

    session.upload(staged, uploadJobId = jobId, shardId = shardId)

    assertEquals("POST", server.takeRequest().method)
    val firstPatch = server.takeRequest()
    assertEquals("PATCH", firstPatch.method)
    assertEquals("HEAD", server.takeRequest().method)
    val retryPatch = server.takeRequest()
    assertEquals("PATCH", retryPatch.method)
    val firstKey = firstPatch.getHeader("Idempotency-Key")
    assertTrue("PATCH idempotency key must be present", !firstKey.isNullOrBlank())
    assertEquals(firstKey, retryPatch.getHeader("Idempotency-Key"))
  }

  @Test
  fun headFailure_404_resetsUploadFromZero() {
    server.enqueue(MockResponse().setResponseCode(404))
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/recreated"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "6"))
    server.start()
    val staged = stageBytes("abcdef")
    stagingManager.writeUploadState(staged, StagedUploadState(server.url("/uploads/reaped").toString(), offset = 3L, finalized = false))
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 16)

    val manifest = session.upload(staged)

    assertEquals(server.url("/uploads/recreated").toString(), manifest.uploadUrl)
    assertEquals(6L, manifest.uploadedBytes)
    assertEquals("HEAD", server.takeRequest().method)
    assertEquals("POST", server.takeRequest().method)
    val patch = server.takeRequest()
    assertEquals("PATCH", patch.method)
    assertEquals("0", patch.getHeader("Upload-Offset"))
    assertEquals("abcdef", patch.body.readUtf8())
    assertEquals(server.url("/uploads/recreated").toString(), stagingManager.readUploadState(staged).uploadUrl)
  }

  @Test
  fun headFailure_500_abortsWithTypedError() {
    server.enqueue(MockResponse().setResponseCode(500))
    server.start()
    val staged = stageBytes("abcdef")
    stagingManager.writeUploadState(staged, StagedUploadState(server.url("/uploads/transient-error").toString(), offset = 3L, finalized = false))
    val session = TusUploadSession(TusClientFactory.create(server.url("/files"), OkHttpClient()), stagingManager, chunkSizeBytes = 16)

    val exception = assertThrows(TusUploadException.HeadFailed::class.java) {
      session.upload(staged)
    }

    assertEquals(500, exception.statusCode)
    assertEquals("HEAD", server.takeRequest().method)
  }

  private fun stageBytes(value: String) = stagingManager.stage(
    Uri.fromFile(File(context.filesDir, "upload.txt").apply { writeText(value) }),
  )

  private fun stageSparseFile(id: String, sizeBytes: Long): StagedFile {
    val file = File(context.filesDir, "$id.bin")
    RandomAccessFile(file, "rw").use { randomAccessFile -> randomAccessFile.setLength(sizeBytes) }
    return StagedFile(
      id = id,
      uri = Uri.fromFile(file),
      file = file,
      displayName = file.name,
      sizeBytes = sizeBytes,
      createdAtMs = 0L,
      lastAccessMs = 0L,
    )
  }

  private fun zeroSha256Hex(sizeBytes: Long): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val zeros = ByteArray(8192)
    var remaining = sizeBytes
    while (remaining > 0L) {
      val bytes = minOf(zeros.size.toLong(), remaining).toInt()
      digest.update(zeros, 0, bytes)
      remaining -= bytes
    }
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
  }

  private fun usedHeapBytes(): Long {
    val runtime = Runtime.getRuntime()
    return runtime.totalMemory() - runtime.freeMemory()
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun parseTusMetadata(header: String): Map<String, String> = header.split(",").associate { item ->
    val parts = item.split(" ", limit = 2)
    parts[0] to String(Base64.getDecoder().decode(parts[1]), Charsets.UTF_8)
  }
}
