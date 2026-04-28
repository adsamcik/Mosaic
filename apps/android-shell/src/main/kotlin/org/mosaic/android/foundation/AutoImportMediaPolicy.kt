package org.mosaic.android.foundation

@JvmInline
value class AndroidMediaApiLevel(val value: Int) {
  init {
    require(value >= 1) { "Android API level must be positive" }
  }
}

enum class AutoImportMediaType {
  PHOTO,
  VIDEO,
}

enum class AutoImportPermissionModel {
  MODERN_PHOTO_VIDEO_READ,
  LEGACY_STORAGE_READ,
}

enum class AutoImportMediaRuntimePermission {
  READ_MEDIA_IMAGES,
  READ_MEDIA_VIDEO,
  READ_EXTERNAL_STORAGE,
}

enum class AutoImportLibraryScope {
  SELECTED_ALBUM_OPT_IN_ONLY,
}

data class AutoImportMediaPermissionDecision(
  val apiLevel: AndroidMediaApiLevel,
  val mediaTypes: Set<AutoImportMediaType>,
  val permissionModel: AutoImportPermissionModel,
  val runtimePermissions: Set<AutoImportMediaRuntimePermission>,
  val libraryScope: AutoImportLibraryScope,
  val requestsAllFilesAccess: Boolean,
) {
  init {
    require(mediaTypes.isNotEmpty()) { "auto-import must specify at least one media type" }
    require(runtimePermissions.isNotEmpty()) { "auto-import permission decision must include a runtime permission abstraction" }
  }

  fun staticPolicyViolations(): List<String> {
    val violations = mutableListOf<String>()
    if (requestsAllFilesAccess) {
      violations += "auto-import must not request Android all-files storage access"
    }
    if (libraryScope != AutoImportLibraryScope.SELECTED_ALBUM_OPT_IN_ONLY) {
      violations += "auto-import must stay scoped to explicit selected-album opt-in"
    }
    if (apiLevel.value >= 33 && permissionModel != AutoImportPermissionModel.MODERN_PHOTO_VIDEO_READ) {
      violations += "API 33+ auto-import must use modern photo/video read permission abstractions"
    }
    if (apiLevel.value < 33 && permissionModel != AutoImportPermissionModel.LEGACY_STORAGE_READ) {
      violations += "pre-API 33 auto-import must use the older storage read abstraction"
    }
    return violations
  }
}

object AutoImportMediaPermissionPolicy {
  fun decisionFor(
    apiLevel: AndroidMediaApiLevel,
    mediaTypes: Set<AutoImportMediaType>,
  ): AutoImportMediaPermissionDecision {
    require(mediaTypes.isNotEmpty()) { "auto-import must specify at least one media type" }

    val permissionModel: AutoImportPermissionModel
    val runtimePermissions: Set<AutoImportMediaRuntimePermission>
    if (apiLevel.value >= 33) {
      permissionModel = AutoImportPermissionModel.MODERN_PHOTO_VIDEO_READ
      val permissions = mutableSetOf<AutoImportMediaRuntimePermission>()
      if (AutoImportMediaType.PHOTO in mediaTypes) {
        permissions += AutoImportMediaRuntimePermission.READ_MEDIA_IMAGES
      }
      if (AutoImportMediaType.VIDEO in mediaTypes) {
        permissions += AutoImportMediaRuntimePermission.READ_MEDIA_VIDEO
      }
      runtimePermissions = permissions
    } else {
      permissionModel = AutoImportPermissionModel.LEGACY_STORAGE_READ
      runtimePermissions = setOf(AutoImportMediaRuntimePermission.READ_EXTERNAL_STORAGE)
    }

    return AutoImportMediaPermissionDecision(
      apiLevel = apiLevel,
      mediaTypes = mediaTypes.toSet(),
      permissionModel = permissionModel,
      runtimePermissions = runtimePermissions,
      libraryScope = AutoImportLibraryScope.SELECTED_ALBUM_OPT_IN_ONLY,
      requestsAllFilesAccess = false,
    )
  }
}

enum class AutoImportUxFraming {
  IMPORT_UPLOAD_CONVENIENCE_NOT_BACKUP,
}

@JvmInline
value class OpaqueLocalAlbumIdentity(val value: String) {
  init {
    requireOpaqueDurableToken("local album identity", value)
  }

  override fun toString(): String = "OpaqueLocalAlbumIdentity(<opaque>)"
}

@JvmInline
value class OpaqueLocalMediaAssetIdentity(val value: String) {
  init {
    requireOpaqueDurableToken("local media asset identity", value)
  }

  override fun toString(): String = "OpaqueLocalMediaAssetIdentity(<opaque>)"
}

