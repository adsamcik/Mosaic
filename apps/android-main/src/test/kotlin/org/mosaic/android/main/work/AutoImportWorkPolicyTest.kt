package org.mosaic.android.main.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mosaic.android.foundation.AlbumId
import org.mosaic.android.foundation.AutoImportBackgroundDestination
import org.mosaic.android.foundation.AutoImportCapability
import org.mosaic.android.foundation.AutoImportCapabilityReference
import org.mosaic.android.foundation.AutoImportDestinationSelection
import org.mosaic.android.foundation.AutoImportRuntimeConditions
import org.mosaic.android.foundation.AutoImportScheduleSettings
import org.mosaic.android.foundation.AutoImportSchedulerContract
import org.mosaic.android.foundation.AutoImportScheduleStatus
import org.mosaic.android.foundation.ServerAccountId

/**
 * JVM-only unit test for the pure auto-import worker policy logic. Lives in
 * `apps/android-main/src/test/` (not the shell) because `AutoImportWorkPolicy`
 * is the *worker side* of the seam — it interprets a shell-produced plan in
 * terms of WorkManager enqueue decisions and unique-work names.
 *
 * Asserts:
 * - Capability check: a plan derived from disabled / unconfigured / locked
 *   settings short-circuits with the matching reason and never reaches
 *   [AutoImportWorkPolicy.Decision.ENQUEUE].
 * - Dedupe decision: the unique-work name for a (account, album) destination
 *   is deterministic and stable across recomputations, distinct destinations
 *   produce distinct names, and the name is opaque (does not embed account or
 *   album identifiers).
 *
 * Together these cover the "pure logic" half of the verification plan; the
 * instrumented test in `androidTest/` covers the WorkManager integration
 * (enqueue / dedupe-on-resubmit / capability-revoked-short-circuit).
 */
class AutoImportWorkPolicyTest {

  @Test
  fun decideShortCircuitsOnDisabledSettings() {
    val plan = AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.disabled())
    assertEquals(AutoImportScheduleStatus.DISABLED, plan.status)
    assertEquals(AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_DISABLED, AutoImportWorkPolicy.decide(plan))
  }

  @Test
  fun decideShortCircuitsWhenDestinationMissing() {
    val plan = AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.enabled(destination = null))
    assertEquals(AutoImportScheduleStatus.NEEDS_DESTINATION_ALBUM, plan.status)
    assertEquals(
      AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_NEEDS_DESTINATION,
      AutoImportWorkPolicy.decide(plan),
    )
  }

  @Test
  fun decideShortCircuitsWhenDeviceLocked() {
    val plan = AutoImportSchedulerContract.evaluate(
      settings = AutoImportScheduleSettings.enabled(uploadOnlyDestination()),
      runtime = AutoImportRuntimeConditions(deviceUnlockedSinceBoot = false),
    )
    assertEquals(AutoImportScheduleStatus.WAITING_FOR_DEVICE_UNLOCK, plan.status)
    assertEquals(
      AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_NEEDS_UNLOCK,
      AutoImportWorkPolicy.decide(plan),
    )
  }

  @Test
  fun decideEnqueuesWhenPlanIsReady() {
    val plan = AutoImportSchedulerContract.evaluate(
      settings = AutoImportScheduleSettings.enabled(uploadOnlyDestination()),
    )
    assertEquals(AutoImportScheduleStatus.READY_TO_SCHEDULE, plan.status)
    assertEquals(AutoImportWorkPolicy.Decision.ENQUEUE, AutoImportWorkPolicy.decide(plan))
  }

  @Test
  fun uniqueWorkNameIsDeterministicForSameDestination() {
    val first = AutoImportWorkPolicy.uniqueWorkName(uploadOnlyDestination())
    val second = AutoImportWorkPolicy.uniqueWorkName(uploadOnlyDestination())
    assertEquals("dedupe relies on the unique work name being stable", first, second)
  }

  @Test
  fun uniqueWorkNameDiffersAcrossDifferentDestinations() {
    val a = AutoImportWorkPolicy.uniqueWorkName(uploadOnlyDestination(albumId = AlbumId("album-a")))
    val b = AutoImportWorkPolicy.uniqueWorkName(uploadOnlyDestination(albumId = AlbumId("album-b")))
    assertNotEquals("two destinations must occupy distinct WorkManager unique-name slots", a, b)
  }

  @Test
  fun uniqueWorkNameOmitsRawIdentifiers() {
    val account = ServerAccountId("server-account-secret")
    val albumId = AlbumId("private-album")
    val capabilityReference = AutoImportCapabilityReference("upload-secret-capability")
    val destination = AutoImportDestinationSelection(
      albumId = albumId,
      capability = AutoImportCapability.UploadOnly(
        serverAccountId = account,
        albumId = albumId,
        reference = capabilityReference,
      ),
    ).toBackgroundScheduleDestination()

    val name = AutoImportWorkPolicy.uniqueWorkName(destination)
    assertTrue(
      "unique work name must use the documented namespace prefix",
      name.startsWith(AutoImportWorkPolicy.WORK_NAME_PREFIX),
    )
    val token = name.removePrefix(AutoImportWorkPolicy.WORK_NAME_PREFIX)
    assertEquals("SHA-256 hex digest is 64 characters", 64, token.length)
    assertTrue("token must be lowercase hex", token.all { it in '0'..'9' || it in 'a'..'f' })

    val forbidden = listOf(
      "server-account-secret",
      "private-album",
      "upload-secret-capability",
    )
    for (term in forbidden) {
      assertTrue(
        "unique work name must not embed raw $term",
        !name.contains(term, ignoreCase = true),
      )
    }
  }

  @Test
  fun decisionEnumIsExhaustivelyHandled() {
    // Defensive: this asserts that every Decision value is reachable from a
    // legal AutoImportSchedulePlan. If a new status is added to the shell,
    // this test forces us to extend AutoImportWorkPolicy.decide(...) too.
    val reachable = AutoImportWorkPolicy.Decision.values().toMutableSet()
    reachable.remove(AutoImportWorkPolicy.decide(
      AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.disabled()),
    ))
    reachable.remove(AutoImportWorkPolicy.decide(
      AutoImportSchedulerContract.evaluate(AutoImportScheduleSettings.enabled(destination = null)),
    ))
    reachable.remove(AutoImportWorkPolicy.decide(
      AutoImportSchedulerContract.evaluate(
        settings = AutoImportScheduleSettings.enabled(uploadOnlyDestination()),
        runtime = AutoImportRuntimeConditions(deviceUnlockedSinceBoot = false),
      ),
    ))
    reachable.remove(AutoImportWorkPolicy.decide(
      AutoImportSchedulerContract.evaluate(
        settings = AutoImportScheduleSettings.enabled(uploadOnlyDestination()),
      ),
    ))
    assertTrue(
      "every Decision branch must be reachable from a legal plan; remaining=$reachable",
      reachable.isEmpty(),
    )
  }

  private fun uploadOnlyDestination(
    albumId: AlbumId = AlbumId("album-1"),
    accountId: ServerAccountId = ServerAccountId("server-account-1"),
    capabilityReference: AutoImportCapabilityReference = AutoImportCapabilityReference("upload-capability-1"),
  ): AutoImportBackgroundDestination = AutoImportDestinationSelection(
    albumId = albumId,
    capability = AutoImportCapability.UploadOnly(
      serverAccountId = accountId,
      albumId = albumId,
      reference = capabilityReference,
    ),
  ).toBackgroundScheduleDestination()
}
