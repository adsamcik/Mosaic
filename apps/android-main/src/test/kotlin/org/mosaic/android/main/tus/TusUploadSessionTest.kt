package org.mosaic.android.main.tus

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.staging.AppPrivateStagingManager
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
    val client = TusClientFactory.create(server.url("/files"), OkHttpClient())
    val session = TusUploadSession(client, stagingManager, chunkSizeBytes = 16)

    val manifest = session.upload(staged, mapOf("filename" to "shard.bin"))

    assertEquals(server.url("/uploads/shard-1").toString(), manifest.uploadUrl)
    assertEquals(6L, manifest.uploadedBytes)
    assertEquals(64, manifest.sha256.length)
    val post = server.takeRequest()
    assertEquals("POST", post.method)
    assertEquals("6", post.getHeader("Upload-Length"))
    assertTrue(post.getHeader("Upload-Metadata")!!.startsWith("filename "))
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

  private fun stageBytes(value: String) = stagingManager.stage(
    Uri.fromFile(File(context.filesDir, "upload.txt").apply { writeText(value) }),
  )
}

