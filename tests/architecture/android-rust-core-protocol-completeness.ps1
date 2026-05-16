#requires -Version 7
# Android protocol-class Rust core completeness guard.
#
# Scans production Kotlin under apps/android-main/src/main for crypto primitives
# that must route through Rust core/UniFFI helpers. Local-only non-protocol uses
# remain allowlisted explicitly.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ScanRoot = 'apps/android-main/src/main'
$MessageDigestAllowlist = @(
  'apps/android-main/src/main/kotlin/org/mosaic/android/main/media/BitmapTierEncoder.kt',
  'apps/android-main/src/main/kotlin/org/mosaic/android/main/work/AutoImportWorkPolicy.kt',
  'apps/android-main/src/main/kotlin/org/mosaic/android/main/tus/TusUploadSession.kt'
)
$SecureRandomAllowlist = @(
  'apps/android-main/src/main/kotlin/org/mosaic/android/main/reducer/UploadJobReducer.kt'
)

$Rules = @(
  @{
    Label = 'javax-crypto-import'
    Pattern = '^\s*import\s+javax\.crypto\.'
    Message = 'direct javax.crypto imports must not bypass Rust core/UniFFI'
    Allowlist = $null
  },
  @{
    Label = 'java-security-key-import'
    Pattern = '^\s*import\s+java\.security\.(Signature|KeyPairGenerator|KeyFactory|KeyAgreement)\b'
    Message = 'direct key/signature primitives must not bypass Rust core/UniFFI'
    Allowlist = $null
  },
  @{
    Label = 'third-party-crypto-import'
    Pattern = '^\s*import\s+(com\.lambdapioneer\.argon2kt|org\.libsodium|com\.goterl\.lazysodium|org\.bouncycastle|com\.google\.crypto\.tink|org\.conscrypt)\b'
    Message = 'third-party crypto libraries must not bypass Rust core/UniFFI'
    Allowlist = $null
  },
  @{
    Label = 'message-digest-sha'
    Pattern = '\bMessageDigest\.getInstance\s*\('
    Message = 'protocol-class SHA-256 must use Rust core/UniFFI helpers'
    Allowlist = $MessageDigestAllowlist
  },
  @{
    Label = 'secure-random'
    Pattern = '\bSecureRandom\b'
    Message = 'protocol-class randomness must use Rust core/UniFFI helpers'
    Allowlist = $SecureRandomAllowlist
  }
)

function Convert-ToRepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($ProjectRoot, $Path).Replace('\', '/')
}

function Add-Violations(
  [string]$RepoPath,
  [string]$Contents,
  [System.Collections.Generic.List[string]]$Violations,
  [bool]$EnforceAllowlists
) {
  $lines = $Contents -split "`r?`n"
  foreach ($rule in $Rules) {
    if ($EnforceAllowlists -and $null -ne $rule.Allowlist -and $rule.Allowlist -contains $RepoPath) {
      continue
    }
    foreach ($match in [regex]::Matches($Contents, $rule.Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)) {
      $lineNo = 1 + (($Contents.Substring(0, $match.Index) -split "`r?`n").Count - 1)
      $line = if ($lineNo -le $lines.Count) { $lines[$lineNo - 1].Trim() } else { '' }
      $Violations.Add("${RepoPath}:${lineNo}: forbidden $($rule.Label): $($rule.Message) -> $line")
    }
  }
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedLabel) {
  $fixtureViolations = New-Object System.Collections.Generic.List[string]
  Add-Violations "tests/architecture/negative-fixtures/${Name}.kt" $Source $fixtureViolations $false
  if (-not ($fixtureViolations | Where-Object { $_ -match "forbidden $([regex]::Escape($ExpectedLabel)):" })) {
    throw "negative fixture '$Name' did not catch expected label '$ExpectedLabel'. Violations: $($fixtureViolations -join '; ')"
  }
}

Assert-NegativeFixtureCaught 'javax-crypto-import' "import javax.crypto.Cipher`n" 'javax-crypto-import'
Assert-NegativeFixtureCaught 'java-security-signature-import' "import java.security.Signature`n" 'java-security-key-import'
Assert-NegativeFixtureCaught 'java-security-keypair-import' "import java.security.KeyPairGenerator`n" 'java-security-key-import'
Assert-NegativeFixtureCaught 'third-party-argon2-import' "import com.lambdapioneer.argon2kt.Argon2Kt`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'third-party-libsodium-import' "import org.libsodium.jni.Sodium`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'third-party-lazysodium-import' "import com.goterl.lazysodium.SodiumAndroid`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'third-party-bouncycastle-import' "import org.bouncycastle.crypto.Digest`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'third-party-tink-import' "import com.google.crypto.tink.Aead`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'third-party-conscrypt-import' "import org.conscrypt.Conscrypt`n" 'third-party-crypto-import'
Assert-NegativeFixtureCaught 'message-digest' 'MessageDigest.getInstance("SHA-256")' 'message-digest-sha'
Assert-NegativeFixtureCaught 'secure-random' 'private val rng = SecureRandom()' 'secure-random'

if (-not (Test-Path -LiteralPath $ScanRoot)) {
  throw "Missing Android main tree: $ScanRoot"
}

$violations = New-Object System.Collections.Generic.List[string]
Get-ChildItem -Path $ScanRoot -Recurse -Filter '*.kt' | ForEach-Object {
  $repoPath = Convert-ToRepoPath $_.FullName
  $contents = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
  Add-Violations $repoPath $contents $violations $true
}

if ($violations.Count -gt 0) {
  Write-Host 'android-rust-core-protocol-completeness guard FAILED:'
  $violations | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
  throw 'Production Android protocol crypto must route through Rust core/UniFFI helpers.'
}

Write-Host "android-rust-core-protocol-completeness guard: OK (MessageDigest allowlist=$($MessageDigestAllowlist.Count), SecureRandom allowlist=$($SecureRandomAllowlist.Count))"
