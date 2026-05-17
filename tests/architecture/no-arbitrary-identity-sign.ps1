#!/usr/bin/env pwsh
# Architecture guard: no-arbitrary-identity-sign (v1.0.1 f14-1).
# PowerShell mirror of tests/architecture/no-arbitrary-identity-sign.sh.
# See the .sh script for the full threat-model rationale.

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Push-Location $ProjectRoot
try {
    $python = Get-Command python3 -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $python) {
        Write-Error "python3 (or python) required for no-arbitrary-identity-sign guard"
        exit 1
    }
    & $python.Source (Join-Path $ScriptDir 'no-arbitrary-identity-sign.py')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
