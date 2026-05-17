package org.mosaic.android.main.crypto

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.net.dto.AlbumId
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Verifies the v1.0.1 per-album envelope subdirectory layout: every envelope
 * is keyed by album so AlbumPurger.purgeRemoteAlbumDeletion can drop an
 * album's envelope set without scanning every file or relying on a DB index.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShardEnvelopeStoreTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val envelopeRoot = File(context.filesDir, "encrypted-shards")

  @After
  fun tearDown() {
    envelopeRoot.deleteRecursively()
    File(context.filesDir, "envelope-store-staging").deleteRecursively()
  }

  @Test
  fun persistEnvelopeWritesUnderAlbumSubdirectory() {
    val store = ShardEnvelopeStore(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val input = envelopeInput(albumA, stagingFor("alpha"))

    val persisted = store.persistEnvelope(input, envelope = byteArrayOf(1, 2, 3, 4))

    val persistedFile = File(requireNotNull(android.net.Uri.parse(persisted.uri).path))
    assertTrue("envelope file must exist on disk", persistedFile.exists())
    assertEquals(File(envelopeRoot, albumA), persistedFile.parentFile)
    assertTrue(persistedFile.name.endsWith(".envelope"))
  }

  @Test
  fun existingEnvelopeUriReturnsHitForSameAlbumAndMissForOtherAlbum() {
    val store = ShardEnvelopeStore(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val albumB = "018f9f8d-99df-7b42-8f0d-bbbbbbbbbbbb"
    val stagingUri = stagingFor("beta")
    val inputA = envelopeInput(albumA, stagingUri)
    val inputB = envelopeInput(albumB, stagingUri)

    store.persistEnvelope(inputA, envelope = byteArrayOf(10, 20, 30))

    assertNotNull("write to album A is readable as album A", store.existingEnvelopeUri(inputA))
    assertNull("write to album A must not satisfy a read scoped to album B", store.existingEnvelopeUri(inputB))
  }

  @Test
  fun deleteForAlbumPurgesOnlyTargetAlbumAndReturnsFileCount() {
    val store = ShardEnvelopeStore(context)
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val albumB = "018f9f8d-99df-7b42-8f0d-bbbbbbbbbbbb"
    // Two distinct envelopes under album A (different shardIndex), one under album B.
    store.persistEnvelope(envelopeInput(albumA, stagingFor("a-shard-0"), shardIndex = 0), byteArrayOf(1))
    store.persistEnvelope(envelopeInput(albumA, stagingFor("a-shard-1"), shardIndex = 1), byteArrayOf(2))
    store.persistEnvelope(envelopeInput(albumB, stagingFor("b-shard-0"), shardIndex = 0), byteArrayOf(3))

    val purged = store.deleteForAlbum(AlbumId(albumA))

    assertEquals(2, purged)
    assertFalse("album A directory must be gone", File(envelopeRoot, albumA).exists())
    assertTrue("album B envelopes must survive", File(envelopeRoot, albumB).exists())
  }

  @Test
  fun deleteForAlbumOnUnknownAlbumReturnsZero() {
    val store = ShardEnvelopeStore(context)
    val unknown = AlbumId("018f9f8d-99df-7b42-8f0d-cccccccccccc")

    assertEquals(0, store.deleteForAlbum(unknown))
  }

  private fun envelopeInput(
    albumId: String,
    stagingUri: String,
    shardIndex: Int = 0,
  ): ShardEnvelopeInput = ShardEnvelopeInput(
    stagingUri = stagingUri,
    albumId = albumId,
    epochId = 1,
    tier = 3,
    shardIndex = shardIndex,
    plaintextSha256Hex = "0".repeat(64),
  )

  private fun stagingFor(name: String): String {
    val dir = File(context.filesDir, "envelope-store-staging").also { it.mkdirs() }
    val file = File(dir, "$name.bin")
    if (!file.exists()) file.writeText(name)
    return android.net.Uri.fromFile(file).toString()
  }
}
