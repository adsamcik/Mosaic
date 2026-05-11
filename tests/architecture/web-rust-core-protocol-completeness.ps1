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

$ScanRoots = @(
  'apps/web/src',
  'libs/crypto/src'
)
$Allowlist = @(
  'apps/web/src/lib/session.ts',
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
    Name = 'WebCrypto deriveBits'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*deriveBits\b'
    Message = 'protocol-class KDF derivation must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto deriveKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*deriveKey\b'
    Message = 'protocol-class key derivation must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto HMAC importKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*importKey\b[\s\S]{0,500}\bHMAC\b'
    Message = 'protocol-class HMAC must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto HKDF importKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*importKey\b[\s\S]{0,500}\bHKDF\b'
    Message = 'protocol-class HKDF must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto PBKDF2 importKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*importKey\b[\s\S]{0,500}\bPBKDF2\b'
    Message = 'protocol-class PBKDF2 must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto sign'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*sign\b'
    Message = 'protocol-class signing must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto verify'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*verify\b'
    Message = 'protocol-class signature verification must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto encrypt'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*encrypt\b'
    Message = 'protocol-class encryption must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto decrypt'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*decrypt\b'
    Message = 'protocol-class decryption must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto wrapKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*wrapKey\b'
    Message = 'protocol-class key wrapping must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto unwrapKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*unwrapKey\b'
    Message = 'protocol-class key unwrapping must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto generateKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*generateKey\b'
    Message = 'protocol-class key generation must use Rust core/WASM helpers'
  },
  @{
    Name = 'WebCrypto exportKey'
    Pattern = '\b(?:globalThis\.|window\.|self\.)?crypto\s*\.\s*subtle\s*\.\s*exportKey\b'
    Message = 'protocol-class key export must use Rust core/WASM helpers'
  },
  @{
    Name = 'forbidden_libsodium_named_imports'
    Pattern = 'import\s+(?:type\s+)?\{[^}]*\b(crypto_hash_sha256|crypto_generichash|crypto_secretbox|crypto_pwhash|crypto_sign|crypto_box|crypto_kx|crypto_aead_|crypto_kdf_|crypto_auth)\w*[^}]*\}\s+from\s+[''"]libsodium-wrappers-sumo[''"]'
    Message = 'protocol-class libsodium primitives must not be imported directly; use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium namespace import'
    Pattern = 'import\s+\*\s+as\s+\w+\s+from\s+[''"]libsodium-wrappers-sumo[''"]'
    Message = 'protocol-class libsodium primitives must not be accessed through namespace imports'
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
    Pattern = '\bsodium\s*\.\s*crypto_secretbox'
    Message = 'protocol-class symmetric encryption must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium pwhash'
    Pattern = '\bsodium\s*\.\s*crypto_pwhash\b'
    Message = 'protocol-class password hashing must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium signing'
    Pattern = '\bsodium\s*\.\s*crypto_sign'
    Message = 'protocol-class signing must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium box'
    Pattern = '\bsodium\s*\.\s*crypto_box(_easy|_open_easy|_seal|_seal_open|_keypair|_curve25519xchacha20poly1305_)?\b'
    Message = 'protocol-class public-key encryption must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium key exchange'
    Pattern = '\bsodium\s*\.\s*crypto_kx_\w+\b'
    Message = 'protocol-class key exchange must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium AEAD'
    Pattern = '\bsodium\s*\.\s*crypto_aead_\w+\b'
    Message = 'protocol-class AEAD must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium auth'
    Pattern = '\bsodium\s*\.\s*crypto_auth(_\w+)?\b'
    Message = 'protocol-class authentication tags must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium KDF'
    Pattern = '\bsodium\s*\.\s*crypto_kdf_\w+\b'
    Message = 'protocol-class KDF derivation must use Rust core/WASM helpers'
  },
  @{
    Name = 'libsodium primitive destructure'
    Pattern = '(?:const|let|var)\s*\{[^}]*\b(crypto_pwhash|crypto_secretbox|crypto_aead|crypto_box|crypto_kx|crypto_kdf|crypto_auth|crypto_hash|crypto_sign|crypto_generichash)\b[^}]*\}\s*=\s*\w+'
    Message = 'protocol-class libsodium primitives must not be destructured from imported sodium bindings'
  },
  @{
    Name = 'libsodium bare primitive call'
    Pattern = '(?:^|\W)(crypto_pwhash|crypto_secretbox|crypto_aead|crypto_box|crypto_kx|crypto_kdf|crypto_auth|crypto_hash|crypto_sign|crypto_generichash)\s*\('
    Message = 'protocol-class libsodium primitive calls must use Rust core/WASM helpers'
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
Assert-NegativeFixtureCaught 'webcrypto-derive-bits' "await crypto.subtle.deriveBits({ name: 'HKDF' }, key, 128);" 'WebCrypto deriveBits'
Assert-NegativeFixtureCaught 'webcrypto-derive-key' "await crypto.subtle.deriveKey(params, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);" 'WebCrypto deriveKey'
Assert-NegativeFixtureCaught 'webcrypto-hmac-import' "await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);" 'WebCrypto HMAC importKey'
Assert-NegativeFixtureCaught 'webcrypto-hkdf-import' "await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);" 'WebCrypto HKDF importKey'
Assert-NegativeFixtureCaught 'webcrypto-pbkdf2-import' "await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);" 'WebCrypto PBKDF2 importKey'
Assert-NegativeFixtureCaught 'webcrypto-sign' "await crypto.subtle.sign('HMAC', key, bytes);" 'WebCrypto sign'
Assert-NegativeFixtureCaught 'webcrypto-verify' "await crypto.subtle.verify('Ed25519', key, sig, bytes);" 'WebCrypto verify'
Assert-NegativeFixtureCaught 'webcrypto-encrypt' "await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);" 'WebCrypto encrypt'
Assert-NegativeFixtureCaught 'webcrypto-decrypt' "await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes);" 'WebCrypto decrypt'
Assert-NegativeFixtureCaught 'webcrypto-wrap-key' "await crypto.subtle.wrapKey('raw', key, wrappingKey, 'AES-GCM');" 'WebCrypto wrapKey'
Assert-NegativeFixtureCaught 'webcrypto-unwrap-key' "await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, 'AES-GCM', 'AES-GCM', false, ['encrypt']);" 'WebCrypto unwrapKey'
Assert-NegativeFixtureCaught 'webcrypto-generate-key' "await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);" 'WebCrypto generateKey'
Assert-NegativeFixtureCaught 'webcrypto-export-key' "await crypto.subtle.exportKey('raw', key);" 'WebCrypto exportKey'
Assert-NegativeFixtureCaught 'libsodium-named-import' "import { crypto_pwhash, crypto_secretbox_easy } from 'libsodium-wrappers-sumo';" 'forbidden_libsodium_named_imports'
Assert-NegativeFixtureCaught 'libsodium-namespace-import' "import * as sodiumFacade from 'libsodium-wrappers-sumo'; sodiumFacade.crypto_pwhash(32, password, salt, 2, 65536, 2);" 'libsodium namespace import'
Assert-NegativeFixtureCaught 'libsodium-sha256' 'sodium.crypto_hash_sha256(bytes);' 'libsodium SHA-256'
Assert-NegativeFixtureCaught 'libsodium-blake2b' 'sodium.crypto_generichash(32, bytes);' 'libsodium BLAKE2b'
Assert-NegativeFixtureCaught 'libsodium-secretbox' 'sodium.crypto_secretbox_easy(message, nonce, key);' 'libsodium secretbox'
Assert-NegativeFixtureCaught 'libsodium-pwhash' 'sodium.crypto_pwhash(32, password, salt, 2, 65536, sodium.crypto_pwhash_ALG_ARGON2ID13);' 'libsodium pwhash'
Assert-NegativeFixtureCaught 'libsodium-sign' 'sodium.crypto_sign(message, secretKey);' 'libsodium signing'
Assert-NegativeFixtureCaught 'libsodium-box' 'sodium.crypto_box_seal(message, publicKey);' 'libsodium box'
Assert-NegativeFixtureCaught 'libsodium-kx' 'sodium.crypto_kx_client_session_keys(clientPk, clientSk, serverPk);' 'libsodium key exchange'
Assert-NegativeFixtureCaught 'libsodium-aead' 'sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, null, nonce, key);' 'libsodium AEAD'
Assert-NegativeFixtureCaught 'libsodium-auth' 'sodium.crypto_auth(message, key);' 'libsodium auth'
Assert-NegativeFixtureCaught 'libsodium-kdf' 'sodium.crypto_kdf_derive_from_key(32, 1, "context1", key);' 'libsodium KDF'
Assert-NegativeFixtureCaught 'libsodium-destructure-default' "import sodium from 'libsodium-wrappers-sumo'; const { crypto_pwhash } = sodium;" 'libsodium primitive destructure'
Assert-NegativeFixtureCaught 'libsodium-aliased-bare-call' "import sodium from 'libsodium-wrappers-sumo'; const s2: typeof sodium = sodium; await s2.crypto_pwhash(32, password, salt, 2, 65536, 2);" 'libsodium bare primitive call'

$violations = New-Object System.Collections.Generic.List[string]

foreach ($scanRoot in $ScanRoots) {
  if (-not (Test-Path $scanRoot)) {
    throw "scan root missing: $scanRoot"
  }
}

$files = foreach ($scanRoot in $ScanRoots) {
  Get-ChildItem -Path $scanRoot -Recurse -File |
    Where-Object { $_.Name -like '*.ts' }
}

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
