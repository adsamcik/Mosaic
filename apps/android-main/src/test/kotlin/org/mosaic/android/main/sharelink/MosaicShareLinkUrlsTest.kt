package org.mosaic.android.main.sharelink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MosaicShareLinkUrlsTest {
  @Test
  fun delegatesUrlAssemblyToRustAssembler() {
    val calls = mutableListOf<List<String>>()
    val urls = MosaicShareLinkUrls(
      assembler = object : ShareLinkUrlAssembler {
        override fun buildShareLinkUrl(
          baseUrl: String,
          albumId: String,
          linkId: String,
          linkUrlToken: String,
        ): String {
          calls += listOf(baseUrl, albumId, linkId, linkUrlToken)
          return "$baseUrl/s/$linkId#k=$linkUrlToken"
        }
      },
    )

    val url = urls.build(
      baseUrl = "https://photos.example",
      albumId = "018f0000-0000-7000-8000-000000000002",
      linkId = "encoded-link-id",
      linkUrlToken = "encoded-token",
    )

    assertEquals("https://photos.example/s/encoded-link-id#k=encoded-token", url)
    assertEquals(
      listOf(listOf("https://photos.example", "018f0000-0000-7000-8000-000000000002", "encoded-link-id", "encoded-token")),
      calls,
    )
  }

  @Test
  fun rejectsBlankRustResult() {
    val urls = MosaicShareLinkUrls(
      assembler = object : ShareLinkUrlAssembler {
        override fun buildShareLinkUrl(
          baseUrl: String,
          albumId: String,
          linkId: String,
          linkUrlToken: String,
        ): String = ""
      },
    )

    assertThrows(IllegalArgumentException::class.java) {
      urls.build(
        baseUrl = "https://photos.example",
        albumId = "018f0000-0000-7000-8000-000000000002",
        linkId = "encoded-link-id",
        linkUrlToken = "encoded-token",
      )
    }
  }
}
