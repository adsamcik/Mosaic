#requires -Version 7
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ffiFiles = @('crates/mosaic-wasm/src/lib.rs', 'crates/mosaic-uniffi/src/lib.rs')
$dtsFiles = @('apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts')
$secretResultTypes = '(Vec\s*<\s*u8\s*>|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)'
$secretNamePattern = '(derive.*(key|keys|secret)|get.*key|wrap.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)'
$secretShapedName = '(?i)(seed|secret|key)$'
$publicKeyName = '(public_?key|pub_?key|PublicKey|PubKey|pubkey)'
$forbiddenRawBundleApis = @(
  'seal_and_sign_bundle',
  'seal_and_sign_bundle_js',
  'import_epoch_key_handle_from_bundle',
  'import_epoch_key_handle_from_bundle_js'
)
$allowlist = @{
  'crates/mosaic-wasm/src/lib.rs::derive_link_keys' = 'SPEC-WebRustCryptoCutover Slice 6 share-link wrapping-key compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_link_keys_js' = 'WASM wrapper for Slice 6 share-link compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::wrapped_account_key' = 'Getter for server-storable wrapped account key.'
  'crates/mosaic-wasm/src/lib.rs::wrapping_key' = 'ADR-006 compatibility debt for share-link vectors.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link' = 'SPEC-WebRustCryptoCutover Slice 6 link-share raw tier-key debt.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link_js' = 'WASM wrapper for Slice 6 link-share raw tier-key debt.'
  'crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret' = 'Cross-client vector driver only; returns wrapping_key for parity tests.'
  'crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed' = 'Cross-client vector driver only; OpenedBundleFfiResult carries epoch_seed.'
}
$structFieldAllowlist = @{
  'crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key' = 'Wrapped input for account unlock.'
  'crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key' = 'Server-storable wrapped account key.'
  'crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed' = 'Server-storable wrapped identity seed.'
  'crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed' = 'Server-storable wrapped epoch seed.'
  'crates/mosaic-wasm/src/lib.rs::LinkKeysResult.wrapping_key' = 'ADR-006 compatibility debt for share-link vectors.'
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
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::LinkKeysResult.wrappingKey' = 'ADR-006 compatibility debt for share-link vectors.'
  'apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey' = 'Encrypted tier key ciphertext.'
}

function Test-SecretName([string]$Name) {
  return ($Name -match $secretShapedName) -and ($Name -notmatch $publicKeyName)
}

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

    if ($lines[$i] -notmatch '^\s*pub\s+fn\s+([A-Za-z0-9_]+)') { continue }
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
    if ($name -match $secretNamePattern -and $signature -match "->\s*$secretResultTypes") {
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
