#!/usr/bin/env pwsh

param(
    [switch]$SkipSupplyChain
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Command

    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Assert-RequiredTool {
    param(
        [string]$CommandName
    )

    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "$CommandName is required. Install it with: cargo install $CommandName --locked"
    }
}

Push-Location $ProjectRoot

try {
    Invoke-Step "Rust format" { cargo fmt --all --check }
    Invoke-Step "Rust clippy" { cargo clippy --workspace --all-targets --all-features -- -D warnings }
    Invoke-Step "Rust tests" { cargo test --workspace --locked }
    Invoke-Step "Rust architecture boundaries" { & "$ProjectRoot/tests/architecture/rust-boundaries.ps1" }

    # NOTE: Web boundary guard (Band 7 / Lane D1) is intentionally NOT run
    # here because this script is the Rust check. Future Band 8 readiness
    # should also invoke:
    #   pwsh tests/architecture/web-no-direct-console.ps1
    # which keeps direct `console.*` calls out of the high-risk web
    # crypto/storage/upload boundaries (see docs/SECURITY.md
    # "Web hardening static guards").

    if (-not $SkipSupplyChain) {
        Assert-RequiredTool "cargo-deny"
        Assert-RequiredTool "cargo-audit"
        Assert-RequiredTool "cargo-vet"
        Invoke-Step "Rust dependency policy" { cargo deny check }
        Invoke-Step "Rust advisory audit" { cargo audit }
        Invoke-Step "Rust cargo-vet policy" { cargo vet }
    }
}
finally {
    Pop-Location
}
