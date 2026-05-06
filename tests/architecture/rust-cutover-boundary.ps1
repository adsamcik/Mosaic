#requires -Version 7
# Web Rust-cutover boundary guard.
#
# Locks W-S4 cutover invariants in production apps/web/src code:
#   - no legacy raw-seed decryptShardWithEpoch(...) API
#   - no new epochSeed: Uint8Array parameters
#   - no imports from retired @mosaic/crypto TypeScript modules or their
#     root-level retired symbols

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$RetiredModules = @(
  'auth',
  'content',
  'identity',
  'keybox',
  'keychain',
  'link-sharing',
  'manifest',
  'memory',
  'mock',
  'sharing',
  'signer'
)

$RetiredRootSymbols = @(
  'CHALLENGE_SIZE',
  'LINK_ID_SIZE',
  'LINK_SECRET_SIZE',
  'ParseShareLinkResult',
  'createEpochKeyBundle',
  'createShareLinkUrl',
  'decodeLinkId',
  'decodeLinkSecret',
  'deriveAuthKeypair',
  'deriveIdentityKeypair',
  'deriveKeys',
  'deriveKeysInternal',
  'deriveLinkKeys',
  'ed25519PubToX25519',
  'ed25519SecretToX25519',
  'encryptContent',
  'generateAuthChallenge',
  'generateEd25519Keypair',
  'generateFakeChallenge',
  'generateFakeUserSalt',
  'generateIdentitySeed',
  'generateLinkSecret',
  'generateSalts',
  'isValidEd25519PublicKey',
  'parseShareLinkUrl',
  'rewrapAccountKey',
  'sealAndSignBundle',
  'signAuthChallenge',
  'signManifest',
  'signManifestCanonical',
  'signShard',
  'signWithContext',
  'unwrapAccountKey',
  'unwrapKey',
  'unwrapSymmetricKey',
  'unwrapTierKeyFromLink',
  'verifyAndOpenBundle',
  'verifyAuthChallenge',
  'verifyManifest',
  'verifyManifestCanonical',
  'verifyShardSignature',
  'verifyWithContext',
  'wrapAllTierKeysForLink',
  'wrapKey',
  'wrapSymmetricKey',
  'wrapTierKeyForLink',
  'zeroEpochKey',
  'zeroIdentityKeypair',
  'zeroLinkKeys'
)

$LegacyCallPattern = '\bdecryptShardWithEpoch\s*\('
$EpochSeedParameterPattern = '\bepochSeed\s*:\s*Uint8Array\b'
$MosaicCryptoImportPattern = '(?ms)import\s+(?:type\s+)?(?<clause>.*?)\s+from\s+[''"](?<module>[^''"]+)[''"]'
$DynamicImportPattern = '(?ms)(?:const|let|var)\s*\{(?<clause>[^}]+)\}\s*=\s*await\s+import\(\s*[''"](?<module>[^''"]+)[''"]\s*\)'

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Test-IsProductionSource([string]$RepoPath) {
  if ($RepoPath -notmatch '^apps/web/src/') { return $false }
  if ($RepoPath -match '^apps/web/src/generated/') { return $false }
  if ($RepoPath -match '(^|/)__tests__/') { return $false }
  if ($RepoPath -match '\.(test|spec)\.tsx?$') { return $false }
  return $true
}

function Find-WebProductionFiles {
  if (-not (Test-Path 'apps/web/src')) { return @() }
  Get-ChildItem -Path 'apps/web/src' -Recurse -File -Include '*.ts', '*.tsx' -ErrorAction SilentlyContinue |
    Where-Object { Test-IsProductionSource (Convert-ToRepoPath $_.FullName) }
}

function Get-ImportedSymbols([string]$Clause) {
  $symbols = New-Object System.Collections.Generic.List[string]
  if ($Clause -match '\*\s+as\s+') {
    $symbols.Add('*')
    return $symbols
  }
  if ($Clause -notmatch '\{(?<named>[^}]+)\}') {
    return $symbols
  }
  foreach ($raw in $Matches['named'].Split(',')) {
    $trimmed = $raw.Trim() -replace '^type\s+', ''
    if (-not $trimmed) { continue }
    $symbol = ($trimmed -split '\s+as\s+')[0].Trim()
    if ($symbol) { $symbols.Add($symbol) }
  }
  return $symbols
}

