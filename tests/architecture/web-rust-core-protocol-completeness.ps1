#requires -Version 7
# Web protocol-class Rust core completeness guard.
#
# Scans production TypeScript under apps/web/src for protocol-class crypto
# primitives that must route through Rust core/WASM helpers. Platform-glue
# crypto and test fixtures are allowlisted explicitly.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ScanRoot = 'apps/web/src'
$Allowlist = @(
  'apps/web/src/lib/session.ts',
  'apps/web/src/lib/local-auth.ts',
  'apps/web/src/lib/key-cache.ts',
  'apps/web/src/lib/link-tier-key-store.ts',
  'apps/web/src/workers/db.worker.ts',
  'apps/web/src/workers/crypto.worker.ts'
)

$AllowlistPrefixes = @(
  'apps/web/src/generated/'
)

$BannedPatterns = @(
  @{
    Name = 'WebCrypto SHA digest'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*digest\b'
    Message = 'protocol-class SHA hashing must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium SHA-256'
    Pattern = '\bsodium\s*\.\s*crypto_hash_sha256\b'
    Message = 'protocol-class SHA-256 must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium BLAKE2b'
    Pattern = '\bsodium\s*\.\s*crypto_generichash\b'
    Message = 'protocol-class BLAKE2b must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium secretbox'
    Pattern = '\bsodium\s*\.\s*crypto_secretbox_easy\b'
    Message = 'protocol-class symmetric encryption must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium pwhash'
    Pattern = '\bsodium\s*\.\s*crypto_pwhash\b'
    Message = 'protocol-class password hashing must use Rust core/WASM helpers'
  }
)

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Test-IsAllowlisted([string]$RepoPath) {
  if ($Allowlist -contains $RepoPath) { return $true }
  if ($RepoPath -like '*.test.ts') { return $true }
  foreach ($prefix in $AllowlistPrefixes) {
    if ($RepoPath.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      return $true
    }
  }
  return $false
}

function Add-ProtocolCryptoViolations(
  [string]$RepoPath,
  [string]$Contents,
  [System.Collections.Generic.List[string]]$Violations
) {
  foreach ($rule in $BannedPatterns) {
    foreach ($match in [regex]::Matches($Contents, $rule.Pattern)) {
      $line = 1 + (($Contents.Substring(0, $match.Index) -split "`r?`n").Count - 1)
      $Violations.Add("${RepoPath}:${line}: $($rule.Name) bypass: $($rule.Message)")
    }
  }
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedText) {
  $fixtureViolations = New-Object System.Collections.Generic.List[string]
  Add-ProtocolCryptoViolations "tests/architecture/negative-fixtures/${Name}.ts" $Source $fixtureViolations
  if (-not ($fixtureViolations | Where-Object { $_ -match [regex]::Escape($ExpectedText) })) {
    throw "negative fixture '$Name' did not catch expected text '$ExpectedText'. Violations: $($fixtureViolations -join '; ')"
  }
}

Assert-NegativeFixtureCaught 'webcrypto-sha-digest' "await globalThis.crypto.subtle.digest('SHA-256', bytes);" 'WebCrypto SHA digest'
Assert-NegativeFixtureCaught 'webcrypto-sha-digest-self' "await self.crypto.subtle.digest('SHA-256', bytes);" 'WebCrypto SHA digest'
Assert-NegativeFixtureCaught 'libsodium-sha256' 'sodium.crypto_hash_sha256(bytes);' 'libsodium SHA-256'
Assert-NegativeFixtureCaught 'libsodium-blake2b' 'sodium.crypto_generichash(32, bytes);' 'libsodium BLAKE2b'
Assert-NegativeFixtureCaught 'libsodium-secretbox' 'sodium.crypto_secretbox_easy(message, nonce, key);' 'libsodium secretbox'
Assert-NegativeFixtureCaught 'libsodium-pwhash' 'sodium.crypto_pwhash(32, password, salt, 2, 65536, sodium.crypto_pwhash_ALG_ARGON2ID13);' 'libsodium pwhash'

$violations = New-Object System.Collections.Generic.List[string]

if (-not (Test-Path $ScanRoot)) {
  throw "scan root missing: $ScanRoot"
}

$files = Get-ChildItem -Path $ScanRoot -Recurse -File |
  Where-Object { $_.Name -like '*.ts' }

foreach ($file in $files) {
  $repoPath = Convert-ToRepoPath $file.FullName
  if (Test-IsAllowlisted $repoPath) {
    continue
  }
  $contents = Get-Content -Path $file.FullName -Raw -ErrorAction Stop
  if ($null -eq $contents) { $contents = '' }
  Add-ProtocolCryptoViolations $repoPath $contents $violations
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'web-rust-core-protocol-completeness guard FAILED:' -ForegroundColor Red
  foreach ($violation in ($violations | Sort-Object -Unique)) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'Protocol-defined hashes, checksums, encryption, and KDFs must route through Rust core or an explicit allowlist.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'web-rust-core-protocol-completeness guard: OK (web protocol-class crypto routes through Rust core)'
