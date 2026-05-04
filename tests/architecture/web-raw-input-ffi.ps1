#requires -Version 7
# Web raw-input WASM FFI consumer-side architecture guard.
#
# `no-raw-secret-ffi-export` is the primary producer-side defense: production
# Rust/WASM must not export raw-secret-shaped APIs. This guard is the
# consumer-side defense-in-depth layer. It prevents web TypeScript from
# importing or calling known raw-input bridge names from the WASM package or
# generated wasm-bindgen module if a future test/vector-only bridge is added.
#
# Allowlist policy: only cross-client vector/spec test drivers may consume
# raw-input bridges. Production files in apps/web/src/ are never allowlisted;
# src-local test files are excluded from the production scan, mirroring the
# Kotlin guard's src/main-only semantics.
#
# Allowlist audit checkpoint:
# Last full audit: R-C5.5 at 5bc477d
# Each allowlist entry below MUST carry a SPECIFIC cryptographic safety
# argument as its rationale comment. "Reviewed existing API" / "Internal
# use" / "Not a secret" are NOT acceptable rationales. Audits should be
# repeated whenever an entry is added; v1 freeze checkpoint should re-run
# this audit.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ForbiddenNames = @(
  'verifyAndOpenBundle',
  'sealAndSignBundle',
  'importEpochKeyHandleFromBundle',
  'getTierKeyFromEpoch',
  'deriveContentKeyFromEpoch',
  'wrapKey',
  'unwrapKey',
  'deriveDbSessionKeyFromAccount',
  'generateLinkSecret',
  'deriveLinkKeys',
  'wrapTierKeyForLink',
  'unwrapTierKeyFromLink',
  'verify_and_open_bundle',
  'seal_and_sign_bundle',
  'seal_and_sign_bundle_js',
  'import_epoch_key_handle_from_bundle',
  'import_epoch_key_handle_from_bundle_js'
)

$FutureRawBridgeNamePattern = '\b[A-Za-z_$][A-Za-z0-9_$]*(RawSecret|ForVectors)[A-Za-z0-9_$]*\b'
$ImportPattern = '(?ms)import\s+(?:type\s+)?(?<clause>.*?)\s+from\s+[''"](?<module>[^''"]+)[''"]'
$TargetModulePattern = '^(?:@mosaic/wasm|mosaic-wasm)$|(?:^|/)generated/mosaic-wasm/mosaic_wasm(?:\.js)?$'
$NamespaceImportPattern = '\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b'

$AllowlistedFiles = @(
  # Test-only cross-client vector driver is excluded from production src; it exercises raw-input bridges against public corpora.
  'apps/web/tests/cross-client-vectors.test.ts'
)

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Test-IsAllowed([string]$RepoPath) {
  return $AllowlistedFiles -contains $RepoPath
}

function Test-IsProductionSource([string]$RepoPath) {
  if ($RepoPath -notmatch '^apps/web/src/') { return $false }
  if ($RepoPath -match '^apps/web/src/generated/') { return $false }
  if ($RepoPath -match '(^|/)__tests__/') { return $false }
  if ($RepoPath -match '\.(test|spec)\.tsx?$') { return $false }
  return $true
}

function Find-WebTypeScriptFiles {
  $roots = @('apps/web/src', 'apps/web/tests')
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem -Path $root -Recurse -File -Include '*.ts', '*.tsx' -ErrorAction SilentlyContinue
  }
}

$violations = New-Object System.Collections.Generic.List[string]

foreach ($fileInfo in Find-WebTypeScriptFiles) {
  $repoPath = Convert-ToRepoPath $fileInfo.FullName
  if (Test-IsAllowed $repoPath) { continue }
  if (-not (Test-IsProductionSource $repoPath) -and $repoPath -notmatch '^apps/web/tests/') { continue }

  $contents = Get-Content -Path $fileInfo.FullName -Raw -ErrorAction Stop
  if ($null -eq $contents) { $contents = '' }
  $matches = [regex]::Matches($contents, $ImportPattern)
  foreach ($match in $matches) {
    $module = $match.Groups['module'].Value
    if ($module -notmatch $TargetModulePattern) { continue }

    $clause = $match.Groups['clause'].Value
    foreach ($name in $ForbiddenNames) {
      if ($clause -match "\b$([regex]::Escape($name))\b") {
        $violations.Add("${repoPath}: forbidden raw-input WASM import '$name' from '$module'")
      }
    }
    $futureNames = [regex]::Matches($clause, $FutureRawBridgeNamePattern) | ForEach-Object { $_.Value } | Sort-Object -Unique
    foreach ($name in $futureNames) {
      $violations.Add("${repoPath}: forbidden future raw-input WASM import '$name' from '$module'")
    }

    if ($clause -match $NamespaceImportPattern) {
      $namespaceAlias = $Matches[1]
      $alias = [regex]::Escape($namespaceAlias)
      foreach ($name in $ForbiddenNames) {
        if ($contents -match "\b$alias\.$([regex]::Escape($name))\b") {
          $violations.Add("${repoPath}: forbidden raw-input WASM namespace usage '$namespaceAlias.$name' from '$module'")
        }
      }
      $futureNamespacePattern = "\b$alias\.($FutureRawBridgeNamePattern)"
      $futureUsages = [regex]::Matches($contents, $futureNamespacePattern) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
      foreach ($name in $futureUsages) {
        $violations.Add("${repoPath}: forbidden future raw-input WASM namespace usage '$namespaceAlias.$name' from '$module'")
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'web-raw-input-ffi guard FAILED:' -ForegroundColor Red
  foreach ($violation in ($violations | Sort-Object -Unique)) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'Raw-secret-shaped WASM bridges are test/vector-only; production web code must use handle-based APIs.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'web-raw-input-ffi guard: OK (no production callers of raw-input WASM bridges)'