data class AutoImportSchedulingConstraints(
  val requiresWifi: Boolean = true,
  val requiresBatteryNotLow: Boolean = true,
)

class AutoImportSelectedAlbumOptIn private constructor(
  val localAlbumIdentity: OpaqueLocalAlbumIdentity,
  val destinationAlbumId: AlbumId,
  val uxFraming: AutoImportUxFraming,
) {
  override fun toString(): String =
    "AutoImportSelectedAlbumOptIn(localAlbumIdentity=<opaque>, destinationAlbumId=<opaque>, uxFraming=$uxFraming)"

  override fun equals(other: Any?): Boolean =
    other is AutoImportSelectedAlbumOptIn &&
      localAlbumIdentity == other.localAlbumIdentity &&
      destinationAlbumId == other.destinationAlbumId &&
      uxFraming == other.uxFraming

  override fun hashCode(): Int {
    var result = localAlbumIdentity.hashCode()
    result = 31 * result + destinationAlbumId.hashCode()
    result = 31 * result + uxFraming.hashCode()
    return result
  }

  companion object {
    fun create(
      localAlbumIdentity: OpaqueLocalAlbumIdentity,
      destinationAlbumId: AlbumId,
      uxFraming: AutoImportUxFraming = AutoImportUxFraming.IMPORT_UPLOAD_CONVENIENCE_NOT_BACKUP,
      prohibited: AutoImportProhibitedDurableFields = AutoImportProhibitedDurableFields.None,
    ): AutoImportSelectedAlbumOptIn {
      prohibited.validateEmpty()
      return AutoImportSelectedAlbumOptIn(
        localAlbumIdentity = localAlbumIdentity,
        destinationAlbumId = destinationAlbumId,
        uxFraming = uxFraming,
      )
    }
  }
}

enum class AutoImportMediaPolicyStatus {
  DISABLED_BY_DEFAULT,
  NEEDS_SELECTED_ALBUM_OPT_IN,
  READY_FOR_PERMISSION_CHECK,
  BLOCKED_BY_STATIC_POLICY,
}

data class AutoImportMediaPolicyEvaluation(
  val status: AutoImportMediaPolicyStatus,
  val staticPolicyViolations: List<String>,
) {
  init {
    require((status == AutoImportMediaPolicyStatus.BLOCKED_BY_STATIC_POLICY) == staticPolicyViolations.isNotEmpty()) {
      "auto-import static policy violations must match blocked status"
    }
  }
}

class AutoImportMediaPolicyRecord private constructor(
  val enabled: Boolean,
  val selectedAlbumOptIn: AutoImportSelectedAlbumOptIn?,
  val constraints: AutoImportSchedulingConstraints,
) {
  fun evaluate(permissionDecision: AutoImportMediaPermissionDecision): AutoImportMediaPolicyEvaluation {
    val violations = permissionDecision.staticPolicyViolations()
    return when {
      violations.isNotEmpty() -> AutoImportMediaPolicyEvaluation(
        status = AutoImportMediaPolicyStatus.BLOCKED_BY_STATIC_POLICY,
        staticPolicyViolations = violations,
      )
      !enabled -> AutoImportMediaPolicyEvaluation(
        status = AutoImportMediaPolicyStatus.DISABLED_BY_DEFAULT,
        staticPolicyViolations = emptyList(),
      )
      selectedAlbumOptIn == null -> AutoImportMediaPolicyEvaluation(
        status = AutoImportMediaPolicyStatus.NEEDS_SELECTED_ALBUM_OPT_IN,
        staticPolicyViolations = emptyList(),
      )
      else -> AutoImportMediaPolicyEvaluation(
        status = AutoImportMediaPolicyStatus.READY_FOR_PERMISSION_CHECK,
        staticPolicyViolations = emptyList(),
      )
    }
  }

  override fun toString(): String =
    "AutoImportMediaPolicyRecord(enabled=$enabled, selectedAlbumOptIn=<opaque>, constraints=$constraints)"

  override fun equals(other: Any?): Boolean =
    other is AutoImportMediaPolicyRecord &&
      enabled == other.enabled &&
      selectedAlbumOptIn == other.selectedAlbumOptIn &&
      constraints == other.constraints

  override fun hashCode(): Int {
    var result = enabled.hashCode()
    result = 31 * result + (selectedAlbumOptIn?.hashCode() ?: 0)
    result = 31 * result + constraints.hashCode()
    return result
  }

  companion object {
    fun defaultDisabled(): AutoImportMediaPolicyRecord = create(
      enabled = false,
      selectedAlbumOptIn = null,
      constraints = AutoImportSchedulingConstraints(),
    )

    fun create(
      enabled: Boolean,
      selectedAlbumOptIn: AutoImportSelectedAlbumOptIn?,
      constraints: AutoImportSchedulingConstraints = AutoImportSchedulingConstraints(),
      prohibited: AutoImportProhibitedDurableFields = AutoImportProhibitedDurableFields.None,
    ): AutoImportMediaPolicyRecord {
      prohibited.validateEmpty()
      return AutoImportMediaPolicyRecord(
        enabled = enabled,
        selectedAlbumOptIn = selectedAlbumOptIn,
        constraints = constraints,
      )
    }
  }
}

