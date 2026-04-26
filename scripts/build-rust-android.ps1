#!/usr/bin/env pwsh

param(
    [string[]]$Abi = @("arm64-v8a", "x86_64")
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command cargo-ndk -ErrorAction SilentlyContinue)) {
    throw "cargo-ndk is required for Android Rust builds. Install it with: cargo install cargo-ndk --locked"
}

Push-Location $ProjectRoot

try {
    cargo ndk `
        --target $Abi `
        --output-dir "$ProjectRoot/target/android" `
        build -p mosaic-uniffi --release --locked
}
finally {
    Pop-Location
}
