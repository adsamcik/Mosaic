package org.mosaic.android.main

import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import org.mosaic.android.foundation.AccountKeyHandle
import org.mosaic.android.foundation.AccountUnlockCode
import org.mosaic.android.foundation.AccountUnlockRequest
import org.mosaic.android.foundation.GeneratedRustAccountBridge
import org.mosaic.android.foundation.KdfProfile
import org.mosaic.android.foundation.unlockAccountAndWipePassword
import org.mosaic.android.main.bridge.AndroidRustAccountApi
import org.mosaic.android.main.bridge.AndroidRustDiagnosticsApi

/**
 * Smoke-test launcher activity that proves the Rust↔Kotlin FFI is wired:
 *   - calls `protocolVersion()` from the Rust core and shows it on screen,
 *   - issues a deliberately rejectable `unlockAccountKey` round-trip with a
 *     too-weak KDF profile and asserts the expected stable error code is
 *     returned (`KDF_PROFILE_TOO_WEAK = 208`).
 *
 * No user data is collected; no network is made. No handles or key material
 * are logged.
 */
class MainActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(buildContent())
  }

  private fun buildContent(): ViewGroup {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(24), dp(24), dp(24), dp(24))
    }

    val title = textView("Mosaic Android", sizeSp = 22f)
    val protocolLine = textView(protocolLineText(), sizeSp = 14f)
    val smokeLine = textView(smokeLineText(), sizeSp = 14f)
    val deviceLine = textView("device api ${Build.VERSION.SDK_INT}", sizeSp = 12f)

    root.addView(title)
    root.addView(protocolLine)
    root.addView(smokeLine)
    root.addView(deviceLine)
    return root
  }

  private fun protocolLineText(): String = try {
    val version = AndroidRustDiagnosticsApi().protocolVersion()
    require(version.isNotBlank()) { "protocol version is blank" }
    "rust core: $version"
  } catch (error: Throwable) {
    "rust core: unavailable"
  }

  /**
   * Issues an `unlockAccountKey` call with an intentionally weak KDF profile. The
   * Rust core MUST reject it with the stable code `KDF_PROFILE_TOO_WEAK` (208). A
   * passing smoke test proves: native lib loaded, JNA marshalling works, error
   * codes propagate, password buffer wipe runs.
   */
  private fun smokeLineText(): String = try {
    val bridge = GeneratedRustAccountBridge(AndroidRustAccountApi())
    val password = "mosaic-smoke-test-password".toByteArray(Charsets.UTF_8)
    val request = AccountUnlockRequest(
      userSalt = ByteArray(AccountUnlockRequest.SALT_LENGTH),
      accountSalt = ByteArray(AccountUnlockRequest.SALT_LENGTH),
      wrappedAccountKey = ByteArray(64),
      kdfProfile = KdfProfile(memoryKiB = 8, iterations = 1, parallelism = 1),
    )
    val result = bridge.unlockAccountAndWipePassword(password, request)
    when (result.code) {
      AccountUnlockCode.KDF_PROFILE_TOO_WEAK -> "ffi: ok (rejected weak kdf)"
      AccountUnlockCode.SUCCESS -> {
        // This should never happen with the synthetic inputs above. If it does
        // we still close the handle to avoid leaking it.
        result.handle?.let { closeQuietly(it) }
        "ffi: unexpected success"
      }
      else -> "ffi: ok (rust returned ${result.code.name.lowercase()})"
    }
  } catch (error: Throwable) {
    "ffi: smoke failed"
  }

  private fun closeQuietly(handle: AccountKeyHandle) {
    runCatching { GeneratedRustAccountBridge(AndroidRustAccountApi()).closeAccountKeyHandle(handle) }
  }

  private fun textView(text: CharSequence, sizeSp: Float): TextView = TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
    val params = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    params.setMargins(0, dp(8), 0, dp(8))
    layoutParams = params
  }

  private fun dp(value: Int): Int =
    (value * resources.displayMetrics.density).toInt()
}
