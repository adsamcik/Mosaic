package org.mosaic.android.foundation

@JvmInline
value class AutoImportQueueRecordId(val value: String) {
  init {
    require(value.isNotBlank()) { "auto-import queue record id is required" }
  }
}

@JvmInline
value class LogicalPhotoRecordId(val value: String) {
  init {
    require(value.isNotBlank()) { "logical photo record id is required" }
  }

  override fun toString(): String = "LogicalPhotoRecordId(<opaque>)"
}

@JvmInline
value class EncryptedContentVersionId(val value: String) {
  init {
    require(value.isNotBlank()) { "encrypted content version id is required" }
  }

  override fun toString(): String = "EncryptedContentVersionId(<opaque>)"
}

class AutoImportLocalAssetIdentity private constructor(val value: String) {
  override fun equals(other: Any?): Boolean = other is AutoImportLocalAssetIdentity && value == other.value

  override fun hashCode(): Int = value.hashCode()

  override fun toString(): String = "AutoImportLocalAssetIdentity(<redacted>)"

  companion object {
    private const val REQUIRED_SCHEME = "mosaic-local-asset://"

    fun of(value: String): AutoImportLocalAssetIdentity {
      requireOpaqueTokenReference(
        value = value,
        requiredScheme = REQUIRED_SCHEME,
        description = "auto-import local asset identity",
      )
      return AutoImportLocalAssetIdentity(value)
    }
  }
}

@JvmInline
value class AutoImportLocalVersionToken(val value: String) {
  init {
    require(value.isNotBlank()) { "local version token is required" }
    require(!containsPlaintextLocator(value)) { "local version token must be opaque" }
  }

  override fun toString(): String = "AutoImportLocalVersionToken(<redacted>)"
}

class EncryptedBlobReference private constructor(val value: String) {
  override fun equals(other: Any?): Boolean = other is EncryptedBlobReference && value == other.value

  override fun hashCode(): Int = value.hashCode()

  override fun toString(): String = "EncryptedBlobReference(<redacted>)"

  companion object {
    private const val REQUIRED_SCHEME = "mosaic-encrypted://"

    fun of(value: String): EncryptedBlobReference {
      requireOpaqueTokenReference(
        value = value,
        requiredScheme = REQUIRED_SCHEME,
        description = "encrypted blob reference",
      )
      return EncryptedBlobReference(value)
    }
  }
}

class EncryptedManifestReference private constructor(val value: String) {
  override fun equals(other: Any?): Boolean = other is EncryptedManifestReference && value == other.value

  override fun hashCode(): Int = value.hashCode()

  override fun toString(): String = "EncryptedManifestReference(<redacted>)"

  companion object {
    private const val REQUIRED_SCHEME = "mosaic-encrypted://"

    fun of(value: String): EncryptedManifestReference {
      requireOpaqueTokenReference(
        value = value,
        requiredScheme = REQUIRED_SCHEME,
        description = "encrypted manifest reference",
      )
      return EncryptedManifestReference(value)
    }
  }
}

data class AutoImportProhibitedPayload(
  val filename: String? = null,
  val caption: String? = null,
  val exif: Map<String, String> = emptyMap(),
  val gps: String? = null,
  val deviceMetadata: Map<String, String> = emptyMap(),
  val rawKeys: List<ByteArray> = emptyList(),
  val decryptedMetadata: Map<String, String> = emptyMap(),
  val rawUri: String? = null,
  val plaintextPath: String? = null,
  val plaintextContentHash: String? = null,
  val perceptualFingerprint: String? = null,
) {
  override fun toString(): String = "AutoImportProhibitedPayload(<redacted>)"

  fun validateEmpty() {
    val violations = mutableListOf<String>()
    if (!filename.isNullOrBlank()) violations += "filename"
    if (!caption.isNullOrBlank()) violations += "caption"
    if (exif.isNotEmpty()) violations += "EXIF"
    if (!gps.isNullOrBlank()) violations += "GPS"
    if (deviceMetadata.isNotEmpty()) violations += "device metadata"
    if (rawKeys.isNotEmpty()) violations += "raw keys"
    if (decryptedMetadata.isNotEmpty()) violations += "decrypted metadata"
    if (!rawUri.isNullOrBlank()) violations += "raw URI"
    if (!plaintextPath.isNullOrBlank()) violations += "plaintext path"
    if (!plaintextContentHash.isNullOrBlank()) violations += "plaintext content hash"
    if (!perceptualFingerprint.isNullOrBlank()) violations += "perceptual fingerprint"

    require(violations.isEmpty()) {
      "auto-import durable records forbid privacy-sensitive fields: ${violations.joinToString()}"
    }
  }

  companion object {
    val None: AutoImportProhibitedPayload = AutoImportProhibitedPayload()
  }
}

