package org.mosaic.android.main.diagnostics

import android.util.Log
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrivacySafeLoggerTest {
  @Before
  fun setUpLogCapture() {
    ShadowLog.clear()
    ShadowLog.setupLogging()
  }

  @After
  fun clearLogCapture() {
    ShadowLog.clear()
  }

  @Test
  fun closedEventWritesOnlyItsStaticRedactedMessage() {
    val event = PrivacySafeDiagnosticEvent.SHARD_STAGING_CLEANUP_FAILED

    PrivacySafeLogger.record(event)

    val entry = ShadowLog.getLogsForTag(event.tag).single()
    assertEquals(Log.WARN, entry.type)
    assertEquals(event.message, entry.msg)
    assertNull(entry.throwable)
  }

  @Test
  fun loggerApiCannotAcceptArbitraryTextOrThrowable() {
    val parameterTypes = PrivacySafeLogger::class.java.declaredMethods
      .filterNot { method -> method.isSynthetic }
      .flatMap { method -> method.parameterTypes.toList() }

    assertFalse(parameterTypes.contains(String::class.java))
    assertTrue(parameterTypes.none(Throwable::class.java::isAssignableFrom))
  }

  @Test
  fun envelopeMigrationSummaryContainsOnlyAggregateCounts() {
    PrivacySafeLogger.recordEnvelopeMigrationSummary(moved = 3, orphaned = 2, errors = 1)

    val entry = ShadowLog.getLogsForTag("EnvelopeLayoutMigrator").single()
    assertEquals(Log.INFO, entry.type)
    assertEquals("Envelope layout migration complete (moved=3, orphaned=2, errors=1)", entry.msg)
    assertNull(entry.throwable)
  }
}
