package org.mosaic.android.main.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import org.mosaic.android.foundation.AutoImportBackgroundDestination
import org.mosaic.android.foundation.AutoImportConstraints
import org.mosaic.android.foundation.AutoImportNetworkConstraint
import org.mosaic.android.foundation.AutoImportSchedulePlan
import org.mosaic.android.foundation.AutoImportSchedulerContract

/**
 * WorkManager glue for the auto-import worker. Reads the current schedule
 * settings + runtime conditions from [AutoImportRuntime], evaluates them via
 * the shell's `AutoImportSchedulerContract`, and (only when the plan is
 * [org.mosaic.android.foundation.AutoImportScheduleStatus.READY_TO_SCHEDULE])
 * enqueues a `OneTimeWorkRequest<AutoImportWorker>` under a stable unique-work
 * name with `ExistingWorkPolicy.KEEP` so concurrent submissions dedupe.
 *
 * Capability boundary: the schedule-settings `destination` carries an
 * upload-only `AutoImportBackgroundDestination`. If settings are disabled or
 * the destination is null (capability revoked), this scheduler short-circuits
 * with [EnqueueOutcome.ShortCircuited] and never touches WorkManager.
 *
 * `MosaicApplication.onCreate` calls [enqueueIfPolicyAllows] from the
 * application boot path; default settings are `disabled()` so the boot path
 * is a no-op until a user explicitly opts in.
 */
object AutoImportWorkScheduler {

  /**
   * Outcome of an [enqueueIfPolicyAllows] call. The `Enqueued` variant carries
   * the unique work name actually used (the SHA-256 hash described in
   * [AutoImportWorkPolicy.uniqueWorkName]) so callers / tests can assert on it.
   */
  sealed interface EnqueueOutcome {
    data class Enqueued(val uniqueWorkName: String) : EnqueueOutcome
    data class ShortCircuited(val reason: AutoImportWorkPolicy.Decision) : EnqueueOutcome
  }

  /**
   * Evaluates the current settings against the policy contract and (only when
   * the plan reaches `READY_TO_SCHEDULE`) enqueues the auto-import worker.
   * Idempotent: re-submitting with the same (account, album) destination is
   * deduplicated by WorkManager via `ExistingWorkPolicy.KEEP` on the unique
   * work name.
   */
  fun enqueueIfPolicyAllows(context: Context): EnqueueOutcome {
    val settings = AutoImportRuntime.currentSettings()
    val runtime = AutoImportRuntime.currentRuntime()
    val plan = AutoImportSchedulerContract.evaluate(settings, runtime)
    return enqueueIfPlanReady(context, plan)
  }

  /**
   * Lower-level entry point used by the instrumented test to drive the
   * scheduler with a deliberately-built plan (after, e.g., revoking the
   * capability) without rebuilding the full settings/runtime pair. Production
   * callers should prefer [enqueueIfPolicyAllows].
   */
  fun enqueueIfPlanReady(context: Context, plan: AutoImportSchedulePlan): EnqueueOutcome {
    val decision = AutoImportWorkPolicy.decide(plan)
    if (decision != AutoImportWorkPolicy.Decision.ENQUEUE) {
      return EnqueueOutcome.ShortCircuited(decision)
    }

    val destination = plan.destination
      ?: return EnqueueOutcome.ShortCircuited(AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_NEEDS_DESTINATION)

    val workName = AutoImportWorkPolicy.uniqueWorkName(destination)
    val request = OneTimeWorkRequestBuilder<AutoImportWorker>()
      .setConstraints(buildConstraints(plan.constraints))
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
      .build()

    WorkManager.getInstance(context.applicationContext)
      .enqueueUniqueWork(workName, ExistingWorkPolicy.KEEP, request)

    return EnqueueOutcome.Enqueued(workName)
  }

  /**
   * Cancels any pending or running auto-import work for the given destination.
   * Used by capability-revocation and tear-down flows to make sure a former
   * upload-only capability cannot continue uploading after the user has opted
   * out.
   */
  fun cancel(context: Context, destination: AutoImportBackgroundDestination) {
    WorkManager.getInstance(context.applicationContext)
      .cancelUniqueWork(AutoImportWorkPolicy.uniqueWorkName(destination))
  }

  private fun buildConstraints(constraints: AutoImportConstraints): Constraints {
    val networkType = when (constraints.network) {
      AutoImportNetworkConstraint.WIFI_ONLY -> NetworkType.UNMETERED
    }
    return Constraints.Builder()
      .setRequiredNetworkType(networkType)
      .setRequiresBatteryNotLow(constraints.requiresBatteryNotLow)
      .setRequiresCharging(constraints.requiresCharging)
      .build()
  }

  private const val INITIAL_BACKOFF_SECONDS: Long = 30L
}
