$ErrorActionPreference = 'Stop'

$dryRun = $false
$remaining = @()
foreach ($arg in $args) {
    switch ($arg) {
        '--dry-run' { $dryRun = $true; continue }
        '-DryRun' { $dryRun = $true; continue }
        default { $remaining += $arg }
    }
}

if ($remaining.Count -gt 0) {
    Write-Error "Unknown argument(s): $($remaining -join ', ')"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$benchPath = Join-Path $repoRoot 'crates\mosaic-crypto\benches\throughput.rs'
$packageManifest = Join-Path $repoRoot 'crates\mosaic-crypto\Cargo.toml'

$budgets = @(
    [pscustomobject]@{ Name = 'Per-shard XChaCha20-Poly1305 encrypt'; Budget = '>= 200 MB/s'; Harness = $benchPath },
    [pscustomobject]@{ Name = 'Streaming R-C4 v0x04 encrypt'; Budget = '>= 150 MB/s'; Harness = $benchPath },
    [pscustomobject]@{ Name = 'Web cold start'; Budget = '< 2 s'; Harness = 'Perf trace / Playwright metric capture' },
    [pscustomobject]@{ Name = 'Android cold start'; Budget = '< 3 s'; Harness = 'Android startup metric' },
    [pscustomobject]@{ Name = 'Android heap'; Budget = '<= 4 GB'; Harness = 'Android memory metric' },
    [pscustomobject]@{ Name = 'Web tab upload memory'; Budget = '< 500 MB'; Harness = 'Browser memory sampling' },
    [pscustomobject]@{ Name = 'Tus initiate handshake'; Budget = '< 500 ms p95'; Harness = 'API timing metric' },
    [pscustomobject]@{ Name = 'Tus resume after disconnect'; Budget = '< 2 s'; Harness = 'E2E/API timing metric' }
)

Write-Host 'Mosaic v1 performance budgets'
$budgets | Format-Table -AutoSize | Out-String | Write-Host

if ($dryRun) {
    Write-Host 'Dry run requested; no benchmarks executed.'
    if (Test-Path $benchPath) {
        Write-Host "Detected crypto throughput bench: $benchPath"
        Write-Host 'Non-dry-run would execute: cargo bench -p mosaic-crypto --bench throughput -- --noplot'
    } else {
        Write-Host "Crypto throughput bench not present: $benchPath"
        Write-Host 'Q-final-4 ships declared budgets only; automated throughput gating is deferred until the bench harness lands.'
    }
    exit 0
}

if (!(Test-Path $packageManifest)) {
    Write-Error "mosaic-crypto package manifest not found: $packageManifest"
}

if (!(Test-Path $benchPath)) {
    Write-Error "Crypto throughput bench not found: $benchPath. Run with --dry-run to inspect declared budgets, or add the bench harness before enforcing perf budgets."
}

Push-Location $repoRoot
try {
    cargo bench -p mosaic-crypto --bench throughput -- --noplot
} finally {
    Pop-Location
}
