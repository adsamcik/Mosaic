package org.mosaic.android.main.staging

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppPrivateStagingManagerTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private var now = 1_000L
  private val manager = AppPrivateStagingManager(context) { now }

  @After
  fun tearDown() {
    File(context.filesDir, "staging").deleteRecursively()
  }

  @Test
  fun stageCopiesSafUriIntoAppPrivateStableUri() {
    val source = File(context.filesDir, "source.txt").apply { writeText("mosaic-staged-bytes") }

    val staged = manager.stage(Uri.fromFile(source))

    assertEquals("mosaic-staged", staged.uri.scheme)
    assertEquals("mosaic-staged-bytes", staged.file.readText())
    assertTrue(staged.file.path.contains("staging"))
    assertNotNull(manager.resolveAsContentResolver(staged))
    manager.openInputStream(staged).use { input ->
      assertEquals("mosaic-staged-bytes", input.readBytes().toString(Charsets.UTF_8))
    }
  }

  @Test
  fun cleanupEvictsFilesOlderThanMaxAge() {
    val oldSource = File(context.filesDir, "old.txt").apply { writeText("old") }
    val old = manager.stage(Uri.fromFile(oldSource))
    now += 10_000L
    val freshSource = File(context.filesDir, "fresh.txt").apply { writeText("fresh") }
    val fresh = manager.stage(Uri.fromFile(freshSource))

    val deleted = manager.cleanup(maxAgeMs = 5_000L)

    assertEquals(1, deleted)
    assertFalse(old.file.exists())
    assertTrue(fresh.file.exists())
  }

  @Test
  fun unstageDeletesDataAndMetadata() {
    val source = File(context.filesDir, "delete.txt").apply { writeText("delete") }
    val staged = manager.stage(Uri.fromFile(source))

    manager.unstage(staged)

    assertFalse(staged.file.exists())
    assertFalse(File(context.filesDir, "staging/${staged.id}.properties").exists())
  }
}

