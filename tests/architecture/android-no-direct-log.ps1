#requires -Version 7
# Android no-direct-log architecture guard.
#
# Enforces the "Android shell" slice of SPEC-CrossPlatformHardening's
# "Secret, PII, and Log Redaction Rules". Production Kotlin code in the
# Android shell + Android Gradle module must NOT call:
#   - android.util.Log.{v,d,i,w,e,wtf}
#   - Timber.*
#   - top-level kotlin println / print (or kotlin.io.println explicit imports)
#
# These APIs route to logcat / stdout without redaction wrappers. A future
# centralized logger will own the runtime path; until then any direct call
# is treated as a privacy regression.
#
# Allowed paths (NOT scanned):
#   - src/test/, src/androidTest/  (test sources may use println for PASS/FAIL)
#   - generated source under build/generated/ (UniFFI bindings)
#
# Exit code:
#   0  no violations
#   1  one or more violations; lines are printed as file:line  pattern  text
#
# This guard joins the family of:
#   - tests/architecture/rust-boundaries.{ps1,sh}
#   - tests/architecture/kotlin-raw-input-ffi.{ps1,sh}
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$Roots = @(
  'apps/android-shell/src/main/kotlin',
  'apps/android-main/src/main/kotlin'
)

# Ordered patterns. Each entry: name + .NET regex.
# Notes:
#   - We anchor on word boundaries so identifiers like `printStackTrace`,
#     `RangePrintable`, or our own `imprint(...)` are not flagged.
#   - The `print`/`println` patterns require the call to be either at the
#     start of a line (top-level) or preceded by something other than a
#     dot/identifier char (e.g. whitespace, `{`, `(`, `;`). This excludes
#     legitimate member calls such as `myList.print()` while still catching
#     `kotlin.io.println(...)` and bare `println("...")`.
$Patterns = @(
  @{ Name = 'android.util.Log import';     Regex = '\bandroid\.util\.Log\b' },
  @{ Name = 'Log.v(';                       Regex = '(?<![A-Za-z0-9_\.])Log\.v\s*\(' },
  @{ Name = 'Log.d(';                       Regex = '(?<![A-Za-z0-9_\.])Log\.d\s*\(' },
  @{ Name = 'Log.i(';                       Regex = '(?<![A-Za-z0-9_\.])Log\.i\s*\(' },
  @{ Name = 'Log.w(';                       Regex = '(?<![A-Za-z0-9_\.])Log\.w\s*\(' },
  @{ Name = 'Log.e(';                       Regex = '(?<![A-Za-z0-9_\.])Log\.e\s*\(' },
  @{ Name = 'Log.wtf(';                     Regex = '(?<![A-Za-z0-9_\.])Log\.wtf\s*\(' },
  @{ Name = 'Timber.';                      Regex = '(?<![A-Za-z0-9_\.])Timber\.' },
  @{ Name = 'kotlin.io.println(';           Regex = '\bkotlin\.io\.println\s*\(' },
  @{ Name = 'kotlin.io.print(';             Regex = '\bkotlin\.io\.print\s*\(' },
  @{ Name = 'top-level println(';           Regex = '(?<![A-Za-z0-9_\.])println\s*\(' },
  @{ Name = 'top-level print(';             Regex = '(?<![A-Za-z0-9_\.])print\s*\(' }
)

$violations = @()

foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.kt' -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    # Defense-in-depth: even though the roots above only enumerate src/main,
    # double-check that we never read from src/test/ or src/androidTest/ paths.
    $fullPath = $file.FullName -replace '\\', '/'
    if ($fullPath -match '/src/(test|androidTest)/') { continue }
    if ($fullPath -match '/build/generated/') { continue }

    $lineNumber = 0
    foreach ($line in (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)) {
      $lineNumber++
      # Strip line-level comments to avoid flagging discussions/examples in
      # KDoc or `//` comments. Only the code portion of the line is matched.
      $codePart = $line
      $hashHash = $codePart.IndexOf('//')
      if ($hashHash -ge 0) { $codePart = $codePart.Substring(0, $hashHash) }
      if ([string]::IsNullOrWhiteSpace($codePart)) { continue }

      foreach ($pattern in $Patterns) {
        if ($codePart -match $pattern.Regex) {
          $violations += [pscustomobject]@{
            File    = $fullPath
            Line    = $lineNumber
            Pattern = $pattern.Name
            Text    = $line.TrimEnd()
          }
        }
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Host ''
  Write-Host 'android-no-direct-log guard found direct logging in production Kotlin sources:' -ForegroundColor Red
  foreach ($v in $violations) {
    Write-Host ("  {0}:{1}  [{2}]  {3}" -f $v.File, $v.Line, $v.Pattern, $v.Text)
  }
  Write-Host ''
  Write-Host 'These calls bypass redaction and route raw text to logcat / stdout.'
  Write-Host 'Move the call into the centralized logger seam, or relocate the'
  Write-Host 'code to src/test/ or src/androidTest/ where println PASS/FAIL'
  Write-Host 'markers are intentionally allowed.'
  Write-Host ''
  Write-Host ("android-no-direct-log guard: FAIL ({0} violation(s))" -f $violations.Count) -ForegroundColor Red
  exit 1
}

Write-Host 'android-no-direct-log guard: OK (no direct logging in Android production Kotlin sources)'
