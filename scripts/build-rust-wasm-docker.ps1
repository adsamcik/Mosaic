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

Write-Host "[wasm-docker] running deterministic WASM build inside $ImageTag..." -ForegroundColor Cyan
docker run --rm `
    -v "${ProjectRoot}:/work" `
    @envArgs `
    $ImageTag
if ($LASTEXITCODE -ne 0) {
    throw "docker run failed"
}
