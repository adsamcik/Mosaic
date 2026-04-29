#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Build the Mosaic Android Gradle module (`apps/android-main`).

.DESCRIPTION
  Orchestrates the full Android pipeline:
    1. Builds the Rust UniFFI core for arm64-v8a + x86_64 ABIs and
       generates Kotlin bindings via `scripts/build-rust-android.ps1`.
    2. Runs `gradlew :apps:android-main:assembleDebug` to produce the APK.

  The Gradle pre-build task (`buildRustUniffiArtifacts`) also calls
  `build-rust-android.ps1` internally, so the explicit invocation here is
  primarily a fast-fail probe: if Rust compilation breaks, it is clearer
  to surface the cargo error directly than to discover it inside Gradle.

.PARAMETER SkipRust
  Skip the explicit `build-rust-android.ps1` invocation. Useful when the
  caller has already produced fresh Rust artifacts (e.g. CI orchestration).

.EXAMPLE
  ./scripts/build-android-main.ps1

.EXAMPLE
  ./scripts/build-android-main.ps1 -SkipRust
#>

param(
    [switch]$SkipRust
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipRust) {
    Write-Host "==> Building Rust UniFFI artifacts (Android targets + Kotlin bindings)" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "build-rust-android.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "build-rust-android.ps1 failed with exit code $LASTEXITCODE"
    }
}

Write-Host "==> Assembling apps/android-main (debug APK)" -ForegroundColor Cyan
$gradlew = Join-Path $ProjectRoot "gradlew.bat"
if (-not (Test-Path -LiteralPath $gradlew)) {
    throw "Gradle wrapper not found at $gradlew. Re-run from the repository root."
}

& $gradlew ":apps:android-main:assembleDebug" "--no-daemon" "--console=plain"
if ($LASTEXITCODE -ne 0) {
    throw "Gradle :apps:android-main:assembleDebug failed with exit code $LASTEXITCODE"
}

$apk = Join-Path $ProjectRoot "apps\android-main\build\outputs\apk\debug\android-main-debug.apk"
if (-not (Test-Path -LiteralPath $apk)) {
    throw "Expected APK not produced at $apk"
}

$size = (Get-Item $apk).Length
Write-Host ("APK: {0} ({1:N2} MB)" -f $apk, ($size / 1MB)) -ForegroundColor Green
