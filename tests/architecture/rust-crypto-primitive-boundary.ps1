#requires -Version 7
# Rust crypto primitive boundary guard.
#
# Protocol cryptography must live in mosaic-crypto. Facade, domain, media,
# client, and vector crates may call mosaic_crypto APIs, but must not import
# low-level primitive crates directly unless a reviewed allowlist classifier is
# present for the file.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$CrateRoots = @(
  'crates/mosaic-wasm/src',
  'crates/mosaic-uniffi/src',
  'crates/mosaic-domain/src',
  'crates/mosaic-media/src',
  'crates/mosaic-client/src',
  'crates/mosaic-vectors/src'
)

$AllowedFiles = @{
}

$Patterns = @(
  @{
    Name = 'primitive_crate_import'
    Regex = '\buse\s+(sha2|sha1|blake2|hkdf|hmac|chacha20(poly1305)?|aes_gcm|xchacha20poly1305|ed25519(_dalek)?|x25519(_dalek)?|argon2|crypto_secretbox|pbkdf2|generic_array|hybrid_array)\s*(::|\{)'
  }
)

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Test-IsAllowed([string]$RepoPath) {
  if (-not $AllowedFiles.ContainsKey($RepoPath)) { return $false }
  $classifier = $AllowedFiles[$RepoPath]
  if ($classifier -notmatch '^(SAFE|MIGRATION-PENDING|BOUNDARY):\s+\S') {
    throw "rust-crypto-primitive-boundary allowlist entry for '$RepoPath' must start with SAFE:, MIGRATION-PENDING:, or BOUNDARY:"
  }
  return $true
}

function Assert-PatternFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedPatternName) {
  foreach ($pattern in $Patterns) {
    if ($pattern.Name -eq $ExpectedPatternName -and $Source -match $pattern.Regex) {
      return
    }
  }
  throw "rust-crypto-primitive-boundary negative fixture '$Name' did not catch expected pattern '$ExpectedPatternName'"
}

Assert-PatternFixtureCaught 'sha2-import' 'use sha2::{Digest, Sha256};' 'primitive_crate_import'
Assert-PatternFixtureCaught 'hkdf-import' 'use hkdf::Hkdf;' 'primitive_crate_import'
Assert-PatternFixtureCaught 'ed25519-import' 'use ed25519_dalek::SigningKey;' 'primitive_crate_import'

$violations = New-Object System.Collections.Generic.List[string]

foreach ($root in $CrateRoots) {
  if (-not (Test-Path $root)) {
    $violations.Add("Missing expected crate src tree: $root")
    continue
  }

  Get-ChildItem -Path $root -Recurse -Filter '*.rs' -ErrorAction Stop | ForEach-Object {
    $repoPath = Convert-ToRepoPath $_.FullName
    if (Test-IsAllowed $repoPath) { return }

    $lines = Get-Content -Path $_.FullName -ErrorAction Stop
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $line = $lines[$i]
      if ($line -match '^\s*//') { continue }
      foreach ($pattern in $Patterns) {
        if ($line -match $pattern.Regex) {
          $violations.Add("$repoPath`:$($i + 1): direct crypto primitive import '$($pattern.Name)' is forbidden outside mosaic-crypto -> $($line.TrimEnd())")
        }
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'rust-crypto-primitive-boundary guard FAILED:' -ForegroundColor Red
  foreach ($violation in ($violations | Sort-Object -Unique)) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'Low-level crypto primitives must route through mosaic-crypto or an explicit SAFE/MIGRATION-PENDING/BOUNDARY allowlist.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'rust-crypto-primitive-boundary guard: OK (Rust crypto primitives route through mosaic-crypto)'
