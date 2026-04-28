package org.mosaic.android.foundation

@JvmInline
value class EphemeralContentUri(val value: String) {
  init {
    require(value.startsWith("content://")) { "Photo Picker selections must use content URIs" }
  }

  override fun toString(): String = "EphemeralContentUri(<redacted>)"
}

data class PhotoPickerSelection(
  val contentUri: EphemeralContentUri,
  val selectedAtEpochMillis: Long,
) {
  init {
    require(selectedAtEpochMillis >= 0) { "selection timestamp must not be negative" }
  }

  override fun toString(): String = "PhotoPickerSelection(contentUri=<redacted>, selectedAtEpochMillis=$selectedAtEpochMillis)"
}

data class PhotoPickerReadReceipt(
  val stagedSource: StagedMediaReference,
  val contentLengthBytes: Long,
  val stagedAtEpochMillis: Long,
) {
  init {
    require(contentLengthBytes > 0) { "manual upload content length must be positive" }
    require(stagedAtEpochMillis >= 0) { "staged timestamp must not be negative" }
  }
}

fun interface PhotoPickerImmediateReadPort {
  fun readImmediately(selection: PhotoPickerSelection): PhotoPickerReadReceipt
}
