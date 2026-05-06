@file:Suppress("UnstableApiUsage")

import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec
import org.gradle.api.GradleException
import org.gradle.api.execution.TaskExecutionGraph
import org.gradle.api.Action
import java.io.File
import java.util.Locale

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
  id("com.google.devtools.ksp") version "2.0.21-1.0.28"
}

// ---------------------------------------------------------------------------------------
// Path layout: this module consumes generated artifacts produced by
// `scripts/build-rust-android.{ps1,sh}`, which writes:
//   $repoRoot/target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt
//   $repoRoot/target/android/{arm64-v8a,x86_64}/libmosaic_uniffi.so
//   $repoRoot/target/release/{libmosaic_uniffi.so | mosaic_uniffi.dll | libmosaic_uniffi.dylib}
//
// Generated artifacts are not committed; the Rust build script must run before
// `:apps:android-main:assembleDebug` (`buildRustUniffiArtifacts` task below
// orchestrates this).
// ---------------------------------------------------------------------------------------

val repoRoot: File = rootDir
val rustAndroidArtifactsDir: File = repoRoot.resolve("target/android")
val rustHostReleaseDir: File = repoRoot.resolve("target/release")
val generatedKotlinDir: File = layout.buildDirectory.dir("generated/source/uniffi/main/kotlin").get().asFile
val generatedJniLibsDir: File = layout.buildDirectory.dir("generated/jniLibs").get().asFile
val crossClientVectorsFeature = "cross-client-vectors"
var rustUniffiCargoFeatures: String = ""

ksp {
  arg("room.schemaLocation", "$projectDir/schemas")
}

gradle.taskGraph.whenReady(
  object : Action<TaskExecutionGraph> {
    override fun execute(taskGraph: TaskExecutionGraph) {
      val hasTestTask = taskGraph.allTasks.any { task ->
        task.path.startsWith(":apps:android-main:") &&
          (
            task.name == "testDebugUnitTest" ||
              task.name == "compileDebugUnitTest" ||
              (task.name.endsWith("UnitTest") && task.path.startsWith(":apps:android-main:"))
          )
      }
      val hasProductionTask = taskGraph.allTasks.any { task ->
        task.path.startsWith(":apps:android-main:") &&
          (
            task.name == "assembleDebug" ||
              task.name == "assembleRelease" ||
              task.name.endsWith("Apk") ||
              task.name.endsWith("Aar")
          )
      }

      if (hasTestTask && hasProductionTask) {
        throw GradleException(
          "R-C5.5 invariant violation: cannot schedule both test and production tasks in same Gradle invocation. " +
            "Test tasks require '--features cross-client-vectors' which exports corpus-only UniFFI symbols " +
            "(verify_and_open_bundle_with_recipient_seed, derive_link_keys_from_raw_secret, derive_identity_from_raw_seed). " +
            "Running them together would either leak corpus symbols into the production APK or fail tests. " +
            "Run separately: './gradlew assembleDebug' THEN './gradlew testDebugUnitTest'.",
        )
      }

      // R-C5.5 Gradle hotfix invariant: production and cross-client-vector test builds
      // require different UniFFI symbol surfaces. Until the Rust Android build script
      // supports feature-specific artifact directories, fail fast on mixed graphs and
      // enable the corpus-only feature only for resolved JVM unit-test task graphs.
      rustUniffiCargoFeatures = if (hasTestTask) crossClientVectorsFeature else ""
      extra.set("rustUniffiCargoFeatures", rustUniffiCargoFeatures)
      if (rustUniffiCargoFeatures.isNotBlank()) {
        val existingRustFlags = System.getenv("RUSTFLAGS")?.takeIf { it.isNotBlank() }
        tasks.named("buildRustUniffiArtifacts", Exec::class).configure {
          environment(
            "RUSTFLAGS",
            listOfNotNull(existingRustFlags, "--cfg feature=\"$rustUniffiCargoFeatures\"").joinToString(" "),
          )
        }
      }
    }
  },
)

/**
 * Resolves the host-built `mosaic_uniffi` shared library path for JVM unit
 * tests. JNA's `Native.register(...)` (called by the generated UniFFI Kotlin
 * bindings) accepts either a bare library name or an absolute path. We pass
 * an absolute path via the `uniffi.component.mosaic_uniffi.libraryOverride`
 * system property so unit tests can exercise the real Rust core without
 * needing the library on the JVM `java.library.path`.
 */
