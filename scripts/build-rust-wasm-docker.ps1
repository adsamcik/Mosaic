#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deterministic Rust->WASM build via Docker (Windows-friendly).

.DESCRIPTION
    Closes sweep42-followup-wasm-determinism. Native rustc builds drift
    ~150 bytes between Windows hosts and Linux hosts even at the same
    pinned 1.93.1 toolchain. This wrapper runs the build inside the
    pinned mosaic-wasm-build:1.93.1 image (scripts/Dockerfile.wasm-build)
    so every contributor — and CI — produces the same bytes.

    Behavior:
      * Builds the image on first run (subsequent runs are cached).
      * Mounts the repo read/write at /work and runs
        scripts/build-rust-wasm.sh inside the container.
      * Emits artifacts to apps/web/src/generated/mosaic-wasm/ identical
        to what CI's Build Check job writes.

.EXAMPLE
    pwsh scripts/build-rust-wasm-docker.ps1

.EXAMPLE
    # Build with weak-kdf for fast E2E iteration.
    $env:MOSAIC_WASM_CARGO_FEATURES = 'weak-kdf'
    pwsh scripts/build-rust-wasm-docker.ps1
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptDir
$ImageTag = 'mosaic-wasm-build:1.93.1'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is required for deterministic WASM builds. Install Docker Desktop (Windows) or docker-ce (Linux)."
}

# Security guard (HIGH security-review-2026-05-20-02 + -03): reject weak-kdf
# builds that would land in the canonical production WASM path BEFORE we
# spin up the build container. Canonicalizes both sides to defeat `./`,
# `..`, trailing separators, absolute aliases, and symlinks.
$CanonicalOutDir = 'apps/web/src/generated/mosaic-wasm'
$ExpectedWeakOutDir = 'apps/web/src/generated/mosaic-wasm-test-weak'

function Resolve-MosaicCanonicalPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) {
        try {
            $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                if ($item.Target) {
                    $target = $item.Target
                    if (-not [System.IO.Path]::IsPathRooted($target)) {
                        $target = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $full) $target))
                    }
                    return [System.IO.Path]::GetFullPath($target)
                }
            }
            return $item.FullName
        }
        catch { return $full }
    }
    return $full
}

$RepoRootAbs = [System.IO.Path]::GetFullPath($ProjectRoot)
$CanonicalAbs = Resolve-MosaicCanonicalPath (Join-Path $RepoRootAbs $CanonicalOutDir)
$ExpectedWeakAbs = Resolve-MosaicCanonicalPath (Join-Path $RepoRootAbs $ExpectedWeakOutDir)

if ($env:MOSAIC_WASM_CARGO_FEATURES) {
    $featureList = ",$($env:MOSAIC_WASM_CARGO_FEATURES),"
    if ($featureList -like '*,weak-kdf,*') {
        $effectiveRaw = if ($env:MOSAIC_WASM_OUT_DIR) { $env:MOSAIC_WASM_OUT_DIR } else { $CanonicalOutDir }
        if ([System.IO.Path]::IsPathRooted($effectiveRaw)) {
            $effectiveInput = $effectiveRaw
        }
        else {
            $effectiveInput = Join-Path $RepoRootAbs $effectiveRaw
        }
        $effectiveAbs = Resolve-MosaicCanonicalPath $effectiveInput
        $cmp = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
            [System.StringComparison]::OrdinalIgnoreCase
        }
        else {
            [System.StringComparison]::Ordinal
        }
        if ([string]::Equals($effectiveAbs, $CanonicalAbs, $cmp)) {
            [Console]::Error.WriteLine("[ERROR] weak-kdf feature must NOT write to the canonical production path.")
            [Console]::Error.WriteLine("   canonical: $CanonicalAbs")
            [Console]::Error.WriteLine("   requested: $effectiveAbs (raw: $effectiveRaw)")
            exit 64
        }
        if (-not [string]::Equals($effectiveAbs, $ExpectedWeakAbs, $cmp)) {
            [Console]::Error.WriteLine("[ERROR] weak-kdf builds must write to $ExpectedWeakOutDir.")
            [Console]::Error.WriteLine("   expected: $ExpectedWeakAbs")
            [Console]::Error.WriteLine("   requested: $effectiveAbs (raw: $effectiveRaw)")
            exit 64
        }
    }
}

$inspect = docker image inspect $ImageTag 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[wasm-docker] image $ImageTag not found, building..." -ForegroundColor Yellow
    docker build -f (Join-Path $ScriptDir 'Dockerfile.wasm-build') -t $ImageTag $ScriptDir
    if ($LASTEXITCODE -ne 0) {
        throw "docker build failed"
    }
}

# Pass through MOSAIC_WASM_CARGO_FEATURES so callers can flip on
# weak-kdf for fast E2E builds without bypassing the deterministic
# wrapper.
$envArgs = @()
if ($env:MOSAIC_WASM_CARGO_FEATURES) {
    $envArgs += @('-e', "MOSAIC_WASM_CARGO_FEATURES=$($env:MOSAIC_WASM_CARGO_FEATURES)")
}
if ($env:MOSAIC_WASM_OUT_DIR) {
    $envArgs += @('-e', "MOSAIC_WASM_OUT_DIR=$($env:MOSAIC_WASM_OUT_DIR)")
}

Write-Host "[wasm-docker] running deterministic WASM build inside $ImageTag..." -ForegroundColor Cyan
docker run --rm `
    -v "${ProjectRoot}:/work" `
    @envArgs `
    $ImageTag
if ($LASTEXITCODE -ne 0) {
    throw "docker run failed"
}
