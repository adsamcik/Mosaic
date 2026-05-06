#requires -Version 7
# Slice 0C raw-input FFI architecture guard.
#
# The Slice 0C bridges (AndroidRust{LinkKeys,IdentitySeed,AuthChallenge,
# SealedBundle,Content}Api and their GeneratedRust*Api shell-side
# contracts) take raw secret bytes and exist exclusively to drive the
# cross-client tests/vectors/*.json byte-equality tests. Any non-test
# caller would bypass the handle-based crypto pipeline.
#
# This script greps apps/android-main/src/main/ and
# apps/android-shell/src/main/ for any reference to the five new bridge
# type names. A non-zero match exits 1.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$AndroidMainTypes = @(
  'AndroidRustLinkKeysApi',
  'AndroidRustIdentitySeedApi',
  'AndroidRustAuthChallengeApi',
  'AndroidRustSealedBundleApi',
  'AndroidRustContentApi'
)

$ShellApiTypes = @(
  'GeneratedRustLinkKeysApi',
  'GeneratedRustIdentitySeedApi',
  'GeneratedRustAuthChallengeApi',
  'GeneratedRustSealedBundleApi',
  'GeneratedRustContentApi'
)

$violations = 0

function Find-References {
  param(
    [string[]]$Roots,
    [string]$Type,
    [string[]]$AllowedFileSuffixes
  )
  $matches = @()
  foreach ($root in $Roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem -Path $root -Recurse -Filter '*.kt' -ErrorAction SilentlyContinue | ForEach-Object {
      $file = $_.FullName
      $allowed = $false
      foreach ($suffix in $AllowedFileSuffixes) {
        if ($file -like "*$suffix") { $allowed = $true; break }
      }
      if ($allowed) { return }
      $contents = Get-Content -Path $file -Raw -ErrorAction SilentlyContinue
      if ($null -ne $contents -and $contents -match "\b$Type\b") {
        $matches += $file
      }
    }
  }
  return $matches
}

foreach ($type in $AndroidMainTypes) {
  $allowedSuffix = "${type}.kt"
  $matches = Find-References `
    -Roots @('apps/android-main/src/main') `
    -Type $type `
    -AllowedFileSuffixes @($allowedSuffix)
  if ($matches.Count -gt 0) {
    Write-Error "VIOLATION: production code references Slice 0C raw-input adapter '$type':"
    foreach ($m in $matches) { Write-Host "  $m" }
    $violations++
  }
}

foreach ($type in $ShellApiTypes) {
  $bridgeFile = $type -replace 'Api$', 'Bridge.kt'
  $bridgeFile = "GeneratedRust" + ($bridgeFile -replace '^GeneratedRust', '')
  $adapterFile = ($type -replace '^Generated', 'Android') -replace 'Api$', 'Api.kt'
  $matches = Find-References `
    -Roots @('apps/android-shell/src/main', 'apps/android-main/src/main') `
    -Type $type `
    -AllowedFileSuffixes @($bridgeFile, $adapterFile)
  if ($matches.Count -gt 0) {
    Write-Error "VIOLATION: production code references Slice 0C raw-input contract '$type':"
    foreach ($m in $matches) { Write-Host "  $m" }
    $violations++
  }
}

$AllowedFixtureEmails = @('test@example.com')
$PiiRoots = @('apps/android-main/src/main', 'apps/android-main/src/test')
$PiiEmailRegex = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
$PiiPhoneRegex = '(?<![\w+])\+[1-9]\d{7,14}(?!\w)'
$PiiCameraFileRegex = 'IMG_\d{8}_[A-Za-z0-9_-]+\.jpe?g'
$PiiPatternSourceAllowList = @(
  'MosaicPiiPatterns.kt',
  'PrivacyAuditorTest.kt'
)

foreach ($root in $PiiRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -Filter '*.kt' -ErrorAction SilentlyContinue | ForEach-Object {
    $file = $_.FullName
    $isPatternSource = $false
    foreach ($suffix in $PiiPatternSourceAllowList) {
      if ($file -like "*$suffix") { $isPatternSource = $true; break }
    }
    $contents = Get-Content -Path $file -Raw -ErrorAction SilentlyContinue
    if ($null -eq $contents) { return }

    foreach ($match in [regex]::Matches($contents, $PiiEmailRegex)) {
      if ($AllowedFixtureEmails -notcontains $match.Value -and -not $isPatternSource) {
        Write-Error "VIOLATION: hard-coded email-like PII '$($match.Value)' in $file. Use test@example.com for fixtures."
        $violations++
      }
    }
    if (-not $isPatternSource -and $contents -match $PiiPhoneRegex) {
      Write-Error "VIOLATION: hard-coded E.164 phone-like PII in $file."
      $violations++
    }
    if (-not $isPatternSource -and $contents -match $PiiCameraFileRegex) {
      Write-Error "VIOLATION: hard-coded Android camera filename-like PII in $file."
      $violations++
    }
  }
}

if ($violations -gt 0) {
  Write-Host ""
  Write-Error "kotlin-raw-input-ffi guard found $violations violation(s)."
  Write-Host "The Slice 0C bridges are test-only — see docs/specs/SPEC-AndroidSlice0CCryptoBridges.md"
  exit 1
}

Write-Host "kotlin-raw-input-ffi guard: OK (no production callers of Slice 0C raw-input bridges)"
