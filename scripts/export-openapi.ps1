#!/usr/bin/env pwsh
# Exports the backend OpenAPI document to docs/openapi.json.
# Used locally and by the CI drift gate (.github/workflows/tests.yml).
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$target = Join-Path $repoRoot "docs\openapi.json"
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:ConnectionStrings__Default = "Data Source=:memory:"
dotnet run --project (Join-Path $repoRoot "apps\backend\Mosaic.Backend") -- --export-openapi $target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "OpenAPI exported to $target"
