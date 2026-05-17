# ProGuard / R8 keep rules for the Mosaic Android app.
#
# Debug builds do NOT minify (see build.gradle.kts), so these rules are mostly
# inert today. They become essential the first time we enable minification for
# release. Keeping them in place from v1 avoids the classic "first release
# crashes with UnsatisfiedLinkError" trap.

# JNA: keep generated structures, callbacks, library loaders, and the structure
# field reflection metadata that JNA relies on at runtime.
-keep class com.sun.jna.** { *; }
-keep interface com.sun.jna.** { *; }
-keepattributes *Annotation*
-keepclassmembers class * extends com.sun.jna.Structure {
    <fields>;
    <methods>;
}
-keepclassmembers interface * extends com.sun.jna.Library {
    <methods>;
}
-keepclassmembers interface * extends com.sun.jna.Callback {
    <methods>;
}

# Generated UniFFI Kotlin bindings: keep the entire `uniffi.mosaic_uniffi`
# package. The bindings rely on field-name reflection (`UniffiLib`, RustBuffer
# Structure subclasses, callback interfaces). Renaming any of these breaks
# the FFI at runtime.
-keep class uniffi.** { *; }
-keep class uniffi.mosaic_uniffi.** { *; }
-keep interface uniffi.mosaic_uniffi.** { *; }
-keepclassmembers class uniffi.mosaic_uniffi.** {
    <fields>;
    <methods>;
}
-keepclassmembers class uniffi.mosaic_uniffi.** { *; }
-keep class * implements uniffi.mosaic_uniffi.* { *; }

# App-side callback/serialization surfaces used around Room, sync, and manifest
# transport are safer to keep than to discover by a production-only R8 crash.
-keep class * extends androidx.room.RoomDatabase$Callback { *; }
-keep class org.mosaic.android.main.db.PrivacyValidationRoomCallback { *; }
-keep class org.mosaic.android.main.net.sync.** { *; }
-keep class org.mosaic.android.main.net.manifest.** { *; }
-keep class org.mosaic.android.main.net.dto.** { *; }

# AndroidX Activity / AppCompat keep rules are provided by their own consumer
# rules; nothing extra is required here.

# JNA pulls in java.awt.* references via com.sun.jna.platform.* (used for
# desktop platforms). Android does not ship java.awt, so R8 flags these as
# "missing class" errors during release minification. The references are
# never reached at runtime on Android because the platform-specific code
# paths are class-loaded only on Linux/macOS/Windows JREs. Suppress the
# warnings so :assembleRelease succeeds; do NOT add -keep rules here —
# we want R8 to drop the unreachable code, not retain it.
-dontwarn java.awt.**
-dontwarn javax.swing.**
-dontwarn com.sun.jna.platform.win32.**
-dontwarn com.sun.jna.platform.mac.**
-dontwarn com.sun.jna.platform.unix.**
