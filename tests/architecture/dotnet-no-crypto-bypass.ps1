#requires -Version 7
# .NET backend crypto-boundary guard.
#
# Production backend authentication/signature verification must route through
# RustCoreHost (wasmtime-hosted Rust core), not through managed Ed25519/NSec or
# other direct signature primitives.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$BackendRoot = Join-Path $ProjectRoot 'apps/backend/Mosaic.Backend'
if (-not (Test-Path $BackendRoot)) {
  throw "Missing production backend tree: apps/backend/Mosaic.Backend"
}

$PackagePattern = '<PackageReference\s+Include="(?:NSec\.Cryptography|BouncyCastle[^"]*|Sodium\.Core|Chaos\.NaCl)"'
$SourcePatterns = [ordered]@{
  'managed-nsec' = '\bNSec\.Cryptography\b|(?m)^\s*using\s+NSec\.Cryptography\s*;'
  'managed-ed25519' = '\bSignatureAlgorithm\s*\.\s*Ed25519\b|\bPublicKey\s*\.\s*Import\b|\bKey\s*\.\s*Import\b'
  'managed-signature-api' = '\b(ECDsa|DSA|RSA)\s*\.\s*Create\b|\bIncrementalHash\s*\.\s*CreateHMAC\b'
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Pattern, [string]$Source) {
  if ($Source -notmatch $Pattern) {
    throw "dotnet-no-crypto-bypass negative fixture '$Name' was not caught"
  }
}

Assert-NegativeFixtureCaught 'nsec-package' $PackagePattern '<PackageReference Include="NSec.Cryptography" Version="25.4.0" />'
Assert-NegativeFixtureCaught 'nsec-using' $SourcePatterns['managed-nsec'] 'using NSec.Cryptography;'
Assert-NegativeFixtureCaught 'ed25519-verify' $SourcePatterns['managed-ed25519'] 'var algorithm = SignatureAlgorithm.Ed25519;'
Assert-NegativeFixtureCaught 'ecdsa-bypass' $SourcePatterns['managed-signature-api'] 'using var key = ECDsa.Create();'

$Violations = New-Object System.Collections.Generic.List[string]

Get-ChildItem -Path $BackendRoot -Recurse -File -Filter '*.csproj' | ForEach-Object {
  $repoPath = [System.IO.Path]::GetRelativePath($ProjectRoot, $_.FullName).Replace('\', '/')
  $text = Get-Content -Raw -Path $_.FullName
  foreach ($match in [regex]::Matches($text, $PackagePattern, 'IgnoreCase')) {
    $lineNo = ($text.Substring(0, $match.Index).Split("`n")).Count
    $Violations.Add("${repoPath}:${lineNo}: forbidden managed crypto package reference")
  }
}

Get-ChildItem -Path $BackendRoot -Recurse -File -Filter '*.cs' | ForEach-Object {
  $repoPath = [System.IO.Path]::GetRelativePath($ProjectRoot, $_.FullName).Replace('\', '/')
  $text = Get-Content -Raw -Path $_.FullName
  $lines = $text -split "`r?`n"

  foreach ($entry in $SourcePatterns.GetEnumerator()) {
    foreach ($match in [regex]::Matches($text, $entry.Value)) {
      $lineNo = ($text.Substring(0, $match.Index).Split("`n")).Count
      $line = if ($lineNo -le $lines.Count) { $lines[$lineNo - 1].Trim() } else { '' }
      $Violations.Add("${repoPath}:${lineNo}: forbidden $($entry.Key) crypto bypass; use RustCoreHost -> ${line}")
    }
  }
}

if ($Violations.Count -gt 0) {
  Write-Error ("dotnet-no-crypto-bypass guard FAILED:`n  " + (($Violations | Sort-Object -Unique) -join "`n  ") + "`n`nProduction backend signature/auth verification must be hosted by RustCoreHost.")
  exit 1
}

Write-Host 'dotnet-no-crypto-bypass guard: OK (production .NET crypto routes through RustCoreHost)'
