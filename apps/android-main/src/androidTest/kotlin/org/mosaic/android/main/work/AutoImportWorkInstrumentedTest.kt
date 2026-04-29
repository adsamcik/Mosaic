package org.mosaic.android.main.work

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.foundation.AlbumId
import org.mosaic.android.foundation.AutoImportBackgroundDestination
import org.mosaic.android.foundation.AutoImportCapability
import org.mosaic.android.foundation.AutoImportCapabilityReference
import org.mosaic.android.foundation.AutoImportConstraints
import org.mosaic.android.foundation.AutoImportDestinationSelection
import org.mosaic.android.foundation.AutoImportRuntimeConditions
import org.mosaic.android.foundation.AutoImportScheduleSettings
import org.mosaic.android.foundation.ServerAccountId

/**
 * Instrumented tests for the Band 6 auto-import WorkManager wiring. Drives the
 * worker on a real Android device (emulator-5554 in CI) using the test
 * WorkManager initialization so the worker runs synchronously and assertions
 * can examine the resulting WorkInfo state without flakiness.
 *
 * The three scenarios in the verification plan map to the @Test methods:
 *
 *  - [enqueueIfPolicyAllowsCreatesUniqueWorkAndRunsToSuccess]:
 *      enqueue produces an Enqueued outcome carrying the SHA-256 unique work
 *      name, WorkManager has exactly one WorkInfo entry under that name, and
 *      the worker terminates in SUCCEEDED.
 *
 *  - [resubmittingTheSameDestinationDedupesViaUniqueWorkName]:
 *      enqueueing twice with identical settings still produces exactly one
 *      WorkInfo (ExistingWorkPolicy.KEEP). Both calls return the same
 *      uniqueWorkName so callers can observe the dedupe.
 *
 *  - [revokedCapabilityShortCircuitsBeforeWorkManagerSeesAnything]:
 *      flipping the settings provider to `disabled()` between scheduler
 *      invocations causes [AutoImportWorkScheduler.enqueueIfPolicyAllows] to
 *      short-circuit with [AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_DISABLED]
 *      and never enqueue work; an already-running worker that re-evaluates
 *      its plan will return Result.success() without promoting itself to a
 *      foreground service.
 */
@RunWith(AndroidJUnit4::class)
class AutoImportWorkInstrumentedTest {

  private lateinit var context: Context
  private lateinit var settingsHolder: MutableSettingsHolder

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    val config = Configuration.Builder()
      .setMinimumLoggingLevel(Log.DEBUG)
      .setExecutor(SynchronousExecutor())
      .build()
    WorkManagerTestInitHelper.initializeTestWorkManager(context, config)

