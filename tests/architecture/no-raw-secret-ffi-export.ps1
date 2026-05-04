#requires -Version 7
$ErrorActionPreference = 'Stop'

# Architecture-guard regex maintenance protocol:
# 1. Every regex extension MUST be accompanied by a negative-test fixture
#    proving the new pattern catches what the old missed.
# 2. Fixtures live inline in Invoke-NegativeFixtures below and run as part of CI.
# 3. PR adding a new pattern without a fixture should be rejected at review.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ffiFiles = @('crates/mosaic-wasm/src/lib.rs', 'crates/mosaic-uniffi/src/lib.rs')
$dtsFiles = @('apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts')
# JsValue is intentionally treated as secret-shaped for wasm exports. It is fuzzy
# because serde_wasm_bindgen can smuggle byte arrays through JsValue; reviewers can
# use the explicit allowlist when a non-secret JsValue API is justified.
$secretResultTypes = '(Vec\s*<\s*u8\s*>|Box\s*<\s*\[\s*u8\s*\]\s*>|Cow\s*<[^>]*\[\s*u8\s*\][^>]*>|(?:js_sys\s*::\s*)?Uint8Array|(?:js_sys\s*::\s*)?ArrayBuffer|JsValue|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)'
$secretNamePattern = '(derive.*(key|keys|secret)|generate.*secret|get.*key|wrap.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)'
$domainHandlePattern = '(?i)(^(wrap|unwrap)_.*(account|epoch|identity|link).*(handle|seed|key|secret)|^(seal|unseal)_.*(account|epoch|identity|link).*handle)'
$genericBytesWrapPattern = '(?i)^(wrap|unwrap)(_|$)'
$domainNounPattern = '(?i)(account|epoch|identity|link)'
$secretShapedName = '(?i)(seed|secret|key)$'
$publicKeyName = '(public_?key|pub_?key|PublicKey|PubKey|pubkey)'
$forbiddenRawBundleApis = @(
  'seal_and_sign_bundle',
  'seal_and_sign_bundle_js',
  'import_epoch_key_handle_from_bundle',
  'import_epoch_key_handle_from_bundle_js'
)
$allowlist = @{
  'crates/mosaic-wasm/src/lib.rs::wrapped_account_key' = 'Getter for server-storable wrapped account key.'
  'crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle' = 'R-C6 AAD-bound account-data wrapper; returns only ACCOUNT_DATA_AAD ciphertext.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle' = 'R-C6 AAD-bound account-data unwrap; cannot decrypt seed domains.'
  'crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle_js' = 'R-C6 AAD-bound account-data wrapper; returns only ACCOUNT_DATA_AAD ciphertext.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle_js' = 'R-C6 AAD-bound account-data unwrap; cannot decrypt seed domains.'
  'crates/mosaic-wasm/src/lib.rs::wrapped_epoch_seed' = 'Getter for server-storable wrapped epoch seed ciphertext.'
  'crates/mosaic-wasm/src/lib.rs::identity_message' = 'Golden-vector fixture message bytes, not secret key material.'
  'crates/mosaic-wasm/src/lib.rs::identity_signature' = 'Golden-vector signature bytes, not secret key material.'
  'crates/mosaic-wasm/src/lib.rs::link_id' = 'Opaque link identifier bytes, not link secret key material.'
  'crates/mosaic-wasm/src/lib.rs::link_secret_for_url' = 'User-deliverable link secret for URL construction; reviewed existing API.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity' = 'Returns a signature over a transcript, not raw identity key material.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle' = 'Returns a signature over a transcript, not raw epoch key material.'
  'crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account' = 'Returns an auth challenge signature, not raw account key material.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity_js' = 'Returns a signature over a transcript, not raw identity key material.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle_js' = 'Returns a signature over a transcript, not raw epoch key material.'
  'crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account_js' = 'Returns an auth challenge signature, not raw account key material.'
  'crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret' = 'Cross-client vector driver only; returns wrapping_key for parity tests.'
  'crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed' = 'Cross-client vector driver only; OpenedBundleFfiResult carries epoch_seed.'
  'crates/mosaic-uniffi/src/lib.rs::sign_manifest_with_identity' = 'Returns a signature over a transcript, not raw identity key material.'
}
$structFieldAllowlist = @{
  'crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key' = 'Wrapped input for account unlock.'
  'crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key' = 'Server-storable wrapped account key.'
  'crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed' = 'Server-storable wrapped identity seed.'
  'crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed' = 'Server-storable wrapped epoch seed.'
  'crates/mosaic-wasm/src/lib.rs::CreateLinkShareHandleResult.encrypted_key' = 'Encrypted tier key ciphertext.'
  'crates/mosaic-wasm/src/lib.rs::WrappedTierKeyResult.encrypted_key' = 'Encrypted tier key ciphertext.'
  'crates/mosaic-uniffi/src/lib.rs::AccountUnlockRequest.wrapped_account_key' = 'Wrapped input for account unlock.'
  'crates/mosaic-uniffi/src/lib.rs::IdentityHandleResult.wrapped_seed' = 'Server-storable wrapped identity seed.'
  'crates/mosaic-uniffi/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed' = 'Server-storable wrapped epoch seed.'
  'crates/mosaic-uniffi/src/lib.rs::LinkKeysFfiResult.wrapping_key' = 'Cross-client vector compatibility debt.'
  'crates/mosaic-uniffi/src/lib.rs::OpenedBundleFfiResult.epoch_seed' = 'Cross-client vector compatibility debt.'
}
$dtsAllowlist = @{
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateAccountResult.wrappedAccountKey' = 'Server-storable wrapped account key.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::EpochKeyHandleResult.wrappedEpochSeed' = 'Server-storable wrapped epoch seed.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::IdentityHandleResult.wrappedSeed' = 'Server-storable wrapped identity seed.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateLinkShareHandleResult.encryptedKey' = 'Encrypted tier key ciphertext.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey' = 'Encrypted tier key ciphertext.'
}

