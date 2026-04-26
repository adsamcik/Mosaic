#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot

try {
    rustup target add wasm32-unknown-unknown
    cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked

    if (Get-Command wasm-bindgen -ErrorAction SilentlyContinue) {
        $OutDir = Join-Path $ProjectRoot "target/wasm-bindgen/mosaic-wasm"
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        wasm-bindgen `
            --target web `
            --out-dir $OutDir `
            "$ProjectRoot/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"
    }
    else {
        Write-Warning "wasm-bindgen is not installed; generated JS bindings were skipped."
    }
}
finally {
    Pop-Location
}
