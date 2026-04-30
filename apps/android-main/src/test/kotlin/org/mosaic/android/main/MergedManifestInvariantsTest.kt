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

  // -- Lane D2 (SPEC-CrossPlatformHardening Android shell checklist) extensions --

  /**
   * Stronger version of the existing `systemForegroundServiceDeclaresDataSyncType`
   * test: assert the merged manifest declares exactly ONE service with
   * `foregroundServiceType="dataSync"`. Multiple dataSync services would mean
   * either a misconfigured `tools:node="merge"` directive or an unreviewed
   * additional foreground promotion, both of which expand the foreground-
   * privilege blast radius beyond AutoImportWorker.
   */
  @Test
  fun dataSyncForegroundServiceDeclaredExactlyOnce() {
    val services = applicationElement.getElementsByTagName("service")
    val dataSyncServices = (0 until services.length)
      .map { services.item(it) as Element }
      .filter { it.getAttributeNS(ANDROID_NAMESPACE, "foregroundServiceType") == "dataSync" }
    val names = dataSyncServices.map { it.getAttributeNS(ANDROID_NAMESPACE, "name") }
    assertEquals(
      "merged manifest must declare exactly one foregroundServiceType=dataSync service " +
        "(found: $names); ADR-007 scopes the promotion to AutoImportWorker via WorkManager's " +
        "SystemForegroundService and any extra dataSync promotion is unreviewed.",
      1,
      dataSyncServices.size,
    )
    assertEquals(
      "the single dataSync service must be WorkManager's SystemForegroundService",
      SYSTEM_FOREGROUND_SERVICE,
      names.first(),
    )
  }

  /**
   * No service in the merged manifest may be exported with
   * `android:exported="true"` unless it is permission-guarded. Mirrors the
   * existing provider / receiver export checks. SystemForegroundService is
   * non-exported by default in WorkManager's manifest, so this should pass
   * cleanly; the test exists to lock the invariant against a future
   * accidental `tools:node="replace"` that flips a service exported.
   *
   * Stronger guarantee for our own package: NO `org.mosaic.*` service is
   * allowed to be exported at all.
   */
  @Test
  fun applicationServicesAreNotExported() {
    val services = applicationElement.getElementsByTagName("service")
    val mosaicViolations = mutableListOf<String>()
    val unguardedExportedViolations = mutableListOf<String>()
    (0 until services.length).forEach { i ->
      val service = services.item(i) as Element
      val name = service.getAttributeNS(ANDROID_NAMESPACE, "name")
      val exported = service.getAttributeNS(ANDROID_NAMESPACE, "exported")
      if (name.startsWith("org.mosaic.") && exported == "true") {
        mosaicViolations += name
      }
      if (exported == "true") {
        val permission = service.getAttributeNS(ANDROID_NAMESPACE, "permission")
        if (permission.isBlank()) {
          unguardedExportedViolations += name
        }
      }
    }
    assertTrue(
      "no org.mosaic.* service may be exported (got: $mosaicViolations)",
      mosaicViolations.isEmpty(),
    )
    assertTrue(
      "any exported service must declare a permission attribute (unguarded: $unguardedExportedViolations)",
      unguardedExportedViolations.isEmpty(),
    )
  }

  /**
   * abiFilters in the AGP `build.gradle.kts` for this module must restrict
   * the shipped ABIs to arm64-v8a + x86_64 only. 32-bit ABIs (armeabi-v7a,
   * x86) are forbidden:
   *   1. `cargo-ndk` in `scripts/build-rust-android.{ps1,sh}` only produces
   *      arm64-v8a / x86_64; including a 32-bit filter would either ship an
   *      empty native dir (boot crash) or pull in a non-reviewed cross
   *      compile;
   *   2. dropping 32-bit halves attack surface for the JNA / native-side
   *      crypto code, matching the ".instructions.md" invariant
   *      "abiFilters restricted to `arm64-v8a` + `x86_64`. No 32-bit builds.".
   *
   * AGP merges abiFilters into the APK manifest only as `<uses-feature>`
   * elements (not as a string attribute), so the highest-fidelity enforce-
   * ment point is the source of `build.gradle.kts`. We parse it as plain
   * text and assert the declaration matches exactly the allowed pair.
   */
  @Test
  fun abiFiltersRestrictedToArm64AndX8664() {
    val gradleFile = locateModuleGradleFile()
    assertTrue(
      "build.gradle.kts must exist at ${gradleFile.absolutePath}",
      gradleFile.exists(),
    )
    val source = gradleFile.readText()

    // The declaration must include arm64-v8a and x86_64.
    val abiFiltersRegex = Regex("""abiFilters\s*\+=\s*listOf\(([^)]*)\)""")
    val match = abiFiltersRegex.find(source)
    assertNotNull(
      "build.gradle.kts must declare `abiFilters += listOf(\"arm64-v8a\", \"x86_64\")` " +
        "in the defaultConfig.ndk block; declaration not found",
      match,
    )
    val rawList = match!!.groupValues[1]
    val abis = Regex("""\"([^\"]+)\"""").findAll(rawList).map { it.groupValues[1] }.toSet()
    assertEquals(
      "abiFilters must be exactly {arm64-v8a, x86_64} (got: $abis)",
      setOf("arm64-v8a", "x86_64"),
      abis,
    )

    // 32-bit ABIs must not appear anywhere in the build script (defense-in-
    // depth against future blocks like `splits { abi { include(...) } }`).
    val forbiddenAbis = listOf("armeabi-v7a", "armeabi", "mips", "mips64")
    for (abi in forbiddenAbis) {
      assertFalse(
        "build.gradle.kts must not reference 32-bit / legacy ABI '$abi'",
        source.contains("\"$abi\""),
      )
    }
    // The bare token `"x86"` must not appear; only `"x86_64"` is allowed.
    // We use a regex with negative lookahead to avoid matching `"x86_64"`.
    val bareX86 = Regex("""\"x86(?!_64)\"""")
    assertFalse(
      "build.gradle.kts must not reference 32-bit ABI 'x86'",
      bareX86.containsMatchIn(source),
    )
  }

  private fun locateModuleGradleFile(): File {
    // Mirror the merged-manifest path resolution: the AGP test task sets
    // `user.dir` to the module root, so a plain relative path works.
    val direct = File("build.gradle.kts")
    if (direct.exists()) return direct
    return File(System.getProperty("user.dir"), "build.gradle.kts")
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
