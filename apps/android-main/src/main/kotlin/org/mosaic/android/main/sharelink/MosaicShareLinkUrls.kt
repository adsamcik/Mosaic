package org.mosaic.android.main.sharelink

import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import uniffi.mosaic_uniffi.buildShareLinkUrl as rustBuildShareLinkUrl

interface ShareLinkUrlAssembler {
  fun buildShareLinkUrl(
    baseUrl: String,
    albumId: String,
    linkId: String,
    linkUrlToken: String,
  ): String
}

object RustShareLinkUrlAssembler : ShareLinkUrlAssembler {
  override fun buildShareLinkUrl(
    baseUrl: String,
    albumId: String,
    linkId: String,
    linkUrlToken: String,
  ): String {
    AndroidRustCoreLibraryLoader.warmUp()
    return rustBuildShareLinkUrl(baseUrl, albumId, linkId, linkUrlToken)
  }
}

class MosaicShareLinkUrls(
  private val assembler: ShareLinkUrlAssembler = RustShareLinkUrlAssembler,
) {
  fun build(
    baseUrl: String,
    albumId: String,
    linkId: String,
    linkUrlToken: String,
  ): String {
    require(baseUrl.isNotBlank()) { "baseUrl is required" }
    require(albumId.isNotBlank()) { "albumId is required" }
    require(linkId.isNotBlank()) { "linkId is required" }
    require(linkUrlToken.isNotBlank()) { "linkUrlToken is required" }
    val url = assembler.buildShareLinkUrl(baseUrl, albumId, linkId, linkUrlToken)
    require(url.isNotBlank()) { "Rust share-link URL assembly failed" }
    return url
  }
}
