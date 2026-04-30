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

if ($violations -gt 0) {
  Write-Host ""
  Write-Error "kotlin-raw-input-ffi guard found $violations violation(s)."
  Write-Host "The Slice 0C bridges are test-only — see docs/specs/SPEC-AndroidSlice0CCryptoBridges.md"
  exit 1
}

Write-Host "kotlin-raw-input-ffi guard: OK (no production callers of Slice 0C raw-input bridges)"
