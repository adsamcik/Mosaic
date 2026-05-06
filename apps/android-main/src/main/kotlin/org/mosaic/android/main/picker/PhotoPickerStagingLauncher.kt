package org.mosaic.android.main.picker

import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Helpers for wiring Android's Photo Picker into [PhotoPickerStagingAdapter].
 *
 * Compose integration pattern:
 * 1. Create the adapter with the app's [org.mosaic.android.main.staging.AppPrivateStagingManager]
 *    and [android.content.ContentResolver].
 * 2. Use `rememberLauncherForActivityResult(contract = photoPickerStagingContract())`.
 * 3. In the launcher callback, launch a coroutine and call [stagePhotoPickerResult]
 *    with the returned `List<Uri>`.
 * 4. Launch with [imageOnlyPhotoPickerRequest] to use Android 13+'s no-permission
 *    system Photo Picker for images.
 */
fun photoPickerStagingContract(): ActivityResultContracts.PickMultipleVisualMedia =
  ActivityResultContracts.PickMultipleVisualMedia()

fun photoPickerStagingContract(maxItems: Int): ActivityResultContracts.PickMultipleVisualMedia {
  require(maxItems > 0) { "maxItems must be positive" }
  return ActivityResultContracts.PickMultipleVisualMedia(maxItems)
}

fun imageOnlyPhotoPickerRequest(): PickVisualMediaRequest =
  PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)

suspend fun stagePhotoPickerResult(
  uris: List<Uri>,
  adapter: PhotoPickerStagingAdapter,
): List<StagedItem> = adapter.stagePickedItems(uris)
