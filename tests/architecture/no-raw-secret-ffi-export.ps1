#requires -Version 7
$ErrorActionPreference = 'Stop'

# Architecture-guard regex maintenance protocol:
# 1. Every regex extension MUST be accompanied by a negative-test fixture
#    proving the new pattern catches what the old missed.
# 2. Fixtures live inline in Invoke-NegativeFixtures below and run as part of CI.
# 3. PR adding a new pattern without a fixture should be rejected at review.
# 4. Option B: mosaic-wasm producer exports with exotic byte-array returns
#    (Cow<[u8]>, Box<[u8]>, Uint8Array, ArrayBuffer) are name-agnostic.
#
# Allowlist audit checkpoint:
# Last full audit: R-C5.5 at 5bc477d
# Each allowlist entry below MUST carry a SPECIFIC cryptographic safety
# argument as its rationale comment. "Reviewed existing API" / "Internal
# use" / "Not a secret" are NOT acceptable rationales. Audits should be
# repeated whenever an entry is added; v1 freeze checkpoint should re-run
# this audit.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ffiFiles = @('crates/mosaic-wasm/src/lib.rs', 'crates/mosaic-uniffi/src/lib.rs')
$dtsFiles = @('apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts')
# JsValue is intentionally treated as secret-shaped for wasm exports. It is fuzzy
# because serde_wasm_bindgen can smuggle byte arrays through JsValue; reviewers can
# use the explicit allowlist when a non-secret JsValue API is justified.
$secretResultTypes = '(Vec\s*<\s*u8\s*>|Box\s*<\s*\[\s*u8\s*\]\s*>|Cow\s*<[^>]*\[\s*u8\s*\][^>]*>|(?:js_sys\s*::\s*)?Uint8Array|(?:js_sys\s*::\s*)?ArrayBuffer|JsValue|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)'
$exoticWasmResultTypes = '(Box\s*<\s*\[\s*u8\s*\]\s*>|Cow\s*<[^>]*\[\s*u8\s*\][^>]*>|(?:js_sys\s*::\s*)?Uint8Array|(?:js_sys\s*::\s*)?ArrayBuffer)'
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
  'crates/mosaic-wasm/src/lib.rs::wrapped_account_key' = 'Returns L2 account key encrypted under password-derived L1; unwrap requires password and account salt.'
  'crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle' = 'Returns ACCOUNT_DATA_AAD AEAD ciphertext; L2 account key remains inside Rust handle registry.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle' = 'Decrypts only ACCOUNT_DATA_AAD blobs via an open handle; does not expose L2 or seed-domain key material.'
  'crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle_js' = 'Returns ACCOUNT_DATA_AAD AEAD ciphertext to JS; L2 account key remains inside Rust handle registry.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle_js' = 'Decrypts only ACCOUNT_DATA_AAD blobs via JS handle; does not expose L2 or seed-domain key material.'
  'crates/mosaic-wasm/src/lib.rs::wrapped_epoch_seed' = 'Returns epoch seed encrypted under the account handle wrap key; plaintext seed requires matching L2.'
  'crates/mosaic-wasm/src/lib.rs::identity_message' = 'Returns fixed golden-vector message bytes for signature verification; contains no key material.'
  'crates/mosaic-wasm/src/lib.rs::identity_signature' = 'Returns Ed25519 detached signature bytes; verifier gains no private signing key material.'
  'crates/mosaic-wasm/src/lib.rs::link_id' = 'Returns public link identifier derived from link secret; cannot recover wrapping key from identifier alone.'
  'crates/mosaic-wasm/src/lib.rs::link_secret_for_url' = 'MIGRATION-PENDING: see r-c5-5-migrate-link-secret-for-url; returns bearer URL fragment seed bytes.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity' = 'Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle' = 'Returns a 64-byte Ed25519 manifest signature; epoch signing seed remains inside Rust handle.'
  'crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account' = 'Returns a 64-byte Ed25519 auth signature; account-derived signing secret is not exported.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity_js' = 'Returns JS-visible Ed25519 manifest signature bytes; identity signing key remains inside Rust handle.'
  'crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle_js' = 'Returns JS-visible Ed25519 manifest signature bytes; epoch signing seed remains inside Rust handle.'
  'crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account_js' = 'Returns JS-visible Ed25519 auth signature bytes; account-derived signing secret is not exported.'
  'crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret' = 'MIGRATION-PENDING: see r-c5-5-migrate-derive-link-keys-from-raw-secret; returns raw link wrapping key.'
  'crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed' = 'MIGRATION-PENDING: see r-c5-5-migrate-verify-and-open-bundle-with-recipient-seed; returns raw epoch seed.'
  'crates/mosaic-uniffi/src/lib.rs::sign_manifest_with_identity' = 'Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.'
}
$structFieldAllowlist = @{
  'crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key' = 'Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.'
  'crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key' = 'Field stores L2 encrypted under password-derived L1; plaintext L2 never crosses FFI.'
  'crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed' = 'Field stores identity seed encrypted by account L2; opening requires matching account handle.'
  'crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed' = 'Field stores epoch seed encrypted by account L2; opening requires matching account handle.'
  'crates/mosaic-wasm/src/lib.rs::CreateLinkShareHandleResult.encrypted_key' = 'Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.'
  'crates/mosaic-wasm/src/lib.rs::WrappedTierKeyResult.encrypted_key' = 'Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.'
  'crates/mosaic-uniffi/src/lib.rs::AccountUnlockRequest.wrapped_account_key' = 'Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.'
  'crates/mosaic-uniffi/src/lib.rs::IdentityHandleResult.wrapped_seed' = 'Field stores identity seed encrypted by account L2; opening requires matching account handle.'
  'crates/mosaic-uniffi/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed' = 'Field stores epoch seed encrypted by account L2; opening requires matching account handle.'
  'crates/mosaic-uniffi/src/lib.rs::LinkKeysFfiResult.wrapping_key' = 'MIGRATION-PENDING: see r-c5-5-migrate-linkkeysffiresult-wrapping-key; raw link wrapping key.'
  'crates/mosaic-uniffi/src/lib.rs::OpenedBundleFfiResult.epoch_seed' = 'MIGRATION-PENDING: see r-c5-5-migrate-openedbundleffiresult-epoch-seed; raw epoch seed.'
}
$dtsAllowlist = @{
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateAccountResult.wrappedAccountKey' = 'Type exposes L2 encrypted under password-derived L1; plaintext L2 is not typed as JS output.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::EpochKeyHandleResult.wrappedEpochSeed' = 'Type exposes epoch seed encrypted by account L2; opening requires matching account handle.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::IdentityHandleResult.wrappedSeed' = 'Type exposes identity seed encrypted by account L2; opening requires matching account handle.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateLinkShareHandleResult.encryptedKey' = 'Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey' = 'Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.'
}