data class AutoImportProhibitedDurableFields(
  val rawContentUri: String? = null,
  val filename: String? = null,
  val caption: String? = null,
  val exif: Map<String, String> = emptyMap(),
  val gps: String? = null,
  val deviceMetadata: Map<String, String> = emptyMap(),
) {
  override fun toString(): String = "AutoImportProhibitedDurableFields(<redacted>)"

  fun validateEmpty() {
    val violations = mutableListOf<String>()
    if (!rawContentUri.isNullOrBlank()) violations += "raw content URI"
    if (!filename.isNullOrBlank()) violations += "filename"
    if (!caption.isNullOrBlank()) violations += "caption"
    if (exif.isNotEmpty()) violations += "EXIF"
    if (!gps.isNullOrBlank()) violations += "GPS"
    if (deviceMetadata.isNotEmpty()) violations += "device metadata"

    require(violations.isEmpty()) {
      "auto-import durable records forbid privacy-sensitive fields: ${violations.joinToString()}"
    }
  }

  companion object {
    val None: AutoImportProhibitedDurableFields = AutoImportProhibitedDurableFields()
  }
}

class AutoImportDurableMediaRecord private constructor(
  val localAssetIdentity: OpaqueLocalMediaAssetIdentity,
  val selectedAlbumIdentity: OpaqueLocalAlbumIdentity,
  val encryptedStagedSource: StagedMediaReference?,
  val discoveredAtEpochMillis: Long,
) {
  init {
    require(discoveredAtEpochMillis >= 0) { "auto-import discovered timestamp must not be negative" }
  }

  override fun toString(): String =
    "AutoImportDurableMediaRecord(localAssetIdentity=<opaque>, selectedAlbumIdentity=<opaque>, " +
      "encryptedStagedSource=<redacted>, discoveredAtEpochMillis=$discoveredAtEpochMillis)"

  override fun equals(other: Any?): Boolean =
    other is AutoImportDurableMediaRecord &&
      localAssetIdentity == other.localAssetIdentity &&
      selectedAlbumIdentity == other.selectedAlbumIdentity &&
      encryptedStagedSource == other.encryptedStagedSource &&
      discoveredAtEpochMillis == other.discoveredAtEpochMillis

  override fun hashCode(): Int {
    var result = localAssetIdentity.hashCode()
    result = 31 * result + selectedAlbumIdentity.hashCode()
    result = 31 * result + (encryptedStagedSource?.hashCode() ?: 0)
    result = 31 * result + discoveredAtEpochMillis.hashCode()
    return result
  }

  companion object {
    fun create(
      localAssetIdentity: OpaqueLocalMediaAssetIdentity,
      selectedAlbumIdentity: OpaqueLocalAlbumIdentity,
      encryptedStagedSource: StagedMediaReference?,
      discoveredAtEpochMillis: Long,
      prohibited: AutoImportProhibitedDurableFields = AutoImportProhibitedDurableFields.None,
    ): AutoImportDurableMediaRecord {
      prohibited.validateEmpty()
      return AutoImportDurableMediaRecord(
        localAssetIdentity = localAssetIdentity,
        selectedAlbumIdentity = selectedAlbumIdentity,
        encryptedStagedSource = encryptedStagedSource,
        discoveredAtEpochMillis = discoveredAtEpochMillis,
      )
    }
  }
}

private fun requireOpaqueDurableToken(label: String, value: String) {
  require(value.isNotBlank()) { "$label is required" }
  require(value.none { it.isWhitespace() }) { "$label must be an opaque token without whitespace" }
  val lower = value.lowercase()
  for (fragment in forbiddenDurableTokenFragments) {
    require(!lower.contains(fragment)) { "$label must not contain raw URI, path, filename, caption, EXIF, GPS, or device metadata" }
  }
}

private val forbiddenDurableTokenFragments = listOf(
  "content://",
  "file://",
  "://",
  "/",
  "\\",
  "dcim",
  "img_",
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".mp4",
  "filename",
  "caption",
  "exif",
  "gps",
  "latitude",
  "longitude",
  "camera",
  "device",
  "private",
  "secret",
)
