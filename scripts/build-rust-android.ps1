#!/usr/bin/env pwsh

param(
    [ValidateSet("arm64-v8a", "armeabi-v7a", "x86", "x86_64")]
    [string[]]$Abi = @("arm64-v8a", "x86_64")
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CargoNdkVersion = "4.1.2"
$UniffiVersion = "0.31.1"

if (-not (Get-Command cargo-ndk -ErrorAction SilentlyContinue)) {
    throw "cargo-ndk is required for Android Rust builds. Install it with: cargo install cargo-ndk --version $CargoNdkVersion --locked"
}

$cargoNdkVersionOutput = cargo ndk --version
if ($cargoNdkVersionOutput -notmatch "cargo-ndk\s+([0-9]+\.[0-9]+\.[0-9]+)") {
    throw "Unable to parse cargo-ndk version from: $cargoNdkVersionOutput"
}

if ($Matches[1] -ne $CargoNdkVersion) {
    throw "cargo-ndk version mismatch: expected $CargoNdkVersion, got $($Matches[1])"
}

if (-not (Get-Command uniffi-bindgen -ErrorAction SilentlyContinue)) {
    throw "uniffi-bindgen is required for Kotlin bindings. Install it with: cargo install uniffi --features cli --version $UniffiVersion --locked"
}

$uniffiVersionOutput = uniffi-bindgen --version
if ($uniffiVersionOutput -notmatch "uniffi-bindgen\s+([0-9]+\.[0-9]+\.[0-9]+)") {
    throw "Unable to parse uniffi-bindgen version from: $uniffiVersionOutput"
}

if ($Matches[1] -ne $UniffiVersion) {
    throw "uniffi-bindgen version mismatch: expected $UniffiVersion, got $($Matches[1])"
}

Push-Location $ProjectRoot

try {
    $cargoNdkTargets = @()
    foreach ($targetAbi in $Abi) {
        $cargoNdkTargets += "--target"
        $cargoNdkTargets += $targetAbi
    }

    cargo ndk `
        @cargoNdkTargets `
        --output-dir "$ProjectRoot/target/android" `
        build -p mosaic-uniffi --release --locked

    cargo build -p mosaic-uniffi --release --locked

    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
        $hostLibraryPath = Join-Path $ProjectRoot "target/release/mosaic_uniffi.dll"
    }
    elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) {
        $hostLibraryPath = Join-Path $ProjectRoot "target/release/libmosaic_uniffi.dylib"
    }
    else {
        $hostLibraryPath = Join-Path $ProjectRoot "target/release/libmosaic_uniffi.so"
    }

    $kotlinOutDir = Join-Path $ProjectRoot "target/android/kotlin"
    Remove-Item -Recurse -Force -Path $kotlinOutDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $kotlinOutDir | Out-Null
    uniffi-bindgen generate `
        --language kotlin `
        --out-dir $kotlinOutDir `
        --no-format `
        --library `
        --crate mosaic_uniffi `
        $hostLibraryPath

    if (-not (Get-ChildItem -Path $kotlinOutDir -Filter "*.kt" -File -Recurse)) {
        throw "UniFFI Kotlin binding generation produced no .kt files in $kotlinOutDir"
    }
}
finally {
    Pop-Location
}
