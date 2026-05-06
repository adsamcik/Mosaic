package org.mosaic.android.main

import android.content.SharedPreferences
import android.util.Log
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.work.ShellStubRecordMigration
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MosaicApplicationTest {

  @After
  fun resetHooks() {
    MosaicApplication.resetTestHooks()
    ShellStubRecordMigration.resetTestHooks()
    ShadowLog.clear()
  }

  @Test
  fun onCreateLogsAndContinuesWhenFirstLaunchCleanupApplyThrows() {
    ShadowLog.setupLogging()
    val migrationPreferences = ThrowingApplySharedPreferences()
    val shellStubPreferences = ThrowingApplySharedPreferences(
      mutableMapOf("auto_import_stub_records" to "prototype-records"),
    )
    MosaicApplication.rustCoreWarmUp = {}
    MosaicApplication.installAutoImportRuntime = {}
    MosaicApplication.registerUploadNotificationChannel = {}
    MosaicApplication.enqueueAutoImportIfPolicyAllows = {}
    ShellStubRecordMigration.sharedPreferencesOpener = { _, name ->
      when (name) {
        ShellStubRecordMigration.MIGRATION_PREFS_NAME -> migrationPreferences
        ShellStubRecordMigration.SHELL_STUB_PREFS_NAME -> shellStubPreferences
        else -> error("unexpected shared preferences file: $name")
      }
    }

    MosaicApplication().onCreate()

    val logs = ShadowLog.getLogsForTag("MosaicApplication")
    val logSummary = logs.joinToString(separator = "\n") { item ->
      "${item.type}|${item.tag}|${item.msg}|${item.throwable?.javaClass?.name}"
    }
    assertTrue(
      "A-pre-1 cleanup failure must be logged as a warning. Logs:\n$logSummary",
      logs.any { item ->
        item.type == Log.WARN &&
          item.msg.contains("A-pre-1 cleanup failed") &&
          item.throwable is SecurityException
      },
    )
  }

  private class ThrowingApplySharedPreferences(
    private val values: MutableMap<String, Any?> = mutableMapOf(),
  ) : SharedPreferences {
    override fun getAll(): MutableMap<String, *> = values.toMutableMap()

    override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue

    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
      @Suppress("UNCHECKED_CAST")
      (values[key] as? Set<String>)?.toMutableSet() ?: defValues

    override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue

    override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue

    override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue

    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue

    override fun contains(key: String): Boolean = values.containsKey(key)

    override fun edit(): SharedPreferences.Editor = ThrowingApplyEditor()

    override fun registerOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit
  }

  private class ThrowingApplyEditor : SharedPreferences.Editor {
    override fun putString(key: String, value: String?): SharedPreferences.Editor = this

    override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this

    override fun putInt(key: String, value: Int): SharedPreferences.Editor = this

    override fun putLong(key: String, value: Long): SharedPreferences.Editor = this

    override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this

    override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = this

    override fun remove(key: String): SharedPreferences.Editor = this

    override fun clear(): SharedPreferences.Editor = this

    override fun commit(): Boolean {
      apply()
      return false
    }

    override fun apply() {
      throw SecurityException("SharedPreferences apply denied")
    }
  }
}