    settingsHolder = MutableSettingsHolder(AutoImportScheduleSettings.disabled())
    AutoImportRuntime.installSettingsProvider(settingsHolder::current)
    AutoImportRuntime.installRuntimeProvider {
      AutoImportRuntimeConditions(deviceUnlockedSinceBoot = true)
    }
  }

  @After
  fun tearDown() {
    AutoImportRuntime.resetToDefaults()
    val workManager = WorkManager.getInstance(context)
    workManager.cancelAllWork().result.get()
    workManager.pruneWork().result.get()
  }

  @Test
  fun enqueueIfPolicyAllowsCreatesUniqueWorkAndRunsToSuccess() {
    val destination = uploadOnlyDestination()
    settingsHolder.set(
      AutoImportScheduleSettings.enabled(
        destination = destination,
        constraints = unconstrainedTestConstraints(),
      ),
    )

    val outcome = AutoImportWorkScheduler.enqueueIfPolicyAllows(context)
    val enqueued = assertEnqueued(outcome)

    val expectedName = AutoImportWorkPolicy.uniqueWorkName(destination)
    assertEquals("scheduler must report the same name it gave to WorkManager", expectedName, enqueued.uniqueWorkName)
    assertTrue(
      "unique work name must use the documented prefix",
      enqueued.uniqueWorkName.startsWith(AutoImportWorkPolicy.WORK_NAME_PREFIX),
    )

    releasePendingConstraints(enqueued.uniqueWorkName)

    val terminal = awaitTerminalState(enqueued.uniqueWorkName)
    assertEquals(
      "synchronous executor + ready plan + relaxed constraints must drive the worker to success",
      WorkInfo.State.SUCCEEDED,
      terminal.state,
    )
    val infos = workInfosFor(enqueued.uniqueWorkName)
    assertEquals("exactly one WorkInfo under the unique name", 1, infos.size)
  }

  @Test
  fun resubmittingTheSameDestinationDedupesViaUniqueWorkName() {
    val destination = uploadOnlyDestination()
    settingsHolder.set(
      AutoImportScheduleSettings.enabled(
        destination = destination,
        constraints = unconstrainedTestConstraints(),
      ),
    )

    val first = assertEnqueued(AutoImportWorkScheduler.enqueueIfPolicyAllows(context))
    val second = assertEnqueued(AutoImportWorkScheduler.enqueueIfPolicyAllows(context))

    assertEquals(
      "dedupe contract: re-submission must reuse the same unique work name",
      first.uniqueWorkName,
      second.uniqueWorkName,
    )

    val infos = workInfosFor(first.uniqueWorkName)
    assertEquals(
      "ExistingWorkPolicy.KEEP must collapse re-submission into a single WorkInfo",
      1,
      infos.size,
    )
  }

  @Test
  fun revokedCapabilityShortCircuitsBeforeWorkManagerSeesAnything() {
    // 1. Capability fully revoked: settings.disabled().
    settingsHolder.set(AutoImportScheduleSettings.disabled())
    val outcome = AutoImportWorkScheduler.enqueueIfPolicyAllows(context)
    val shortCircuited = outcome as? AutoImportWorkScheduler.EnqueueOutcome.ShortCircuited
    assertNotNull("disabled settings must short-circuit before WorkManager.enqueue", shortCircuited)
    assertEquals(
      "short-circuit reason must reflect the disabled capability",
      AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_DISABLED,
      shortCircuited!!.reason,
    )

    // 2. Capability missing destination: enabled() but destination=null.
    settingsHolder.set(AutoImportScheduleSettings.enabled(destination = null))
    val missingDestinationOutcome = AutoImportWorkScheduler.enqueueIfPolicyAllows(context)
    val missingDestination = missingDestinationOutcome as? AutoImportWorkScheduler.EnqueueOutcome.ShortCircuited
    assertNotNull(
      "missing destination must short-circuit (capability not yet bound to an album)",
      missingDestination,
    )
    assertEquals(
      AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_NEEDS_DESTINATION,
      missingDestination!!.reason,
    )

    // 3. Worker re-evaluates revoked capability between enqueue and execution.
    //    The unmetered-network constraint keeps the work in ENQUEUED state
    //    until the test driver releases it, giving us a deterministic window
    //    to revoke the capability before the worker's doWork() runs.
    val destination = uploadOnlyDestination()
    settingsHolder.set(
      AutoImportScheduleSettings.enabled(
        destination = destination,
        constraints = unconstrainedTestConstraints(),
      ),
    )
    val enqueued = assertEnqueued(AutoImportWorkScheduler.enqueueIfPolicyAllows(context))
    // Revoke the capability *before* releasing the constraint gate.
    settingsHolder.set(AutoImportScheduleSettings.disabled())
    releasePendingConstraints(enqueued.uniqueWorkName)

    val terminal = awaitTerminalState(enqueued.uniqueWorkName)
    val infos = workInfosFor(enqueued.uniqueWorkName)
    assertEquals("revoked-mid-flight workers still produce a single WorkInfo", 1, infos.size)
    assertEquals(
      "revoked capability must terminate the worker as a benign success (no retry storm) — got ${terminal.state}",
      WorkInfo.State.SUCCEEDED,
      terminal.state,
    )
    assertFalse("revoked worker must not enter a permanent FAILED state", terminal.state == WorkInfo.State.FAILED)
  }

  // -- helpers ---------------------------------------------------------------

  private fun assertEnqueued(
    outcome: AutoImportWorkScheduler.EnqueueOutcome,
  ): AutoImportWorkScheduler.EnqueueOutcome.Enqueued {
    return outcome as? AutoImportWorkScheduler.EnqueueOutcome.Enqueued
      ?: throw AssertionError("expected Enqueued outcome, got $outcome")
  }

  private fun workInfosFor(uniqueName: String): List<WorkInfo> {
    return WorkManager.getInstance(context).getWorkInfosForUniqueWork(uniqueName).get()
  }

  /**
   * Releases the constraint gate for any work scheduled under [uniqueName].
   * The production scheduler maps `WIFI_ONLY` to `NetworkType.UNMETERED`, and
   * the test executor never observes a real wifi network, so without this the
   * worker would stay ENQUEUED indefinitely. Tests using
   * `WorkManagerTestInitHelper` are expected to call this once they want the
   * synchronous executor to actually drive the worker through `doWork()`.
   */
  private fun releasePendingConstraints(uniqueName: String) {
    val driver = WorkManagerTestInitHelper.getTestDriver(context)
      ?: throw AssertionError("WorkManagerTestInitHelper.getTestDriver must be available")
    val infos = workInfosFor(uniqueName)
    for (info in infos) {
      if (info.state == WorkInfo.State.ENQUEUED) {
        driver.setAllConstraintsMet(info.id)
      }
    }
  }

  /**
   * Polls [workInfosFor] until the worker reaches a terminal state
   * (`SUCCEEDED`, `FAILED`, or `CANCELLED`). `CoroutineWorker` runs its body
   * on `Dispatchers.Default`, so even with WorkManager's `SynchronousExecutor`
   * the actual `doWork()` body completes asynchronously relative to
   * `setAllConstraintsMet`. Polling avoids a race between `WorkInfo` lookup
   * and worker completion.
   */
  private fun awaitTerminalState(uniqueName: String, timeoutMs: Long = 5_000): WorkInfo {
    val deadline = System.currentTimeMillis() + timeoutMs
    var lastObserved: WorkInfo? = null
    while (System.currentTimeMillis() < deadline) {
      val infos = workInfosFor(uniqueName)
      val info = infos.firstOrNull()
      if (info != null) {
        lastObserved = info
        if (info.state.isFinished) {
          return info
        }
      }
      Thread.sleep(50)
    }
    throw AssertionError(
      "worker under '$uniqueName' did not reach a terminal state within ${timeoutMs}ms; " +
        "last observed=${lastObserved?.state}",
    )
  }

  /**
   * Test-only constraints. The production scheduler maps `WIFI_ONLY` to
   * `NetworkType.UNMETERED`, and an emulator's loopback network is metered
   * by default — that would block the worker from running under the
   * synchronous executor. We override constraints to `requiresBatteryNotLow=
   * false`, `requiresCharging=false`, and accept that the WIFI mapping in
   * production is exercised by the JVM unit test, not the instrumented one.
   */
  private fun unconstrainedTestConstraints(): AutoImportConstraints = AutoImportConstraints(
    network = AutoImportConstraints.default().network,
    requiresBatteryNotLow = false,
    requiresCharging = false,
  )

  private fun uploadOnlyDestination(
    accountId: ServerAccountId = ServerAccountId("instrumented-server-account"),
    albumId: AlbumId = AlbumId("instrumented-album"),
    capabilityReference: AutoImportCapabilityReference =
      AutoImportCapabilityReference("instrumented-capability"),
  ): AutoImportBackgroundDestination = AutoImportDestinationSelection(
    albumId = albumId,
    capability = AutoImportCapability.UploadOnly(
      serverAccountId = accountId,
      albumId = albumId,
      reference = capabilityReference,
    ),
  ).toBackgroundScheduleDestination()

  private class MutableSettingsHolder(initial: AutoImportScheduleSettings) {
    @Volatile
    private var settings: AutoImportScheduleSettings = initial

    fun current(): AutoImportScheduleSettings = settings

    fun set(next: AutoImportScheduleSettings) {
      settings = next
    }
  }
}
