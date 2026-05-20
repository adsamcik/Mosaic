#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WasmBindgenVersion = "0.2.118"

Push-Location $ProjectRoot

try {
    # Security guard (HIGH security-review-2026-05-20-02): weak-kdf feature
    # MUST NOT write into the canonical production WASM path. See
    # scripts/build-rust-wasm.sh for the matching guard.
    $CanonicalOutDir = 'apps/web/src/generated/mosaic-wasm'
    $ExpectedWeakOutDir = 'apps/web/src/generated/mosaic-wasm-test-weak'
    if ($env:MOSAIC_WASM_CARGO_FEATURES) {
        $featureList = ",$($env:MOSAIC_WASM_CARGO_FEATURES),"
        if ($featureList -like '*,weak-kdf,*') {
            $effectiveOutDir = if ($env:MOSAIC_WASM_OUT_DIR) { $env:MOSAIC_WASM_OUT_DIR } else { $CanonicalOutDir }
            if ($effectiveOutDir -eq $CanonicalOutDir) {
                Write-Error "❌ weak-kdf feature requires MOSAIC_WASM_OUT_DIR=$ExpectedWeakOutDir.`n   Writing weak-kdf bytes into the canonical production path would undermine`n   the production crypto floor (security-review-2026-05-20-02)."
                exit 64
            }
            if ($effectiveOutDir -ne $ExpectedWeakOutDir) {
                Write-Warning "MOSAIC_WASM_OUT_DIR=$effectiveOutDir for weak-kdf build — recommended path is $ExpectedWeakOutDir"
            }
        }
    }

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

    # Deterministic WASM artifacts across hosts (Windows MSVC vs Linux):
    # --remap-path-prefix collapses absolute build paths into stable
    # relative tokens so embedded path strings do not leak the host
    # filesystem layout or host target triple. Combined with
    # `lto = "fat"` + `codegen-units = 1` in [profile.release]
    # (Cargo.toml), the wasm-rebuild-invariance CI job sees byte-identical
    # bytes regardless of runner host.
    $RustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { try { rustup show home } catch { Join-Path $env:USERPROFILE ".rustup" } }
    $CargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
    $RustVersionLine = rustc -V
    $RustVersion = if ($RustVersionLine -match "rustc\s+(\S+)") { $Matches[1] } else { "" }
    $HostTriple = (rustc -Vv | Select-String "^host:" | ForEach-Object { $_.Line -split "\s+" } | Select-Object -Last 1)
    $ToolchainDir = Join-Path $RustupHome "toolchains/$RustVersion-$HostTriple"
    $ChannelToolchainDir = Join-Path $RustupHome "toolchains/$RustVersion"
    $Remap = @(
        "--remap-path-prefix=$ProjectRoot=mosaic"
        "--remap-path-prefix=$CargoHome=cargo-home"
        "--remap-path-prefix=$ToolchainDir=rust-toolchain"
        "--remap-path-prefix=$ChannelToolchainDir=rust-toolchain"
        "--remap-path-prefix=$RustupHome=rustup-home"
    ) -join ' '

    $PreviousRustFlags = $env:RUSTFLAGS
    try {
        $env:RUSTFLAGS = if ($PreviousRustFlags) { "$PreviousRustFlags $Remap" } else { $Remap }
        cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked
    }
    finally {
        if ($null -eq $PreviousRustFlags) {
            Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
        }
        else {
            $env:RUSTFLAGS = $PreviousRustFlags
        }
    }

    $OutDir = Join-Path $ProjectRoot "target/wasm-bindgen/mosaic-wasm"
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    wasm-bindgen `
        --target web `
        --out-dir $OutDir `
        "$ProjectRoot/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"

    # Output directory inside the web app. Defaults to the canonical
    # production path; can be overridden (e.g. for the test-only weak-kdf
    # artifact at apps/web/src/generated/mosaic-wasm-test-weak). Override
    # is interpreted relative to $ProjectRoot when given as a relative path.
    $OutSubpath = if ($env:MOSAIC_WASM_OUT_DIR) { $env:MOSAIC_WASM_OUT_DIR } else { 'apps/web/src/generated/mosaic-wasm' }
    if ([System.IO.Path]::IsPathRooted($OutSubpath)) {
        $WebOutDir = $OutSubpath
    } else {
        $WebOutDir = Join-Path $ProjectRoot $OutSubpath
    }
    New-Item -ItemType Directory -Force -Path $WebOutDir | Out-Null
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.js") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.d.ts") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm.d.ts") -Destination $WebOutDir
}
finally {
    Pop-Location
}
