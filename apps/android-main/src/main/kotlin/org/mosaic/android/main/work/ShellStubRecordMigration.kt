package org.mosaic.android.main.work

import android.content.Context
import android.content.SharedPreferences

/**
 * One-shot A-pre-1 migration that removes stale shell prototype auto-import
 * stub records before the Android client gains INTERNET permission.
 */
object ShellStubRecordMigration {
  const val MIGRATION_PREFS_NAME: String = "org.mosaic.android.main.migrations"
  const val SHELL_STUB_PREFS_NAME: String = "org.mosaic.android.shell.stub_records"
  const val CLEARED_FLAG_KEY: String = "a_pre_1_shell_stub_records_cleared"

  val STALE_STUB_RECORD_KEYS: Set<String> = setOf(
    "auto_import_stub_records",
    "auto_import_stub_record_count",
    "auto_import_last_stub_record_id",
    "shell_stub_records",
    "stubbed_auto_import_jobs",
  )

  data class Result(val cleared: Boolean, val removedKeys: Set<String>)

  fun clearOnFirstLaunch(context: Context): Result {
    val appContext = context.applicationContext
    return clearOnFirstLaunch(
      migrationPreferences = appContext.getSharedPreferences(MIGRATION_PREFS_NAME, Context.MODE_PRIVATE),
      shellStubPreferences = appContext.getSharedPreferences(SHELL_STUB_PREFS_NAME, Context.MODE_PRIVATE),
    )
  }

  fun clearOnFirstLaunch(
    migrationPreferences: SharedPreferences,
    shellStubPreferences: SharedPreferences,
  ): Result {
    if (migrationPreferences.getBoolean(CLEARED_FLAG_KEY, false)) {
      return Result(cleared = false, removedKeys = emptySet())
    }

    val keysToRemove = shellStubPreferences.all.keys
      .filterTo(mutableSetOf()) { it in STALE_STUB_RECORD_KEYS }

    val stubEditor = shellStubPreferences.edit()
    for (key in keysToRemove) {
      stubEditor.remove(key)
    }
    stubEditor.apply()

    migrationPreferences.edit()
      .putBoolean(CLEARED_FLAG_KEY, true)
      .apply()

    return Result(cleared = true, removedKeys = keysToRemove)
  }
}
