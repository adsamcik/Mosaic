package org.mosaic.android.main

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.privacy.PrivacyAuditPeriodicWorker
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = MosaicApplicationStartupTest.TestApplication::class)
class MosaicApplicationStartupTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @After
  fun tearDown() {
    WorkManager.getInstance(context).cancelAllWork().result.get()
    WorkManager.getInstance(context).pruneWork().result.get()
    MosaicApplication.resetTestHooks()
  }

  @Test
  fun onCreateEnqueuesPrivacyAuditDailyWorkExactlyOnce() {
    PrivacyAuditPeriodicWorker.enqueueDaily(context)
    val infos = awaitPrivacyAuditWork()

    assertEquals(1, infos.size)
  }

  private fun awaitPrivacyAuditWork(timeoutMs: Long = 5_000): List<androidx.work.WorkInfo> {
    val deadline = System.currentTimeMillis() + timeoutMs
    var last = emptyList<androidx.work.WorkInfo>()
    while (System.currentTimeMillis() < deadline) {
      last = WorkManager.getInstance(context)
        .getWorkInfosForUniqueWork(PrivacyAuditPeriodicWorker.UNIQUE_WORK_NAME)
        .get()
      if (last.isNotEmpty()) return last
      Thread.sleep(50)
    }
    return last
  }

  class TestApplication : MosaicApplication() {
    override fun onCreate() {
      WorkManagerTestInitHelper.initializeTestWorkManager(
        this,
        Configuration.Builder()
          .setMinimumLoggingLevel(Log.DEBUG)
          .setExecutor(SynchronousExecutor())
          .build(),
      )
      rustCoreWarmUp = {}
      migrateEnvelopeLayout = {}
      installAutoImportRuntime = {}
      enqueueAutoImportIfPolicyAllows = {}
      super.onCreate()
    }
  }
}
