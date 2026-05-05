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
# Last full audit: R-C5.5 at 2d17c47
# Each allowlist entry below MUST carry a SPECIFIC cryptographic safety
# argument as its rationale comment. "Reviewed existing API" / "Internal
# use" / "Not a secret" are NOT acceptable rationales. Audits should be
# repeated whenever an entry is added; v1 freeze checkpoint should re-run
# this audit.
# R-C5.5.1 mechanical enforcement: rationales shorter than 40 chars or
# matching banned phrases ('reviewed existing api', 'internal use', etc.)
# fail at script execution time. See R-C5.5 audit checkpoint above.
# Classifier vocabulary is locked by SPEC-FfiSecretClassifiers.md (v1).
# Permitted classifiers: SAFE, BEARER-TOKEN-PERMITTED, CORPUS-DRIVER-ONLY,
# MIGRATION-PENDING. Adding a new classifier requires a SPEC amendment.
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

$AllowlistedFiles = @{
  # Test-only cross-client vector driver is excluded from production src; it exercises raw-input bridges against public corpora.
  'apps/web/tests/cross-client-vectors.test.ts' = 'Test-only cross-client vector driver is excluded from production src; it exercises raw-input bridges against public corpora.'
}


$BannedRationalePhrases = @(
  'reviewed existing api',
  'internal use',
  'not a secret',
  'todo',
  'trust me',
  'fixme',
  'tbd'
)
$MinRationaleLength = 40
$RationaleFixSuggestion = 'Replace with a sentence stating the SPECIFIC bytes returned and why an attacker gains no advantage.'
$PermittedClassifiers = @('SAFE', 'BEARER-TOKEN-PERMITTED', 'CORPUS-DRIVER-ONLY', 'MIGRATION-PENDING')
$ClassifierPattern = '^([A-Z][A-Z0-9-]+):'

function Get-AllowlistRationaleErrors([hashtable[]]$AllowlistTables) {
  $rationaleErrors = New-Object System.Collections.Generic.List[string]
  foreach ($table in $AllowlistTables) {
    foreach ($entry in $table.GetEnumerator()) {
      $rationale = ($entry.Value ?? '').Trim()
      if ($rationale.Length -lt $MinRationaleLength) {
        $rationaleErrors.Add("Allowlist entry '$($entry.Key)' failed length check: `"$rationale`" ($RationaleFixSuggestion)")
      }
      foreach ($phrase in $BannedRationalePhrases) {
        if ($rationale.ToLowerInvariant().Contains($phrase)) {
          $rationaleErrors.Add("Allowlist entry '$($entry.Key)' failed banned phrase check ('$phrase'): `"$rationale`" ($RationaleFixSuggestion)")
        }
      }
      if ($rationale -match $ClassifierPattern) {
        $classifier = $Matches[1]
        if ($PermittedClassifiers -notcontains $classifier) {
          $rationaleErrors.Add("Allowlist entry '$($entry.Key)' failed classifier check ('$classifier'): classifier vocabulary is locked by SPEC-FfiSecretClassifiers.md")
        }
      }
    }
  }
  return $rationaleErrors
}

function Assert-RationaleQualityFixtureCaught([string]$Name, [string]$Rationale, [string]$ExpectedCheck) {
  $fixture = @{ "tests/architecture/negative-fixtures/$Name" = $Rationale }
  $fixtureErrors = Get-AllowlistRationaleErrors @($fixture)
  if (-not ($fixtureErrors | Where-Object { $_ -match [regex]::Escape($ExpectedCheck) })) {
    throw "rationale negative fixture '$Name' did not catch expected check '$ExpectedCheck'. Errors: $($fixtureErrors -join '; ')"
  }
}

function Invoke-AllowlistRationaleQualityCheck([hashtable[]]$AllowlistTables) {
  $rationaleErrors = Get-AllowlistRationaleErrors $AllowlistTables
  if ($rationaleErrors.Count -gt 0) {
    Write-Host 'Allowlist rationale quality check FAILED:' -ForegroundColor Red
    foreach ($rationaleError in $rationaleErrors) { Write-Host "  $rationaleError" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'Each rationale MUST state the SPECIFIC bytes returned and why an attacker gains no advantage.'
    Write-Host 'See R-C5.5 audit checkpoint comment block for the standard.'
    exit 1
  }
}

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Test-IsAllowed([string]$RepoPath) {
  return $AllowlistedFiles.ContainsKey($RepoPath)
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

Assert-RationaleQualityFixtureCaught 'rationale-reviewed-existing-api' 'reviewed existing api' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-internal-use' 'internal use' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-not-a-secret' 'not a secret' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-todo' 'todo' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-trust-me' 'trust me' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-fixme' 'fixme' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-tbd' 'tbd' 'banned phrase check'
Assert-RationaleQualityFixtureCaught 'rationale-short' 'short' 'length check'
Assert-RationaleQualityFixtureCaught 'rationale-unknown-classifier' 'BACKWARD-COMPAT-LEGACY: Returns placeholder bytes with a long enough rationale for classifier validation.' 'classifier check'
Invoke-AllowlistRationaleQualityCheck @($AllowlistedFiles)

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