function Test-SecretName([string]$Name) {
  return ($Name -match $secretShapedName) -and ($Name -notmatch $publicKeyName)
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedSymbol) {
  $fixturePath = "tests/architecture/negative-fixtures/$Name.rs"
  $fixtureLines = $Source -split "`r?`n"
  $fixtureViolations = New-Object System.Collections.Generic.List[string]

  for ($i = 0; $i -lt $fixtureLines.Count; $i++) {
    if ($fixtureLines[$i] -notmatch '^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)') { continue }
    $name = $Matches[1]
    $signature = $fixtureLines[$i]
    $j = $i
    while ($signature -notmatch '\{' -and $j + 1 -lt $fixtureLines.Count) {
      $j++
      $signature += ' ' + $fixtureLines[$j].Trim()
    }

    $isSecretShapedExport = (($name -match $secretNamePattern) -or
      ($name -match $domainHandlePattern) -or
      (($name -match $genericBytesWrapPattern) -and ($signature -match '->\s*(BytesResult|JsBytesResult)')) -or
      ($name -match $domainNounPattern))
    if (($name -notmatch $publicKeyName) -and $isSecretShapedExport -and $signature -match "->\s*$secretResultTypes") {
      $fixtureViolations.Add("$fixturePath`:$($i + 1): forbidden raw-secret-shaped FFI export '$name' -> $($signature.Trim())")
    }
  }

  if (-not ($fixtureViolations | Where-Object { $_ -match [regex]::Escape($ExpectedSymbol) })) {
    throw "negative fixture '$Name' did not catch expected symbol '$ExpectedSymbol'. Violations: $($fixtureViolations -join '; ')"
  }
}

function Invoke-NegativeFixtures {
  Assert-NegativeFixtureCaught 'cousin-verb-export-account-seed' 'pub fn export_account_seed() -> BytesResult { unimplemented!() }' 'export_account_seed'
  Assert-NegativeFixtureCaught 'exotic-return-box-u8' 'pub fn get_epoch_key() -> Box<[u8]> { unimplemented!() }' 'get_epoch_key'
  Assert-NegativeFixtureCaught 'exotic-return-cow-u8' "pub fn get_identity_key() -> Cow<'static, [u8]> { unimplemented!() }" 'get_identity_key'
  Assert-NegativeFixtureCaught 'exotic-return-uint8array' 'pub fn get_link_key() -> js_sys::Uint8Array { unimplemented!() }' 'get_link_key'
  Assert-NegativeFixtureCaught 'exotic-return-arraybuffer' 'pub fn get_account_key() -> js_sys::ArrayBuffer { unimplemented!() }' 'get_account_key'
  Assert-NegativeFixtureCaught 'exotic-return-jsvalue' 'pub fn get_identity_key() -> JsValue { unimplemented!() }' 'get_identity_key'
}

