#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $ProjectRoot

try {
    $metadata = cargo metadata --format-version=1 --no-deps | ConvertFrom-Json
    $packages = @{}
    foreach ($package in $metadata.packages) {
        if ($package.name -like "mosaic-*") {
            $packages[$package.name] = $package
        }
    }

    $expected = @(
        "mosaic-domain",
        "mosaic-crypto",
        "mosaic-client",
        "mosaic-media",
        "mosaic-wasm",
        "mosaic-uniffi",
        "mosaic-vectors"
    )

    foreach ($name in $expected) {
        if (-not $packages.ContainsKey($name)) {
            throw "Missing Rust workspace package: $name"
        }
    }

    $allowed = @{
        "mosaic-domain" = @()
        "mosaic-crypto" = @("mosaic-domain")
        "mosaic-client" = @("mosaic-domain", "mosaic-crypto")
        "mosaic-media" = @("mosaic-domain")
        "mosaic-wasm" = @("mosaic-domain", "mosaic-crypto", "mosaic-client", "mosaic-media", "mosaic-vectors")
        "mosaic-uniffi" = @("mosaic-domain", "mosaic-crypto", "mosaic-client", "mosaic-media", "mosaic-vectors")
        "mosaic-vectors" = @("mosaic-domain", "mosaic-crypto")
    }

    foreach ($packageName in $expected) {
        $package = $packages[$packageName]
        $allowedDeps = $allowed[$packageName]

        foreach ($dependency in $package.dependencies) {
            $depName = $dependency.name
            if ($depName -like "mosaic-*" -and $allowedDeps -notcontains $depName) {
                throw "$packageName must not depend on $depName"
            }
        }
    }

    Write-Host "Rust architecture boundary checks passed."
}
finally {
    Pop-Location
}
