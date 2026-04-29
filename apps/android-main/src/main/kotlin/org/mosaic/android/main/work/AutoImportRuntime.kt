package org.mosaic.android.main.work

import android.content.Context
import android.os.Build
import android.os.UserManager
import org.mosaic.android.foundation.AutoImportRuntimeConditions
import org.mosaic.android.foundation.AutoImportScheduleSettings

/**
 * Settings provider for the auto-import worker. Production wiring will plug in a
 * concrete implementation backed by an encrypted, opt-in policy store. The
 * default is `disabled()` so that — in the absence of explicit user opt-in —
 * `MosaicApplication.onCreate` short-circuits and never enqueues work.
 *
 * Tests install a custom provider via [AutoImportRuntime.installSettingsProvider]
 * to drive the worker through enabled / disabled transitions without touching
 * persistent storage.
 */
fun interface AutoImportSettingsProvider {
  fun current(): AutoImportScheduleSettings
}

/**
 * Runtime conditions queried just before scheduling decisions are made. The
 * default reads `UserManager.isUserUnlocked` (when available) so that direct-boot
 * stages of Android cannot trigger a foreground upload promotion. Tests inject
 * a fixed provider to assert the unlock-gate without depending on emulator
 * boot state.
 */
fun interface AutoImportRuntimeProvider {
  fun current(): AutoImportRuntimeConditions
}

/**
 * Process-scoped registry of [AutoImportSettingsProvider] / [AutoImportRuntimeProvider].
 * Holding the providers in one well-known place lets the worker look them up
 * inside `doWork()` without depending on a DI graph (the v1 Android module
 * intentionally has no DI container — see `apps/android-main/.instructions.md`).
 *
 * Concurrency: both holders are `@Volatile` and mutation is intended to happen
 * once at process boot or once per test. Reads are lock-free.
 */
object AutoImportRuntime {
  private object DefaultSettingsProvider : AutoImportSettingsProvider {
    override fun current(): AutoImportScheduleSettings = AutoImportScheduleSettings.disabled()
  }

  private object DefaultRuntimeProvider : AutoImportRuntimeProvider {
    override fun current(): AutoImportRuntimeConditions = AutoImportRuntimeConditions()
  }

  @Volatile
  private var settingsProvider: AutoImportSettingsProvider = DefaultSettingsProvider

  @Volatile
  private var runtimeProvider: AutoImportRuntimeProvider = DefaultRuntimeProvider

  fun installSettingsProvider(provider: AutoImportSettingsProvider) {
    settingsProvider = provider
  }

  fun installRuntimeProvider(provider: AutoImportRuntimeProvider) {
    runtimeProvider = provider
  }

  fun resetToDefaults() {
    settingsProvider = DefaultSettingsProvider
    runtimeProvider = DefaultRuntimeProvider
  }

  fun currentSettings(): AutoImportScheduleSettings = settingsProvider.current()

  fun currentRuntime(): AutoImportRuntimeConditions = runtimeProvider.current()

  /**
   * Builds an [AutoImportRuntimeProvider] backed by the platform `UserManager`.
   * Reads `isUserUnlocked` so that boot-time / direct-boot scheduling defers
   * until the user has unlocked the device at least once. On API levels where
   * the lookup is unsupported, the gate is treated as already-unlocked (the
   * conservative default for upload-only background work).
   */
  fun systemRuntimeProvider(context: Context): AutoImportRuntimeProvider {
    val appContext = context.applicationContext
    return AutoImportRuntimeProvider {
      val unlocked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        appContext.getSystemService(UserManager::class.java)?.isUserUnlocked ?: true
      } else {
        true
      }
      AutoImportRuntimeConditions(deviceUnlockedSinceBoot = unlocked)
    }
  }
}