enum class AutoImportQueueStatus {
  READY,
  UPLOADING,
  RETRY_WAITING,
  CANCELLED,
  FINALIZED,
}

enum class AutoImportFailureCategory {
  TRANSIENT_NETWORK,
  SERVER_BUSY,
  CRYPTO_LOCKED,
  OFFSET_MISMATCH,
}

data class AutoImportBackoffPolicy(
  val baseDelayMillis: Long,
  val maxDelayMillis: Long,
) {
  init {
    require(baseDelayMillis > 0) { "base backoff delay must be positive" }
    require(maxDelayMillis >= baseDelayMillis) { "max backoff delay must be at least the base delay" }
  }

  fun delayForFailure(retryCountBeforeFailure: Int): Long {
    require(retryCountBeforeFailure >= 0) { "retry count must not be negative" }
    var delay = baseDelayMillis
    repeat(retryCountBeforeFailure) {
      delay = if (delay >= maxDelayMillis / 2) maxDelayMillis else delay * 2
    }
    return delay.coerceAtMost(maxDelayMillis)
  }

  companion object {
    fun default(): AutoImportBackoffPolicy = AutoImportBackoffPolicy(
      baseDelayMillis = 30_000,
      maxDelayMillis = 60L * 60L * 1000L,
    )
  }
}

data class AutoImportRetryState(
  val status: AutoImportQueueStatus,
  val retryCount: Int,
  val lastFailureAtEpochMillis: Long?,
  val nextAttemptAtEpochMillis: Long?,
  val lastFailureCategory: AutoImportFailureCategory?,
  val cancelledAtEpochMillis: Long?,
  val lastResumedAtEpochMillis: Long?,
) {
  init {
    require(status != AutoImportQueueStatus.FINALIZED) { "retry state does not represent finalized queue records" }
    require(retryCount >= 0) { "retry count must not be negative" }
    require(lastFailureAtEpochMillis == null || lastFailureAtEpochMillis >= 0) { "failure timestamp must not be negative" }
    require(nextAttemptAtEpochMillis == null || nextAttemptAtEpochMillis >= 0) { "next-attempt timestamp must not be negative" }
    require(cancelledAtEpochMillis == null || cancelledAtEpochMillis >= 0) { "cancel timestamp must not be negative" }
    require(lastResumedAtEpochMillis == null || lastResumedAtEpochMillis >= 0) { "resume timestamp must not be negative" }
    require((status == AutoImportQueueStatus.RETRY_WAITING) == (nextAttemptAtEpochMillis != null)) {
      "retry-waiting records require exactly one next-attempt timestamp"
    }
    require((status == AutoImportQueueStatus.CANCELLED) == (cancelledAtEpochMillis != null)) {
      "cancelled records require exactly one cancel timestamp"
    }
  }

  fun recordRetryableFailure(
    nowEpochMillis: Long,
    category: AutoImportFailureCategory,
    backoffPolicy: AutoImportBackoffPolicy = AutoImportBackoffPolicy.default(),
  ): AutoImportRetryState {
    require(nowEpochMillis >= 0) { "failure timestamp must not be negative" }
    require(status != AutoImportQueueStatus.CANCELLED) { "cancelled auto-import records cannot be retried before resume" }
    val nextRetryCount = retryCount + 1
    return copy(
      status = AutoImportQueueStatus.RETRY_WAITING,
      retryCount = nextRetryCount,
      lastFailureAtEpochMillis = nowEpochMillis,
      nextAttemptAtEpochMillis = nowEpochMillis + backoffPolicy.delayForFailure(retryCount),
      lastFailureCategory = category,
      cancelledAtEpochMillis = null,
    )
  }

  fun cancel(nowEpochMillis: Long): AutoImportRetryState {
    require(nowEpochMillis >= 0) { "cancel timestamp must not be negative" }
    return copy(
      status = AutoImportQueueStatus.CANCELLED,
      nextAttemptAtEpochMillis = null,
      cancelledAtEpochMillis = nowEpochMillis,
    )
  }

  fun resume(nowEpochMillis: Long): AutoImportRetryState {
    require(nowEpochMillis >= 0) { "resume timestamp must not be negative" }
    require(status == AutoImportQueueStatus.CANCELLED) { "only cancelled auto-import records can resume" }
    return copy(
      status = AutoImportQueueStatus.READY,
      nextAttemptAtEpochMillis = null,
      cancelledAtEpochMillis = null,
      lastResumedAtEpochMillis = nowEpochMillis,
    )
  }

  companion object {
    fun initial(): AutoImportRetryState = AutoImportRetryState(
      status = AutoImportQueueStatus.READY,
      retryCount = 0,
      lastFailureAtEpochMillis = null,
      nextAttemptAtEpochMillis = null,
      lastFailureCategory = null,
      cancelledAtEpochMillis = null,
      lastResumedAtEpochMillis = null,
    )
  }
}

