#requires -Version 7
# Web direct-console architecture guard.
#
# Implements the "Secret, PII, and Log Redaction Rules" web slice of
# docs/specs/SPEC-CrossPlatformHardening.md (lines ~111-113):
#
#   "Web production code uses the centralized logger only; no `console.*`
#    calls in high-risk crypto/storage/upload boundaries."
#
# This script walks the high-risk web boundary directories listed below
# and FAILS if any production source file uses `console.log`,
# `console.warn`, `console.error`, `console.info`, `console.debug`, or
# `console.trace`. The single allowed callsite is
# `apps/web/src/lib/logger.ts` itself (the centralized logger).
#
# Exit code 0 if clean, 1 if any violation. Mirrors
# `tests/architecture/rust-boundaries.ps1` and
# `tests/architecture/kotlin-raw-input-ffi.ps1` conventions.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

# High-risk roots — boundaries where a `console.*` regression would
# bypass the centralized logger's redaction guarantees and risk leaking
# secrets / PII / raw URIs / plaintext metadata.
#
# Each entry is `{ Path; Recurse; Filter }`. `Filter = $null` means take
# every .ts / .tsx file directly inside Path (not recursively); a
# pattern (e.g. '*-service.ts') restricts to matching files.
$HighRiskTargets = @(
    @{ Path = 'apps/web/src/workers'; Recurse = $true; Filter = $null }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = '*-service.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'sync-engine.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'sync-coordinator.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'sync-coordinator.tsx' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'shared-album-download.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'local-purge.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'api.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'key-cache.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'epoch-key-store.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'epoch-key-service.ts' }
    @{ Path = 'apps/web/src/lib'; Recurse = $false; Filter = 'epoch-rotation-service.ts' }
    @{ Path = 'apps/web/src/contexts'; Recurse = $false; Filter = 'SyncContext.tsx' }
    @{ Path = 'apps/web/src/contexts'; Recurse = $false; Filter = 'AlbumContentContext.tsx' }
)

# Files / paths that are exempt from the guard. The centralized logger
# is the sanctioned `console.*` callsite; tests and dev scripts are
# always allowed. Patterns are matched against the relative POSIX-style
# path of each candidate file with `-like`.
$AllowedPatterns = @(
    '*/__tests__/*',
    '*.test.ts',
    '*.test.tsx',
    '*/scripts/*',
    'apps/web/src/lib/logger.ts'
)

$ConsolePattern = '\bconsole\.(log|warn|error|info|debug|trace)\s*\('

function Test-Allowed {
    param([string]$RelativePath)
    foreach ($pattern in $AllowedPatterns) {
        if ($RelativePath -like $pattern) { return $true }
    }
    return $false
}

function Get-CandidateFiles {
    param([hashtable]$Target)
    $path = $Target.Path
    if (-not (Test-Path $path)) { return @() }

    $params = @{ Path = $path; ErrorAction = 'SilentlyContinue'; File = $true }
    if ($Target.Recurse) { $params.Recurse = $true }
    if ($Target.Filter) {
        $params.Filter = $Target.Filter
    }

    $files = Get-ChildItem @params
    if (-not $Target.Filter) {
        # Default to TypeScript sources only when no explicit filter is set.
        $files = $files | Where-Object { $_.Extension -in @('.ts', '.tsx') }
    }
    return $files
}

function ConvertTo-RelativePosix {
    param([string]$FullPath)
    $rel = [System.IO.Path]::GetRelativePath($ProjectRoot, $FullPath)
    return $rel -replace '\\', '/'
}

$violations = New-Object System.Collections.Generic.List[string]

foreach ($target in $HighRiskTargets) {
    $candidates = Get-CandidateFiles -Target $target
    foreach ($file in $candidates) {
        $relative = ConvertTo-RelativePosix -FullPath $file.FullName
        if (Test-Allowed -RelativePath $relative) { continue }

        $lineNumber = 0
        foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
            $lineNumber++
            if ($line -match $ConsolePattern) {
                # Skip eslint-disable lines and trimmed comment lines that
                # are talking ABOUT console.* (e.g. doc strings inside
                # `.instructions.md` examples) — only flag executable code.
                $trimmed = $line.TrimStart()
                if ($trimmed.StartsWith('//') -or $trimmed.StartsWith('*') -or $trimmed.StartsWith('/*')) {
                    continue
                }
                $violations.Add("${relative}:${lineNumber}: $($line.Trim())")
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ""
    Write-Host "VIOLATION: direct console.* call(s) found in high-risk web boundary code." -ForegroundColor Red
    Write-Host "Use the centralized logger from apps/web/src/lib/logger.ts instead." -ForegroundColor Red
    Write-Host ""
    foreach ($v in $violations) {
        Write-Host "  $v"
    }
    Write-Host ""
    Write-Error "web-no-direct-console guard found $($violations.Count) violation(s)."
    exit 1
}

Write-Host "web-no-direct-console guard: OK (no direct console.* calls in high-risk web boundaries)"
exit 0
