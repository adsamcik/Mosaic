package org.mosaic.android.main.work

import java.security.MessageDigest
import org.mosaic.android.foundation.AutoImportBackgroundDestination
import org.mosaic.android.foundation.AutoImportSchedulePlan
import org.mosaic.android.foundation.AutoImportScheduleStatus

/**
 * Pure scheduling-decision logic for the Band 6 auto-import worker. Lives in
 * `apps/android-main` (the worker's home) but takes no Android dependency, so
 * the JVM unit test in `src/test/.../AutoImportWorkPolicyTest.kt` can exercise
 * the full decision matrix without an emulator.
 *
 * The object is intentionally narrow: it converts an
 * [org.mosaic.android.foundation.AutoImportSchedulePlan] (produced by the
 * shell's `AutoImportSchedulerContract`) into a discrete enqueue decision and
 * derives a stable, opaque WorkManager unique-work name. All policy nuance
 * (capability shape, upload-only invariant, foreground-notification policy)
 * already lives in the shell foundation; this object re-projects it onto the
 * WorkManager API surface.
 */
object AutoImportWorkPolicy {

  /**
   * Outcome of evaluating an [AutoImportSchedulePlan] for WorkManager
   * enqueueing. Tests assert against this enum rather than `ExistingWorkPolicy`
   * so the JVM unit test does not need WorkManager on the classpath.
   */
  enum class Decision {
    SHORT_CIRCUIT_DISABLED,
    SHORT_CIRCUIT_NEEDS_DESTINATION,
    SHORT_CIRCUIT_NEEDS_UNLOCK,
    ENQUEUE,
  }

  /**
   * Maps a schedule plan onto an enqueue decision. `READY_TO_SCHEDULE` is the
   * only state that yields [Decision.ENQUEUE]; everything else short-circuits
   * with a state-specific reason so that callers (the worker, the application
   * boot path, and tests) can observe *why* nothing was scheduled.
   */
  fun decide(plan: AutoImportSchedulePlan): Decision = when (plan.status) {
    AutoImportScheduleStatus.DISABLED -> Decision.SHORT_CIRCUIT_DISABLED
    AutoImportScheduleStatus.NEEDS_DESTINATION_ALBUM -> Decision.SHORT_CIRCUIT_NEEDS_DESTINATION
    AutoImportScheduleStatus.WAITING_FOR_DEVICE_UNLOCK -> Decision.SHORT_CIRCUIT_NEEDS_UNLOCK
    AutoImportScheduleStatus.READY_TO_SCHEDULE -> Decision.ENQUEUE
  }

  /**
   * Derives a deterministic WorkManager unique-work name for a destination.
   *
   * Why hash the inputs instead of concatenating them?
   * - WorkManager persists unique-work names to its internal database. Hashing
   *   the (account, album) tuple keeps user-derivable identifiers out of that
   *   database in line with the privacy-redacted `<opaque>` / `<redacted>`
   *   pattern enforced by the shell foundation.
   * - The hash is deterministic, so re-submitting the same (account, album)
   *   resolves to the same name and dedupes against existing work.
   * - Different (account, album) tuples produce different names, so two
   *   destinations cannot collide in the WorkManager queue.
   *
   * The `auto-import.` prefix keeps the name namespaced — the whole identifier
   * remains opaque (lowercase hex), so it is safe to log from WorkManager's
   * own diagnostics output.
   */
  fun uniqueWorkName(destination: AutoImportBackgroundDestination): String {
    val payload = "mosaic|auto-import|${destination.serverAccountId.value}|${destination.albumId.value}"
    val digest = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8))
    val hex = buildString(digest.size * 2) {
      for (byte in digest) {
        val v = byte.toInt() and 0xff
        append(HEX_DIGITS[v ushr 4])
        append(HEX_DIGITS[v and 0x0f])
      }
    }
    return WORK_NAME_PREFIX + hex
  }

  /**
   * Stable namespace for auto-import WorkManager unique names. Exposed so the
   * instrumented test can assert that the work name lives under the expected
   * namespace without re-implementing the SHA-256 derivation.
   */
  const val WORK_NAME_PREFIX: String = "auto-import."

  private val HEX_DIGITS = charArrayOf(
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
  )
}