class AutoImportQueueRecord private constructor(
  val id: AutoImportQueueRecordId,
  val serverAccountId: ServerAccountId,
  val albumId: AlbumId,
  val localAssetIdentity: AutoImportLocalAssetIdentity,
  val logicalPhotoRecordId: LogicalPhotoRecordId?,
  val stagedEncryptedBlobRef: EncryptedBlobReference,
  val contentLengthBytes: Long,
  val createdAtEpochMillis: Long,
  val retryState: AutoImportRetryState,
) {
  override fun toString(): String =
    "AutoImportQueueRecord(id=$id, serverAccountId=$serverAccountId, albumId=$albumId, " +
      "localAssetIdentity=<redacted>, logicalPhotoRecordId=$logicalPhotoRecordId, " +
      "stagedEncryptedBlobRef=<redacted>, contentLengthBytes=$contentLengthBytes, " +
      "createdAtEpochMillis=$createdAtEpochMillis, retryState=$retryState)"

  companion object {
    fun create(
      id: AutoImportQueueRecordId,
      serverAccountId: ServerAccountId,
      albumId: AlbumId,
      localAssetIdentity: AutoImportLocalAssetIdentity,
      logicalPhotoRecordId: LogicalPhotoRecordId?,
      stagedEncryptedBlobRef: EncryptedBlobReference,
      contentLengthBytes: Long,
      createdAtEpochMillis: Long,
      retryState: AutoImportRetryState,
      prohibited: AutoImportProhibitedPayload = AutoImportProhibitedPayload.None,
    ): AutoImportQueueRecord {
      prohibited.validateEmpty()
      require(contentLengthBytes > 0) { "auto-import encrypted content length must be positive" }
      require(createdAtEpochMillis >= 0) { "created timestamp must not be negative" }
      return AutoImportQueueRecord(
        id = id,
        serverAccountId = serverAccountId,
        albumId = albumId,
        localAssetIdentity = localAssetIdentity,
        logicalPhotoRecordId = logicalPhotoRecordId,
        stagedEncryptedBlobRef = stagedEncryptedBlobRef,
        contentLengthBytes = contentLengthBytes,
        createdAtEpochMillis = createdAtEpochMillis,
        retryState = retryState,
      )
    }
  }
}

enum class LogicalPhotoWriteMode {
  CREATE_NEW_PHOTO,
  REPLACE_EXISTING_PHOTO_CONTENT,
}

