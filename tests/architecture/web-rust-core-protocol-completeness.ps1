#requires -Version 7
# Web protocol-class Rust core completeness guard.
#
# This intentionally scans only protocol-class migration files where hashes,
# checksums, scope keys, and cache zeroization are defined. Platform-glue crypto
# remains allowed in:
#   - apps\web\src\lib\session.ts (AES-GCM cookie/session salt envelope)
#   - apps\web\src\lib\local-auth.ts (intentional local HMAC)
#   - apps\web\src\lib\key-cache.ts (AES-GCM IDB cache)
#   - apps\web\src\lib\link-tier-key-store.ts (AES-GCM IDB cache)
#   - apps\web\src\workers\db.worker.ts (SHA-384 opaque WAL integrity)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ProtocolFiles = @(
  'apps\web\src\lib\content-hash.ts',
  'apps\web\src\lib\scope-key.ts',
  'apps\web\src\lib\opfs-staging.ts',
  'apps\web\src\lib\upload\encrypt-upload-shard.ts',
  'apps\web\src\workers\coordinator\decrypt-cache.ts',
  'apps\web\src\workers\coordinator\shard-mirror.ts'
)

$ForbiddenPatterns = @(
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
    Name = 'libsodium memzero'
    Pattern = '\bsodium\s*\.\s*memzero\b'
    Message = 'protocol-class JS-owned buffers must be wiped in-place with Uint8Array.fill(0)'
  }
)

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Add-ProtocolCryptoViolations(
  [string]$RepoPath,
  [string]$Contents,
  [System.Collections.Generic.List[string]]$Violations
) {
  foreach ($rule in $ForbiddenPatterns) {
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
Assert-NegativeFixtureCaught 'libsodium-memzero' 'sodium.memzero(epochKey);' 'libsodium memzero'

$violations = New-Object System.Collections.Generic.List[string]

foreach ($relativePath in $ProtocolFiles) {
  if (-not (Test-Path $relativePath)) {
    $violations.Add("${relativePath}: protocol-class guard target is missing")
    continue
  }
  $fullPath = (Resolve-Path $relativePath).Path
  $contents = Get-Content -Path $fullPath -Raw -ErrorAction Stop
  if ($null -eq $contents) { $contents = '' }
  Add-ProtocolCryptoViolations (Convert-ToRepoPath $fullPath) $contents $violations
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'web-rust-core-protocol-completeness guard FAILED:' -ForegroundColor Red
  foreach ($violation in ($violations | Sort-Object -Unique)) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'Protocol-defined hashes, checksums, scope keys, and cache wipes must route through Rust core or JS-owned fill(0).' -ForegroundColor Yellow
  exit 1
}

Write-Host 'web-rust-core-protocol-completeness guard: OK (protocol-class crypto routes through Rust core)'