Invoke-NegativeFixtures

$violations = New-Object System.Collections.Generic.List[string]
foreach ($path in $ffiFiles) {
  $lines = Get-Content -Path $path -ErrorAction Stop
  $currentStruct = $null
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*pub\s+struct\s+([A-Za-z0-9_]+)') {
      $currentStruct = $Matches[1]
    } elseif ($currentStruct -and $lines[$i] -match '^\s*}') {
      $currentStruct = $null
    } elseif ($currentStruct -and $lines[$i] -match '^\s*pub\s+([A-Za-z0-9_]+)\s*:\s*Vec\s*<\s*u8\s*>') {
      $field = $Matches[1]
      $key = "$path`::$currentStruct.$field"
      if ((Test-SecretName $field) -and -not $structFieldAllowlist.ContainsKey($key)) {
        $violations.Add("$path`:$($i + 1): forbidden secret-shaped Vec<u8> FFI field '$currentStruct.$field'")
      }
    }

    if ($lines[$i] -notmatch '^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)') { continue }
    $name = $Matches[1]
    if ($forbiddenRawBundleApis -contains $name) {
      $violations.Add("$path`:$($i + 1): forbidden raw bundle-secret FFI export '$name'")
    }
    if ($name -match $publicKeyName) { continue }
    $signature = $lines[$i]
    $j = $i
    while ($signature -notmatch '\{' -and $j + 1 -lt $lines.Count) {
      $j++
      $signature += ' ' + $lines[$j].Trim()
    }
    $isSecretShapedExport = (($name -match $secretNamePattern) -or
      ($name -match $domainHandlePattern) -or
      (($name -match $genericBytesWrapPattern) -and ($signature -match '->\s*(BytesResult|JsBytesResult)')) -or
      ($name -match $domainNounPattern))
    if ($isSecretShapedExport -and $signature -match "->\s*$secretResultTypes") {
      $key = "$path`::$name"
      if (-not $allowlist.ContainsKey($key)) {
        $violations.Add("$path`:$($i + 1): forbidden raw-secret-shaped FFI export '$name' -> $($signature.Trim())")
      }
    }
  }
}

foreach ($path in $dtsFiles) {
  if (-not (Test-Path $path)) { continue }
  $currentClass = $null
  $lines = Get-Content -Path $path -ErrorAction Stop
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*export\s+class\s+([A-Za-z0-9_]+)') {
      $currentClass = $Matches[1]
      continue
    }
    if ($currentClass -and $lines[$i] -match '^\s*}') {
      $currentClass = $null
      continue
    }
    if ($currentClass -and $lines[$i] -match '^\s*readonly\s+([A-Za-z0-9_]+)\s*:\s*Uint8Array') {
      $field = $Matches[1]
      $key = "$path`::$currentClass.$field"
      if ((Test-SecretName $field) -and -not $dtsAllowlist.ContainsKey($key)) {
        $violations.Add("$path`:$($i + 1): forbidden secret-shaped Uint8Array WASM property '$currentClass.$field'")
      }
    }
    if ($lines[$i] -match '^\s*export\s+function\s+([A-Za-z0-9_]+)\([^)]*\)\s*:\s*Uint8Array') {
      $name = $Matches[1]
      if (Test-SecretName $name) {
        $violations.Add("$path`:$($i + 1): forbidden secret-shaped Uint8Array WASM function return '$name'")
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'no-raw-secret-ffi-export guard FAILED:' -ForegroundColor Red
  foreach ($violation in $violations) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'ADR-006/ADR-021 require key access through opaque handles.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'no-raw-secret-ffi-export guard: OK (no new raw key-shaped FFI exports)'