class LogicalPhotoWriteContract private constructor(
  val mode: LogicalPhotoWriteMode,
  val localAssetIdentity: AutoImportLocalAssetIdentity?,
  val logicalPhotoRecordId: LogicalPhotoRecordId?,
) {
  override fun toString(): String =
    "LogicalPhotoWriteContract(mode=$mode, localAssetIdentity=<redacted>, logicalPhotoRecordId=$logicalPhotoRecordId)"

  companion object {
    fun manualPickerUpload(): LogicalPhotoWriteContract = LogicalPhotoWriteContract(
      mode = LogicalPhotoWriteMode.CREATE_NEW_PHOTO,
      localAssetIdentity = null,
      logicalPhotoRecordId = null,
    )

    fun manualPickerReplacement(logicalPhotoRecordId: LogicalPhotoRecordId): LogicalPhotoWriteContract {
      throw IllegalArgumentException(
        "manual Photo Picker uploads create new photos and cannot replace logical record $logicalPhotoRecordId",
      )
    }

    fun autoImportFirstVersion(localAssetIdentity: AutoImportLocalAssetIdentity): LogicalPhotoWriteContract =
      LogicalPhotoWriteContract(
        mode = LogicalPhotoWriteMode.CREATE_NEW_PHOTO,
        localAssetIdentity = localAssetIdentity,
        logicalPhotoRecordId = null,
      )

    fun autoImportReplacement(
      localAssetIdentity: AutoImportLocalAssetIdentity,
      logicalPhotoRecordId: LogicalPhotoRecordId,
    ): LogicalPhotoWriteContract = LogicalPhotoWriteContract(
      mode = LogicalPhotoWriteMode.REPLACE_EXISTING_PHOTO_CONTENT,
      localAssetIdentity = localAssetIdentity,
      logicalPhotoRecordId = logicalPhotoRecordId,
    )
  }
}

data class AutoImportAssetSnapshot(
  val localAssetIdentity: AutoImportLocalAssetIdentity,
  val localVersionToken: AutoImportLocalVersionToken,
  val contentLengthBytes: Long,
  val observedAtEpochMillis: Long,
) {
  init {
    require(contentLengthBytes > 0) { "asset content length must be positive" }
    require(observedAtEpochMillis >= 0) { "observed timestamp must not be negative" }
  }

  fun detectDriftFrom(previous: AutoImportAssetSnapshot): AutoImportDriftDetectionResult {
    require(localAssetIdentity == previous.localAssetIdentity) {
      "asset drift comparison requires the same stable local asset identity"
    }
    val status = if (
      localVersionToken == previous.localVersionToken &&
      contentLengthBytes == previous.contentLengthBytes
    ) {
      AutoImportDriftStatus.UNCHANGED
    } else {
      AutoImportDriftStatus.CONTENT_CHANGED
    }
    return AutoImportDriftDetectionResult(
      status = status,
      previousSnapshot = previous,
      currentSnapshot = this,
    )
  }
}

enum class AutoImportDriftStatus {
  UNCHANGED,
  CONTENT_CHANGED,
}

data class AutoImportDriftDetectionResult(
  val status: AutoImportDriftStatus,
  val previousSnapshot: AutoImportAssetSnapshot,
  val currentSnapshot: AutoImportAssetSnapshot,
)

class AutoImportContentReplacementPlan private constructor(
  val logicalPhotoRecordId: LogicalPhotoRecordId,
  val previousVersionId: EncryptedContentVersionId,
  val replacementVersionId: EncryptedContentVersionId,
  val replacementEncryptedBlobRef: EncryptedBlobReference,
  val replacementManifestFinalizationKey: ManifestFinalizationIdempotencyKey,
  val drift: AutoImportDriftDetectionResult,
) {
  fun isPreviousVersionGcEligible(finalizationLedger: ManifestFinalizationLedger): Boolean =
    finalizationLedger.idempotencyKey == replacementManifestFinalizationKey && finalizationLedger.isFinalized

  override fun toString(): String =
    "AutoImportContentReplacementPlan(logicalPhotoRecordId=$logicalPhotoRecordId, " +
      "previousVersionId=$previousVersionId, replacementVersionId=$replacementVersionId, " +
      "replacementEncryptedBlobRef=<redacted>, replacementManifestFinalizationKey=<opaque>, " +
      "driftStatus=${drift.status})"

  companion object {
    fun create(
      logicalPhotoRecordId: LogicalPhotoRecordId,
      previousVersionId: EncryptedContentVersionId,
      replacementVersionId: EncryptedContentVersionId,
      replacementEncryptedBlobRef: EncryptedBlobReference,
      replacementManifestFinalizationKey: ManifestFinalizationIdempotencyKey,
      drift: AutoImportDriftDetectionResult,
    ): AutoImportContentReplacementPlan {
      require(drift.status == AutoImportDriftStatus.CONTENT_CHANGED) {
        "replacement versions require detected asset drift"
      }
      require(previousVersionId != replacementVersionId) {
        "replacement encrypted content version must be distinct from previous version"
      }
      return AutoImportContentReplacementPlan(
        logicalPhotoRecordId = logicalPhotoRecordId,
        previousVersionId = previousVersionId,
        replacementVersionId = replacementVersionId,
        replacementEncryptedBlobRef = replacementEncryptedBlobRef,
        replacementManifestFinalizationKey = replacementManifestFinalizationKey,
        drift = drift,
      )
    }
  }
}

