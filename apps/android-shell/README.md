# Android Shell Foundation

This is a JVM-only Kotlin scaffold for Mosaic's future Android upload/import companion. It exists because the repository does not yet contain an Android/Gradle application, and this worktree should remain validateable without relying on unavailable Gradle or Android plugin setup.

The module contains only foundation contracts:

- separate server-authenticated and crypto-unlocked state;
- a Rust UniFFI bridge seam for account unlock/status/close/protocol version;
- a generated-UniFFI account bridge adapter/probe that maps stable Rust codes into Kotlin shell states;
- a media generation port stub for future media-tier integration;
- a Photo Picker immediate-read abstraction;
- privacy-safe upload queue records;
- foreground `dataSync` work policy defaults.

Run validation from the repository root:

```powershell
.\scripts\test-android-shell.ps1
```

Follow-up for the real Android module: introduce Gradle/Android scaffolding, generated UniFFI Kotlin bindings wired into `GeneratedRustAccountApi`, app manifest static policy tests, WorkManager wiring, and the media-tier-generation adapter. Do not add real upload/networking or codec work until those dependencies land.