function Add-RetiredImportViolations([string]$RepoPath, [string]$Module, [string]$Clause, [System.Collections.Generic.List[string]]$Violations) {
  foreach ($retiredModule in $RetiredModules) {
    if ($Module -match "(^@mosaic/crypto/$([regex]::Escape($retiredModule))$|libs/crypto/src/$([regex]::Escape($retiredModule))$|/libs/crypto/src/$([regex]::Escape($retiredModule))$|^\.\.?/.*/libs/crypto/src/$([regex]::Escape($retiredModule))$)") {
      $Violations.Add("${RepoPath}: imports retired TypeScript crypto module '$Module'")
    }
  }

  if ($Module -eq '@mosaic/crypto' -or $Module -match '(^|/)libs/crypto/src(?:/index)?$') {
    foreach ($symbol in (Get-ImportedSymbols $Clause)) {
      if ($RetiredRootSymbols -contains $symbol) {
        $Violations.Add("${RepoPath}: imports retired TypeScript crypto symbol '$symbol' from '$Module'")
      }
    }
  }
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedText) {
  $fixtureViolations = New-Object System.Collections.Generic.List[string]
  if ($Source -match $LegacyCallPattern) {
    $fixtureViolations.Add("fixture:${Name}: calls forbidden legacy raw-seed decryptShardWithEpoch(...)")
  }
  if ($Source -match $EpochSeedParameterPattern) {
    $fixtureViolations.Add("fixture:${Name}: declares forbidden raw epochSeed: Uint8Array parameter")
  }
  foreach ($match in [regex]::Matches($Source, $MosaicCryptoImportPattern)) {
    Add-RetiredImportViolations "fixture:${Name}" $match.Groups['module'].Value $match.Groups['clause'].Value $fixtureViolations
  }
  foreach ($match in [regex]::Matches($Source, $DynamicImportPattern)) {
    Add-RetiredImportViolations "fixture:${Name}" $match.Groups['module'].Value "{ $($match.Groups['clause'].Value) }" $fixtureViolations
  }
  if (-not ($fixtureViolations | Where-Object { $_ -match [regex]::Escape($ExpectedText) })) {
    throw "negative fixture '$Name' did not catch expected text '$ExpectedText'. Violations: $($fixtureViolations -join '; ')"
  }
}

Assert-NegativeFixtureCaught 'legacy-decrypt-shard-with-epoch-call' 'await crypto.decryptShardWithEpoch(epochHandle, envelope);' 'decryptShardWithEpoch'
Assert-NegativeFixtureCaught 'raw-epoch-seed-param' 'function decrypt(envelope: Uint8Array, epochSeed: Uint8Array) { return envelope; }' 'epochSeed: Uint8Array'
Assert-NegativeFixtureCaught 'retired-subpath-import' "import { wrapKey } from '@mosaic/crypto/keybox';" 'retired TypeScript crypto module'
Assert-NegativeFixtureCaught 'retired-root-import' "import { signManifest } from '@mosaic/crypto';" 'signManifest'
Assert-NegativeFixtureCaught 'retired-dynamic-import' "const { deriveKeys } = await import('@mosaic/crypto');" 'deriveKeys'

$violations = New-Object System.Collections.Generic.List[string]

foreach ($fileInfo in Find-WebProductionFiles) {
  $repoPath = Convert-ToRepoPath $fileInfo.FullName
  $contents = Get-Content -Path $fileInfo.FullName -Raw -ErrorAction Stop
  if ($null -eq $contents) { $contents = '' }

  if ($contents -match $LegacyCallPattern) {
    $violations.Add("${repoPath}: calls forbidden legacy raw-seed decryptShardWithEpoch(...); use decryptShardWithEpochHandle(...)")
  }
  if ($contents -match $EpochSeedParameterPattern) {
    $violations.Add("${repoPath}: declares forbidden raw epochSeed: Uint8Array parameter; use an EpochHandleId/handle API")
  }

  foreach ($match in [regex]::Matches($contents, $MosaicCryptoImportPattern)) {
    Add-RetiredImportViolations $repoPath $match.Groups['module'].Value $match.Groups['clause'].Value $violations
  }
  foreach ($match in [regex]::Matches($contents, $DynamicImportPattern)) {
    Add-RetiredImportViolations $repoPath $match.Groups['module'].Value "{ $($match.Groups['clause'].Value) }" $violations
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'rust-cutover-boundary guard FAILED:' -ForegroundColor Red
  foreach ($violation in ($violations | Sort-Object -Unique)) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'Rust core/WASM handle APIs own protocol crypto after W-S4.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'rust-cutover-boundary guard: OK (no retired TS crypto or raw-seed web boundary regressions)'
