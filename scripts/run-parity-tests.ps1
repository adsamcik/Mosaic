Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    cargo test -p mosaic-parity-tests --features parity-tests --locked
}
finally {
    Pop-Location
}
