#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Guard tests for HIGH security-review-2026-05-20-03 (path-alias bypass).

.DESCRIPTION
    Invokes scripts/build-rust-wasm.ps1 with MOSAIC_WASM_CARGO_FEATURES=weak-kdf
    and various crafted MOSAIC_WASM_OUT_DIR values that previously bypassed
    the raw-string guard. The guard fires BEFORE any cargo/wasm-bindgen tool
    check, so the script exits 64 immediately without a Rust toolchain.

    Run: pwsh scripts/__tests__/build-wasm-guard.test.ps1
#>

$ErrorActionPreference = 'Continue'
$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$BuildScript = Join-Path $RepoRoot 'scripts\build-rust-wasm.ps1'

if (-not (Test-Path $BuildScript)) {
    Write-Error "build-rust-wasm.ps1 not found at $BuildScript"
    exit 1
}

$Pass = 0
$Fail = 0

function Invoke-Case {
    param(
        [string]$Name,
        [int]$ExpectedExit,
        [string]$OutDir,
        [string]$Features = 'weak-kdf'
    )
    $env:MOSAIC_WASM_CARGO_FEATURES = $Features
    $env:MOSAIC_WASM_OUT_DIR = $OutDir
    try {
        & pwsh -NoProfile -File $BuildScript *> $null
        $actual = $LASTEXITCODE
    }
    finally {
        $env:MOSAIC_WASM_CARGO_FEATURES = $null
        $env:MOSAIC_WASM_OUT_DIR = $null
    }
    if ($actual -eq $ExpectedExit) {
        Write-Host "  PASS [$Name] exit=$actual (out_dir=$OutDir)"
        $script:Pass++
    }
    else {
        Write-Host "  FAIL [$Name] expected exit=$ExpectedExit got=$actual (out_dir=$OutDir)" -ForegroundColor Red
        $script:Fail++
    }
}

Write-Host "== Bypass-attempt cases (all should exit 64) =="

Invoke-Case -Name 'dot-segment'        -ExpectedExit 64 -OutDir 'apps/web/src/generated/./mosaic-wasm'
Invoke-Case -Name 'dotdot-traversal'   -ExpectedExit 64 -OutDir 'apps/web/src/generated/mosaic-wasm-test-weak/../mosaic-wasm'
Invoke-Case -Name 'trailing-slash'     -ExpectedExit 64 -OutDir 'apps/web/src/generated/mosaic-wasm/'
Invoke-Case -Name 'double-slash'       -ExpectedExit 64 -OutDir 'apps/web/src/generated//mosaic-wasm'
Invoke-Case -Name 'absolute-canonical' -ExpectedExit 64 -OutDir (Join-Path $RepoRoot 'apps/web/src/generated/mosaic-wasm')
Invoke-Case -Name 'wrong-weak-dir'     -ExpectedExit 64 -OutDir 'apps/web/src/generated/something-else'
Invoke-Case -Name 'backslash-variant'  -ExpectedExit 64 -OutDir 'apps\web\src\generated\.\mosaic-wasm'

Write-Host ""
Write-Host "== Legitimate-path guard acceptance (does NOT run cargo) =="
# Verify the guard alone accepts the legit weak path. We don't run the full
# build script (no cargo). Instead, we re-implement the guard comparison
# in-process to confirm the canonicalization logic accepts the expected dir.
$RepoRootAbs = [System.IO.Path]::GetFullPath($RepoRoot)
$CanonicalAbs = [System.IO.Path]::GetFullPath((Join-Path $RepoRootAbs 'apps/web/src/generated/mosaic-wasm'))
$ExpectedWeakAbs = [System.IO.Path]::GetFullPath((Join-Path $RepoRootAbs 'apps/web/src/generated/mosaic-wasm-test-weak'))
$legitRaw = 'apps/web/src/generated/mosaic-wasm-test-weak'
$legitAbs = [System.IO.Path]::GetFullPath((Join-Path $RepoRootAbs $legitRaw))
$cmp = if ($IsWindows -or $env:OS -eq 'Windows_NT') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
if ([string]::Equals($legitAbs, $CanonicalAbs, $cmp)) {
    Write-Host "  FAIL [legit-weak-path] resolves to canonical" -ForegroundColor Red
    $Fail++
}
elseif (-not [string]::Equals($legitAbs, $ExpectedWeakAbs, $cmp)) {
    Write-Host "  FAIL [legit-weak-path] does not resolve to expected weak dir" -ForegroundColor Red
    $Fail++
}
else {
    Write-Host "  PASS [legit-weak-path] resolves to expected weak dir"
    $Pass++
}

Write-Host ""
Write-Host "Results: $Pass passed, $Fail failed"
if ($Fail -gt 0) { exit 1 } else { exit 0 }