fun hostUniffiLibraryPath(): File {
  val osName = System.getProperty("os.name", "").lowercase(Locale.ROOT)
  val name = when {
    osName.contains("windows") -> "mosaic_uniffi.dll"
    osName.contains("mac") || osName.contains("darwin") -> "libmosaic_uniffi.dylib"
    else -> "libmosaic_uniffi.so"
  }
  return rustHostReleaseDir.resolve(name)
}

android {
  namespace = "org.mosaic.android.main"
  compileSdk = 35

  defaultConfig {
    applicationId = "org.mosaic.android.main"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // Restrict native libs to the ABIs `cargo-ndk` produces in
    // `scripts/build-rust-android.{ps1,sh}`. No 32-bit builds are shipped.
    ndk {
      abiFilters += listOf("arm64-v8a", "x86_64")
    }
  }

  buildTypes {
    debug {
      isMinifyEnabled = false
    }
    release {
      // Release build is intentionally a placeholder for v1: it inherits debug
      // signing for now; minify is disabled until we ship a release keystore +
      // verified ProGuard/R8 keep rules for `uniffi.mosaic_uniffi.**`.
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  testOptions {
    unitTests {
      isIncludeAndroidResources = true
    }
  }

  // Generated UniFFI Kotlin bindings live under build/generated and are imported
  // as `import uniffi.mosaic_uniffi.*`. The native `.so` files live in the
  // generated jniLibs srcDir below. The android-shell foundation contracts are
  // brought in as an additional Kotlin source root so the same `Generated*Api`
  // interfaces and DTOs are reused by both modules — the shell remains
  // independently validateable via `scripts/test-android-shell.ps1`.
  sourceSets {
    getByName("main") {
      java.srcDirs(
        generatedKotlinDir,
        repoRoot.resolve("apps/android-shell/src/main/kotlin"),
      )
      jniLibs.srcDirs(generatedJniLibsDir)
    }
  }

  packaging {
    resources {
      excludes += listOf("META-INF/AL2.0", "META-INF/LGPL2.1")
    }
  }
}

dependencies {
  implementation(libs.androidx.activity)
  implementation(libs.androidx.appcompat)
  implementation(libs.androidx.core)
  implementation("androidx.room:room-runtime:2.6.1")
  implementation("androidx.room:room-ktx:2.6.1")
  ksp("androidx.room:room-compiler:2.6.1")
  // Tus upload foundation uses direct OkHttp PATCH/HEAD/POST protocol calls.
  // Maven Central has io.tus.java.client:tus-java-client:0.5.1, but no clear
  // maintained Android OkHttp-first artifact; keep OkHttp pinned for the A5a
  // spike and avoid adding a URLConnection-based Tus dependency.
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
  // WorkManager powers the auto-import foreground (`dataSync`) worker. See
  // `apps/android-main/src/main/kotlin/org/mosaic/android/main/work/`.
  implementation(libs.androidx.work.runtime)
  // JNA Android `aar` is required by the generated `uniffi.mosaic_uniffi` bindings.
  // The `@aar` classifier ensures Gradle pulls the Android-specific artifact
  // packaging `libjnidispatch.so` per ABI rather than the desktop JAR.
  implementation("net.java.dev.jna:jna:${libs.versions.jna.get()}@aar")

  // For JVM unit tests we need the *desktop* JNA JAR, which packages
  // `jnidispatch.dll` / `libjnidispatch.so` / `libjnidispatch.dylib` for
  // host operating systems. The `@aar` artifact only contains Android
  // jniLibs, so JVM tests would fail with `Native library
  // (com/sun/jna/<os>/jnidispatch.<ext>) not found in resource path`.
  testImplementation("net.java.dev.jna:jna:${libs.versions.jna.get()}")
  testImplementation(libs.junit4)
  testImplementation("androidx.room:room-testing:2.6.1")
  testImplementation("androidx.test:core-ktx:1.6.1")
  testImplementation(libs.androidx.work.testing)
  testImplementation("org.robolectric:robolectric:4.13")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
  testImplementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
  testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")

  androidTestImplementation(libs.androidx.test.junit)
  androidTestImplementation(libs.androidx.test.espresso)
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.rules)
  androidTestImplementation(libs.androidx.work.testing)
}

// ---------------------------------------------------------------------------------------
// Rust artifact wiring tasks
// ---------------------------------------------------------------------------------------

/**
 * Runs `scripts/build-rust-android.{ps1,sh}` to produce the cross-compiled `.so` files
 * and the host UniFFI Kotlin bindings. Inputs/outputs are declared so the task is
 * incremental and Gradle's configuration cache can reason about it.
 */
val buildRustUniffiArtifacts by tasks.registering(Exec::class) {
  group = "rust"
  description = "Builds mosaic-uniffi for Android ABIs and generates Kotlin bindings."

  workingDir = repoRoot

  val isWindows = System.getProperty("os.name", "").lowercase(Locale.ROOT).contains("windows")
  val script = if (isWindows) "scripts/build-rust-android.ps1" else "scripts/build-rust-android.sh"
  if (isWindows) {
    commandLine("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script)
  } else {
    commandLine("bash", script)
  }
  inputs.dir(repoRoot.resolve("crates/mosaic-uniffi/src"))
  inputs.file(repoRoot.resolve("crates/mosaic-uniffi/Cargo.toml"))
  inputs.file(repoRoot.resolve("Cargo.toml"))
  inputs.file(repoRoot.resolve("Cargo.lock"))
  inputs.file(repoRoot.resolve("rust-toolchain.toml"))
  outputs.upToDateWhen { false }

  outputs.dir(rustAndroidArtifactsDir)
  outputs.file(rustAndroidArtifactsDir.resolve("kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt"))
  outputs.file(rustAndroidArtifactsDir.resolve("arm64-v8a/libmosaic_uniffi.so"))
  outputs.file(rustAndroidArtifactsDir.resolve("x86_64/libmosaic_uniffi.so"))
  // The same script also produces the host library used by JVM tests via
  // `uniffi.component.mosaic_uniffi.libraryOverride`. Declaring it as an
  // explicit output makes Gradle re-run the task when the host artifact
  // is missing, even when Android `.so` outputs are still present.
  outputs.file(hostUniffiLibraryPath())
}

/** Copy the generated UniFFI Kotlin binding into a Gradle-owned generated source dir. */
val syncRustUniffiKotlin by tasks.registering(Copy::class) {
  group = "rust"
  description = "Copies generated UniFFI Kotlin bindings into the module's source set."
  dependsOn(buildRustUniffiArtifacts)

  from(rustAndroidArtifactsDir.resolve("kotlin"))
  into(generatedKotlinDir)
  include("**/*.kt")
}

/** Copy the cross-compiled native libraries into the module's jniLibs srcDir. */
val syncRustUniffiJniLibs by tasks.registering(Copy::class) {
  group = "rust"
  description = "Copies cross-compiled libmosaic_uniffi.so into the module's jniLibs srcDir."
  dependsOn(buildRustUniffiArtifacts)

  from(rustAndroidArtifactsDir) {
    include("arm64-v8a/libmosaic_uniffi.so")
    include("x86_64/libmosaic_uniffi.so")
  }
  into(generatedJniLibsDir)
}

afterEvaluate {
  // Hook the sync tasks into the AGP build graph so they run before Kotlin
  // compilation (for the generated source) and before native-lib merging (for
  // the .so files). We hook into `preBuild` which AGP guarantees runs before
  // both `compileDebugKotlin` and `mergeDebugNativeLibs`.
  tasks.named("preBuild") {
    dependsOn(syncRustUniffiKotlin, syncRustUniffiJniLibs)
  }
}

// ---------------------------------------------------------------------------------------
// JVM test wiring: load the host-built `mosaic_uniffi` shared library via the
// generated `uniffi.component.mosaic_uniffi.libraryOverride` system property so
// adapter unit tests round-trip through real Rust without needing an emulator.
// ---------------------------------------------------------------------------------------

tasks.withType<Test>().configureEach {
  // The host library is produced by the same `scripts/build-rust-android.{ps1,sh}`
  // invocation that `buildRustUniffiArtifacts` runs (it does both cargo-ndk
  // cross-compile AND a host `cargo build` for binding generation). Declaring
  // `dependsOn` here makes the dependency explicit for `:testDebugUnitTest`
  // even when running tests directly without first running `assembleDebug`.
  dependsOn(buildRustUniffiArtifacts)

  // The MergedManifestInvariantsTest reads the AGP-merged debug manifest at
  // `build/intermediates/merged_manifests/debug/processDebugManifest/`. AGP
  // does not produce that file as a transitive dep of `testDebugUnitTest`,
  // so we wire it explicitly. The `processDebugManifest` task name is a
  // stable AGP convention.
  if (name == "testDebugUnitTest") {
    dependsOn("processDebugManifest")
  }

  // Compute the host UniFFI library path at configuration time so the
  // configuration cache can serialize the value (closures referencing
  // script-level functions are NOT serializable).
  val libraryPath: String = hostUniffiLibraryPath().absolutePath
  systemProperty("uniffi.component.mosaic_uniffi.libraryOverride", libraryPath)
}
