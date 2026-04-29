#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run JVM unit tests for the Mosaic Android Gradle module (`apps/android-main`).

.DESCRIPTION
  Runs `gradlew :apps:android-main:testDebugUnitTest`. These tests run on the
  JVM (no emulator) and exercise:
    - Adapter class compilation against generated UniFFI bindings.
    - Compile-time wiring between `AndroidRust*Api` adapters and the shell's
      `GeneratedRust*Api` interfaces.

  Instrumented tests (`androidTest/`) require a running emulator and are not
  invoked here; see `scripts/test-android-main-instrumented.{ps1,sh}` (TBD).
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$gradlew = Join-Path $ProjectRoot "gradlew.bat"
if (-not (Test-Path -LiteralPath $gradlew)) {
    throw "Gradle wrapper not found at $gradlew. Re-run from the repository root."
}

Write-Host "==> Running apps/android-main JVM unit tests" -ForegroundColor Cyan
& $gradlew ":apps:android-main:testDebugUnitTest" "--no-daemon" "--console=plain"
if ($LASTEXITCODE -ne 0) {
    throw "Gradle :apps:android-main:testDebugUnitTest failed with exit code $LASTEXITCODE"
}

Write-Host "==> apps/android-main JVM tests green" -ForegroundColor Green
