@file:Suppress("UnstableApiUsage")

import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec
import java.io.File
import java.util.Locale

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
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
val generatedKotlinDir: File = layout.buildDirectory.dir("generated/source/uniffi/main/kotlin").get().asFile
val generatedJniLibsDir: File = layout.buildDirectory.dir("generated/jniLibs").get().asFile

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
  // JNA Android `aar` is required by the generated `uniffi.mosaic_uniffi` bindings.
  // The `@aar` classifier ensures Gradle pulls the Android-specific artifact
  // packaging `libjnidispatch.so` per ABI rather than the desktop JAR.
  implementation("net.java.dev.jna:jna:${libs.versions.jna.get()}@aar")

  testImplementation(libs.junit4)

  androidTestImplementation(libs.androidx.test.junit)
  androidTestImplementation(libs.androidx.test.espresso)
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

  outputs.dir(rustAndroidArtifactsDir)
  outputs.file(rustAndroidArtifactsDir.resolve("kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt"))
  outputs.file(rustAndroidArtifactsDir.resolve("arm64-v8a/libmosaic_uniffi.so"))
  outputs.file(rustAndroidArtifactsDir.resolve("x86_64/libmosaic_uniffi.so"))
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