@JvmInline
value class TusUploadSessionId(val value: String) {
  init {
    require(value.isNotBlank()) { "TUS upload session id is required" }
  }
}

data class TusOffsetState(
  val uploadSessionId: TusUploadSessionId,
  val totalBytes: Long,
  val localCommittedOffset: Long,
  val lastReconciledAtEpochMillis: Long? = null,
) {
  init {
    require(totalBytes > 0) { "TUS total byte count must be positive" }
    require(localCommittedOffset in 0..totalBytes) { "local TUS offset must be within the encrypted blob length" }
    require(lastReconciledAtEpochMillis == null || lastReconciledAtEpochMillis >= 0) {
      "TUS reconciliation timestamp must not be negative"
    }
  }

  fun reconcile(
    serverOffset: Long,
    observedAtEpochMillis: Long,
  ): TusOffsetReconciliation {
    require(serverOffset in 0..totalBytes) { "server TUS offset must be within the encrypted blob length" }
    require(observedAtEpochMillis >= 0) { "TUS reconciliation timestamp must not be negative" }

    val decision = when {
      serverOffset == totalBytes -> TusOffsetDecision.SERVER_HAS_COMPLETE_UPLOAD
      serverOffset == localCommittedOffset -> TusOffsetDecision.ALREADY_IN_SYNC
      serverOffset < localCommittedOffset -> TusOffsetDecision.REWIND_LOCAL_TO_SERVER
      else -> TusOffsetDecision.FAST_FORWARD_LOCAL_TO_SERVER
    }

    return TusOffsetReconciliation(
      decision = decision,
      state = copy(
        localCommittedOffset = serverOffset,
        lastReconciledAtEpochMillis = observedAtEpochMillis,
      ),
    )
  }
}

enum class TusOffsetDecision {
  ALREADY_IN_SYNC,
  REWIND_LOCAL_TO_SERVER,
  FAST_FORWARD_LOCAL_TO_SERVER,
  SERVER_HAS_COMPLETE_UPLOAD,
}

data class TusOffsetReconciliation(
  val decision: TusOffsetDecision,
  val state: TusOffsetState,
)

@JvmInline
value class ManifestFinalizationIdempotencyKey(val value: String) {
  init {
    require(value.isNotBlank()) { "manifest finalization idempotency key is required" }
    require(!containsPlaintextLocator(value)) { "manifest finalization idempotency key must be opaque" }
  }

  override fun toString(): String = "ManifestFinalizationIdempotencyKey(<opaque>)"
}

enum class ManifestFinalizationStatus {
  PENDING,
  FINALIZED,
}

enum class ManifestFinalizationTransition {
  FINALIZED_NOW,
  IDEMPOTENT_REPLAY,
}

