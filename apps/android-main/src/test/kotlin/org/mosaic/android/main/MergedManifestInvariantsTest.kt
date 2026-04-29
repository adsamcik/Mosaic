package org.mosaic.android.main

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.w3c.dom.NodeList
import java.io.File

/**
 * Static analysis of the *merged* debug AndroidManifest.xml.
 *
 * Source-only manifest tests miss permissions, providers, and receivers
 * injected by AndroidX dependencies. This suite parses the merged manifest
 * AGP produces during `processDebugManifest` and asserts the privacy /
 * security invariants documented in `apps/android-main/.instructions.md`.
 *
 * The test fails fast with a clear message if the merged manifest is missing
 * (e.g. when running `gradlew :apps:android-main:testDebugUnitTest` before
 * the manifest is produced). The Gradle build configuration adds
 * `processDebugManifest` as a `dependsOn` of the test task to avoid that.
 */
class MergedManifestInvariantsTest {

  private val mergedManifest: File by lazy {
    val candidate = File("build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml")
    if (candidate.exists()) candidate else File(
      System.getProperty("user.dir"),
      "build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml",
    )
  }

  private val rootElement: Element by lazy {
    assertTrue(
      "merged manifest not found at ${mergedManifest.absolutePath}; " +
        "ensure the test task depends on `processDebugManifest`",
      mergedManifest.exists(),
    )
    val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
    val doc = factory.newDocumentBuilder().parse(mergedManifest)
    doc.documentElement
  }

  private val applicationElement: Element by lazy {
    val apps = rootElement.getElementsByTagName("application")
    assertTrue("merged manifest must declare exactly one <application>", apps.length == 1)
    apps.item(0) as Element
  }

  @Test
  fun forbiddenInternetPermissionAbsent() {
    forbidPermission("android.permission.INTERNET")
  }

  @Test
  fun forbiddenLegacyStoragePermissionsAbsent() {
    forbidPermission("android.permission.READ_EXTERNAL_STORAGE")
    forbidPermission("android.permission.WRITE_EXTERNAL_STORAGE")
    forbidPermission("android.permission.MANAGE_EXTERNAL_STORAGE")
  }

  @Test
  fun forbiddenScopedMediaPermissionsAbsent() {
    forbidPermission("android.permission.READ_MEDIA_IMAGES")
    forbidPermission("android.permission.READ_MEDIA_VIDEO")
    forbidPermission("android.permission.READ_MEDIA_AUDIO")
    forbidPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")
  }

  @Test
  fun forbiddenLocationPermissionsAbsent() {
    forbidPermission("android.permission.ACCESS_FINE_LOCATION")
    forbidPermission("android.permission.ACCESS_COARSE_LOCATION")
    forbidPermission("android.permission.ACCESS_BACKGROUND_LOCATION")
  }

  @Test
  fun forbiddenCameraPermissionsAbsent() {
    forbidPermission("android.permission.CAMERA")
    forbidPermission("android.permission.RECORD_AUDIO")
  }

  @Test
  fun applicationDeclaresAllowBackupFalse() {
    val allowBackup = applicationElement.getAttributeNS(ANDROID_NAMESPACE, "allowBackup")
    assertEquals("application must declare allowBackup=\"false\"", "false", allowBackup)
  }

  @Test
  fun applicationDeclaresHasFragileUserDataTrue() {
    val fragile = applicationElement.getAttributeNS(ANDROID_NAMESPACE, "hasFragileUserData")
    assertEquals("application must declare hasFragileUserData=\"true\"", "true", fragile)
  }

  @Test
  fun userDefinedActivityIsLauncherOnlyAndExported() {
    val activities = applicationElement.getElementsByTagName("activity")
    val mosaicActivities = (0 until activities.length)
      .map { activities.item(it) as Element }
      .filter { it.getAttributeNS(ANDROID_NAMESPACE, "name").startsWith("org.mosaic.") }
    assertEquals(
      "expected exactly one user-declared activity",
      1,
      mosaicActivities.size,
    )
    val main = mosaicActivities.first()
    assertEquals("org.mosaic.android.main.MainActivity", main.getAttributeNS(ANDROID_NAMESPACE, "name"))
    assertEquals(
      "MainActivity must declare android:exported=\"true\" (Android 12+ requirement for launchers)",
      "true",
      main.getAttributeNS(ANDROID_NAMESPACE, "exported"),
    )
    val intentFilters = main.getElementsByTagName("intent-filter")
    assertTrue("MainActivity must declare a launcher intent-filter", intentFilters.length >= 1)
    val intentFilter = intentFilters.item(0) as Element
    assertContainsAction(intentFilter, "android.intent.action.MAIN")
    assertContainsCategory(intentFilter, "android.intent.category.LAUNCHER")
  }

  @Test
  fun allUserDefinedProvidersAreNotExported() {
    val providers = applicationElement.getElementsByTagName("provider")
    (0 until providers.length).forEach { i ->
      val provider = providers.item(i) as Element
      val name = provider.getAttributeNS(ANDROID_NAMESPACE, "name")
      if (name.startsWith("org.mosaic.")) {
        val exported = provider.getAttributeNS(ANDROID_NAMESPACE, "exported")
        assertFalse("provider $name must not be exported", exported == "true")
      }
    }
  }

