package org.mosaic.android.main.work

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellStubRecordMigrationTest {

  @Test
  fun clearsStaleShellStubRecordsExactlyOnce() {
    val migrations = FakeSharedPreferences()
    val shellStubs = FakeSharedPreferences(
      mutableMapOf(
        "auto_import_stub_records" to "prototype-records",
        "auto_import_stub_record_count" to 2,
        "auto_import_last_stub_record_id" to "stub-2",
        "unrelated_shell_value" to "keep",
      ),
    )

    val first = ShellStubRecordMigration.clearOnFirstLaunch(migrations, shellStubs)

    assertTrue("first launch must execute the A-pre-1 cleanup", first.cleared)
    assertEquals(
      setOf("auto_import_stub_records", "auto_import_stub_record_count", "auto_import_last_stub_record_id"),
      first.removedKeys,
    )
    assertFalse(shellStubs.contains("auto_import_stub_records"))
    assertFalse(shellStubs.contains("auto_import_stub_record_count"))
    assertFalse(shellStubs.contains("auto_import_last_stub_record_id"))
    assertEquals("keep", shellStubs.getString("unrelated_shell_value", null))
    assertTrue(migrations.getBoolean(ShellStubRecordMigration.CLEARED_FLAG_KEY, false))

    shellStubs.edit()
      .putString("auto_import_stub_records", "prototype-records-returned")
      .apply()

    val second = ShellStubRecordMigration.clearOnFirstLaunch(migrations, shellStubs)

    assertFalse("cleanup must not run again once the first-launch flag is set", second.cleared)
    assertEquals(emptySet<String>(), second.removedKeys)
    assertEquals(
      "prototype-records-returned",
      shellStubs.getString("auto_import_stub_records", null),
    )
  }

  @Test
  fun firstLaunchWithNoStaleRecordsStillSetsIdempotenceFlag() {
    val migrations = FakeSharedPreferences()
    val shellStubs = FakeSharedPreferences(mutableMapOf("unrelated_shell_value" to "keep"))

    val result = ShellStubRecordMigration.clearOnFirstLaunch(migrations, shellStubs)

    assertTrue(result.cleared)
    assertEquals(emptySet<String>(), result.removedKeys)
    assertEquals("keep", shellStubs.getString("unrelated_shell_value", null))
    assertTrue(migrations.getBoolean(ShellStubRecordMigration.CLEARED_FLAG_KEY, false))
  }

  private class FakeSharedPreferences(
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

    override fun edit(): SharedPreferences.Editor = FakeEditor(values)

    override fun registerOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit
  }

  private class FakeEditor(
    private val values: MutableMap<String, Any?>,
  ) : SharedPreferences.Editor {
    private val pending: MutableMap<String, Any?> = mutableMapOf()
    private val removals: MutableSet<String> = mutableSetOf()
    private var clearAll: Boolean = false

    override fun putString(key: String, value: String?): SharedPreferences.Editor = apply {
      pending[key] = value
      removals.remove(key)
    }

    override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = apply {
      pending[key] = values?.toSet()
      removals.remove(key)
    }

    override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply {
      pending[key] = value
      removals.remove(key)
    }

    override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply {
      pending[key] = value
      removals.remove(key)
    }

    override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply {
      pending[key] = value
      removals.remove(key)
    }

    override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply {
      pending[key] = value
      removals.remove(key)
    }

    override fun remove(key: String): SharedPreferences.Editor = apply {
      pending.remove(key)
      removals.add(key)
    }

    override fun clear(): SharedPreferences.Editor = apply {
      clearAll = true
      pending.clear()
      removals.clear()
    }

    override fun commit(): Boolean {
      apply()
      return true
    }

    override fun apply() {
      if (clearAll) {
        values.clear()
      }
      for (key in removals) {
        values.remove(key)
      }
      values.putAll(pending)
      pending.clear()
      removals.clear()
      clearAll = false
    }
  }
}
