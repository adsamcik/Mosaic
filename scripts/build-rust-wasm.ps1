#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WasmBindgenVersion = "0.2.118"

Push-Location $ProjectRoot

try {
    $installedTargets = rustup target list --installed
    if ($installedTargets -notcontains "wasm32-unknown-unknown") {
        rustup target add wasm32-unknown-unknown
    }

    if (-not (Get-Command wasm-bindgen -ErrorAction SilentlyContinue)) {
        throw "wasm-bindgen CLI is required. Install it with: cargo install wasm-bindgen-cli --version $WasmBindgenVersion --locked"
    }

    $versionOutput = wasm-bindgen --version
    if ($versionOutput -notmatch "wasm-bindgen\s+([0-9]+\.[0-9]+\.[0-9]+)") {
        throw "Unable to parse wasm-bindgen version from: $versionOutput"
    }

    if ($Matches[1] -ne $WasmBindgenVersion) {
        throw "wasm-bindgen CLI version mismatch: expected $WasmBindgenVersion, got $($Matches[1])"
    }

    cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked

    $OutDir = Join-Path $ProjectRoot "target/wasm-bindgen/mosaic-wasm"
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    wasm-bindgen `
        --target web `
        --out-dir $OutDir `
        "$ProjectRoot/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"

    $WebOutDir = Join-Path $ProjectRoot "apps/web/src/generated/mosaic-wasm"
    New-Item -ItemType Directory -Force -Path $WebOutDir | Out-Null
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.js") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.d.ts") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm.d.ts") -Destination $WebOutDir
}
finally {
    Pop-Location
}
