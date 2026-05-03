#requires -Version 7
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$ffiFiles = @('crates/mosaic-wasm/src/lib.rs', 'crates/mosaic-uniffi/src/lib.rs')
$secretResultTypes = '(Vec\s*<\s*u8\s*>|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)'
$secretNamePattern = '(derive.*(key|keys|secret)|get.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)'
$allowlist = @{
  'crates/mosaic-wasm/src/lib.rs::get_tier_key_from_epoch' = 'SPEC-WebRustCryptoCutover compatibility debt: web Slice 3 raw tier-key bridge.'
  'crates/mosaic-wasm/src/lib.rs::get_tier_key_from_epoch_js' = 'WASM wrapper for the same Slice 3 raw tier-key debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_content_key_from_epoch' = 'SPEC-WebRustCryptoCutover compatibility debt for legacy album-content callers.'
  'crates/mosaic-wasm/src/lib.rs::derive_content_key_from_epoch_js' = 'WASM wrapper for legacy album-content compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_link_keys' = 'SPEC-WebRustCryptoCutover Slice 6 share-link wrapping-key compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_link_keys_js' = 'WASM wrapper for Slice 6 share-link compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_key' = 'Generic legacy unwrap helper retained for web cutover parity.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_key_js' = 'WASM wrapper for generic legacy unwrap helper.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link' = 'SPEC-WebRustCryptoCutover Slice 6 link-share raw tier-key debt.'
  'crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link_js' = 'WASM wrapper for Slice 6 link-share raw tier-key debt.'
  'crates/mosaic-wasm/src/lib.rs::verify_and_open_bundle' = 'SPEC-WebRustCryptoCutover compatibility debt: opened bundle carries epoch seed/signing seed.'
  'crates/mosaic-wasm/src/lib.rs::verify_and_open_bundle_js' = 'WASM wrapper for opened-bundle raw seed debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account' = 'SPEC-WebRustCryptoCutover Slice 8 OPFS DB session-key compatibility debt.'
  'crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account_js' = 'WASM wrapper for Slice 8 DB session-key debt.'
  'crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret' = 'Cross-client vector driver only; returns wrapping_key for parity tests.'
  'crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed' = 'Cross-client vector driver only; OpenedBundleFfiResult carries epoch_seed.'
}

$violations = New-Object System.Collections.Generic.List[string]
foreach ($path in $ffiFiles) {
  $lines = Get-Content -Path $path -ErrorAction Stop
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\s*pub\s+fn\s+([A-Za-z0-9_]+)') { continue }
    $name = $Matches[1]
    if ($name -match 'public_key') { continue }
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

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'no-raw-secret-ffi-export guard FAILED:' -ForegroundColor Red
  foreach ($violation in $violations) { Write-Host "  $violation" }
  Write-Host ''
  Write-Host 'ADR-006/ADR-021 require key access through opaque handles.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'no-raw-secret-ffi-export guard: OK (no new raw key-shaped FFI exports)'