function Test-SecretName([string]$Name) {
  return ($Name -match $secretShapedName) -and ($Name -notmatch $publicKeyName)
}

function Assert-NegativeFixtureCaught([string]$Name, [string]$Source, [string]$ExpectedSymbol, [string]$SourcePath = "tests/architecture/negative-fixtures/$Name.rs") {
  $fixturePath = $SourcePath
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
    $isNameAgnosticWasmExotic = ($fixturePath -eq 'crates/mosaic-wasm/src/lib.rs') -and ($signature -match "->\s*$exoticWasmResultTypes")
    if (($name -notmatch $publicKeyName) -and (($isSecretShapedExport -and $signature -match "->\s*$secretResultTypes") -or $isNameAgnosticWasmExotic)) {
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
  Assert-NegativeFixtureCaught 'wasm-bare-name-cow-u8' "pub fn leak() -> Cow<'static, [u8]> { unimplemented!() }" 'leak' 'crates/mosaic-wasm/src/lib.rs'
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
    $isNameAgnosticWasmExotic = ($path -eq 'crates/mosaic-wasm/src/lib.rs') -and ($signature -match "->\s*$exoticWasmResultTypes")
    if (($isSecretShapedExport -and $signature -match "->\s*$secretResultTypes") -or $isNameAgnosticWasmExotic) {
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
