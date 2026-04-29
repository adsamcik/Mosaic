package org.mosaic.android.main.bridge

import org.junit.Test
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertEquals

/**
 * JVM-only unit test that verifies adapter classes compile cleanly against the
 * generated UniFFI bindings. Does NOT load the native library: the adapter
 * `init` blocks call `AndroidRustCoreLibraryLoader.warmUp()`, which would
 * attempt JNA `Native.register("mosaic_uniffi")` on a host that has no
 * matching native library. We therefore only verify that the classes resolve
 * (Kotlin compilation), and that the generated UniFFI Kotlin types referenced
 * by the adapters exist with the expected shape.
 *
 * Real end-to-end testing of the FFI happens in `androidTest/RustCoreSmokeTest.kt`
 * on an emulator with the real `libmosaic_uniffi.so` packaged in the APK.
 */
class AdapterCompilationContractTest {

  @Test
  fun adapterClassesResolve() {
    // KClass references prove that the adapter classes compiled and resolve
    // their generated UniFFI dependencies at JVM class-load time. We never
    // call any constructor — calling them would trigger JNA library load.
    val adapters = listOf(
      AndroidRustAccountApi::class.java,
      AndroidRustHeaderApi::class.java,
      AndroidRustProgressApi::class.java,
      AndroidRustIdentityApi::class.java,
      AndroidRustEpochApi::class.java,
      AndroidRustShardApi::class.java,
      AndroidRustMediaApi::class.java,
      AndroidRustMetadataSidecarApi::class.java,
      AndroidRustDiagnosticsApi::class.java,
      AndroidRustUploadApi::class.java,
      AndroidRustAlbumSyncApi::class.java,
    )
    assertEquals(11, adapters.size)
    adapters.forEach { assertNotNull(it.simpleName, it) }
  }

  @Test
  fun libraryLoaderClassResolves() {
    // Library loader exists and is an object. Triggering warmUp() requires the
    // native lib, which isn't present on the JVM test host; we deliberately
    // skip that here.
    assertNotNull(AndroidRustCoreLibraryLoader::class.java)
  }
}