class ManifestFinalizationLedger private constructor(
  val idempotencyKey: ManifestFinalizationIdempotencyKey,
  val status: ManifestFinalizationStatus,
  val manifestRef: EncryptedManifestReference?,
  val finalizedAtEpochMillis: Long?,
) {
  val isFinalized: Boolean
    get() = status == ManifestFinalizationStatus.FINALIZED

  init {
    require((status == ManifestFinalizationStatus.FINALIZED) == (manifestRef != null && finalizedAtEpochMillis != null)) {
      "finalized manifests require a manifest reference and timestamp; pending manifests must not include them"
    }
    require(finalizedAtEpochMillis == null || finalizedAtEpochMillis >= 0) {
      "manifest finalization timestamp must not be negative"
    }
  }

  fun recordSuccess(
    idempotencyKey: ManifestFinalizationIdempotencyKey,
    manifestRef: EncryptedManifestReference,
    finalizedAtEpochMillis: Long,
  ): ManifestFinalizationResult {
    require(idempotencyKey == this.idempotencyKey) { "manifest finalization idempotency key mismatch" }
    require(finalizedAtEpochMillis >= 0) { "manifest finalization timestamp must not be negative" }

    if (isFinalized) {
      require(manifestRef == this.manifestRef) {
        "manifest finalization replay must match the already-finalized encrypted manifest"
      }
      return ManifestFinalizationResult(
        transition = ManifestFinalizationTransition.IDEMPOTENT_REPLAY,
        ledger = this,
      )
    }

    return ManifestFinalizationResult(
      transition = ManifestFinalizationTransition.FINALIZED_NOW,
      ledger = ManifestFinalizationLedger(
        idempotencyKey = idempotencyKey,
        status = ManifestFinalizationStatus.FINALIZED,
        manifestRef = manifestRef,
        finalizedAtEpochMillis = finalizedAtEpochMillis,
      ),
    )
  }

  override fun toString(): String =
    "ManifestFinalizationLedger(idempotencyKey=<opaque>, status=$status, manifestRef=<redacted>, " +
      "finalizedAtEpochMillis=$finalizedAtEpochMillis)"

  companion object {
    fun pending(idempotencyKey: ManifestFinalizationIdempotencyKey): ManifestFinalizationLedger =
      ManifestFinalizationLedger(
        idempotencyKey = idempotencyKey,
        status = ManifestFinalizationStatus.PENDING,
        manifestRef = null,
        finalizedAtEpochMillis = null,
      )
  }
}

data class ManifestFinalizationResult(
  val transition: ManifestFinalizationTransition,
  val ledger: ManifestFinalizationLedger,
)

data class AutoImportRetentionPolicy(
  val stuckEncryptedStagingRetentionDays: Int,
) {
  init {
    require(stuckEncryptedStagingRetentionDays > 0) { "stuck staged data retention must be positive" }
  }

  fun expiresAtEpochMillis(stagedAtEpochMillis: Long): Long {
    require(stagedAtEpochMillis >= 0) { "staged timestamp must not be negative" }
    return stagedAtEpochMillis + stuckEncryptedStagingRetentionDays * MILLIS_PER_DAY
  }

  fun isExpired(stagedAtEpochMillis: Long, nowEpochMillis: Long): Boolean {
    require(nowEpochMillis >= 0) { "current timestamp must not be negative" }
    return nowEpochMillis >= expiresAtEpochMillis(stagedAtEpochMillis)
  }

  companion object {
    private const val DEFAULT_STUCK_STAGING_RETENTION_DAYS = 7
    private const val MILLIS_PER_DAY = 24L * 60L * 60L * 1000L

    fun default(): AutoImportRetentionPolicy = AutoImportRetentionPolicy(
      stuckEncryptedStagingRetentionDays = DEFAULT_STUCK_STAGING_RETENTION_DAYS,
    )
  }
}

private fun requireOpaqueTokenReference(
  value: String,
  requiredScheme: String,
  description: String,
) {
  require(value.startsWith(requiredScheme)) { "$description must use the $requiredScheme scheme" }
  val token = value.drop(requiredScheme.length)
  require(token.isNotBlank()) { "$description token is required" }
  require(token.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' }) {
    "$description must be an opaque token"
  }
  require(!containsPlaintextLocator(value)) { "$description must not contain raw URIs or plaintext paths" }
}

private fun containsPlaintextLocator(value: String): Boolean {
  val lower = value.lowercase()
  val windowsDrivePath = Regex("(^|[^a-z])[a-z]:\\\\").containsMatchIn(lower)
  return lower.contains("content://") ||
    lower.contains("file://") ||
    lower.contains("/sdcard/") ||
    lower.contains("/storage/") ||
    lower.startsWith("/") ||
    lower.startsWith("\\") ||
    windowsDrivePath
}
