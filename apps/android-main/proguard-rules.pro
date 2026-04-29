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
-keep class uniffi.mosaic_uniffi.** { *; }
-keep interface uniffi.mosaic_uniffi.** { *; }
-keepclassmembers class uniffi.mosaic_uniffi.** {
    <fields>;
    <methods>;
}

# AndroidX Activity / AppCompat keep rules are provided by their own consumer
# rules; nothing extra is required here.