  @Test
  fun anyExportedReceiverIsPermissionGuarded() {
    val receivers = applicationElement.getElementsByTagName("receiver")
    (0 until receivers.length).forEach { i ->
      val receiver = receivers.item(i) as Element
      val name = receiver.getAttributeNS(ANDROID_NAMESPACE, "name")
      val exported = receiver.getAttributeNS(ANDROID_NAMESPACE, "exported")
      if (exported == "true") {
        val permission = receiver.getAttributeNS(ANDROID_NAMESPACE, "permission")
        assertTrue(
          "exported receiver $name must declare a permission attribute (got '$permission')",
          permission.isNotBlank(),
        )
      }
    }
  }

  @Test
  fun applicationDoesNotRequestLegacyExternalStorage() {
    val legacy = applicationElement.getAttributeNS(ANDROID_NAMESPACE, "requestLegacyExternalStorage")
    // Either unset (empty) or explicitly false. Never true.
    assertFalse(
      "application must NOT request legacy external storage",
      legacy == "true",
    )
  }

  @Test
  fun packageNameIsExpected() {
    val pkg = rootElement.getAttribute("package")
    assertEquals("org.mosaic.android.main", pkg)
  }

  @Test
  fun minSdkIs26() {
    val usesSdk = rootElement.getElementsByTagName("uses-sdk")
    assertTrue("uses-sdk element required", usesSdk.length >= 1)
    val sdk = usesSdk.item(0) as Element
    assertEquals("minSdk must be 26 (Android 8.0 floor)", "26", sdk.getAttributeNS(ANDROID_NAMESPACE, "minSdkVersion"))
  }

  // -- Band 6 auto-import worker invariants ---------------------------------

  @Test
  fun foregroundServicePermissionDeclared() {
    requirePermission("android.permission.FOREGROUND_SERVICE")
  }

  @Test
  fun foregroundServiceDataSyncPermissionDeclared() {
    // Required by Android 14+ to promote a worker to a `dataSync` foreground
    // service. Without this the WorkManager `setForeground` call from
    // AutoImportWorker would throw on API 34+.
    requirePermission("android.permission.FOREGROUND_SERVICE_DATA_SYNC")
  }

  @Test
  fun postNotificationsPermissionDeclared() {
    // Required by Android 13+ to actually display the foreground-service
    // notification posted by AutoImportWorker.
    requirePermission("android.permission.POST_NOTIFICATIONS")
  }

  @Test
  fun systemForegroundServiceDeclaresDataSyncType() {
    val services = applicationElement.getElementsByTagName("service")
    val foregroundService = (0 until services.length)
      .map { services.item(it) as Element }
      .firstOrNull { it.getAttributeNS(ANDROID_NAMESPACE, "name") == SYSTEM_FOREGROUND_SERVICE }
    assertNotNull(
      "WorkManager's SystemForegroundService must be present in the merged manifest " +
        "(merged from work-runtime); auto-import worker depends on it.",
      foregroundService,
    )
    val type = foregroundService!!.getAttributeNS(ANDROID_NAMESPACE, "foregroundServiceType")
    assertEquals(
      "auto-import worker requires foregroundServiceType=dataSync per ADR-007; got '$type'",
      "dataSync",
      type,
    )
  }

  // -- helpers ---------------------------------------------------------------

  private fun forbidPermission(name: String) {
    val permissions = collectPermissionNames(rootElement.getElementsByTagName("uses-permission"))
    assertFalse(
      "merged manifest must NOT declare uses-permission $name (found: $permissions)",
      permissions.contains(name),
    )
  }

  private fun requirePermission(name: String) {
    val permissions = collectPermissionNames(rootElement.getElementsByTagName("uses-permission"))
    assertTrue(
      "merged manifest must declare uses-permission $name (found: $permissions)",
      permissions.contains(name),
    )
  }

  private fun collectPermissionNames(nodes: NodeList): List<String> {
    return (0 until nodes.length).map {
      (nodes.item(it) as Element).getAttributeNS(ANDROID_NAMESPACE, "name")
    }
  }

  private fun assertContainsAction(filter: Element, action: String) {
    val actions = filter.getElementsByTagName("action")
    val found = (0 until actions.length).any {
      (actions.item(it) as Element).getAttributeNS(ANDROID_NAMESPACE, "name") == action
    }
    assertTrue("intent-filter must contain action $action", found)
  }

  private fun assertContainsCategory(filter: Element, category: String) {
    val categories = filter.getElementsByTagName("category")
    val found = (0 until categories.length).any {
      (categories.item(it) as Element).getAttributeNS(ANDROID_NAMESPACE, "name") == category
    }
    assertTrue("intent-filter must contain category $category", found)
  }

  companion object {
    private const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    private const val SYSTEM_FOREGROUND_SERVICE = "androidx.work.impl.foreground.SystemForegroundService"
  }
}
