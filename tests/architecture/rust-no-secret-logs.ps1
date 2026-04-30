#requires -Version 7
# Rust boundary log redaction guard.
#
# SPEC-CrossPlatformHardening "Secret, PII, and Log Redaction Rules"
# (docs/specs/SPEC-CrossPlatformHardening.md, lines ~83-124) requires:
#   "Rust boundary crates use no `println!`, `eprintln!`, `dbg!`,
#    `tracing::*`, or `log::*` in secret-bearing paths unless a reviewed
#    redaction wrapper is added."
#
# The Mosaic Rust crates carry password buffers, L0/L1/L2 keys, identity
# seeds, epoch seeds, signing seeds, tier keys, share-link wrapping keys,
# wrapped-key plaintext, and decrypted media bytes through their public FFI
# entry points. Any direct logging macro that touches those values is a
# zero-knowledge violation: the crate-internal log goes to stdout/stderr in
# dev, to logcat on Android, and to `console.*` under the WASM target —
# all of which are surfaces the SPEC prohibits.
#
# Walks the production source trees of the workspace boundary crates
# (mosaic-{client,crypto,uniffi,wasm,domain,media}/src/, NOT tests/) and
# fails if any line uses `println!`, `eprintln!`, `dbg!`, `tracing::*` or
# `tracing!` macros, or `log::*`/`log!` macros directly.
#
# Allowed:
#   - Anything under tests/, examples/, benches/ (each crate's non-`src/`
#     trees are excluded by listing only `src/`).
#   - A line that is preceded (same line OR the immediately previous
#     non-blank line) by a comment containing "SAFETY:" — this is the
#     reviewed-redaction-wrapper escape hatch from the SPEC. Reviewers
#     must justify the diagnostic with a SPEC reference. Any new escape
#     hatch lands with the comment in the same commit as the macro call.
#
# Exit code: 0 if clean, 1 if any violation. Failure messages are printed
# with `file:line:`-prefixed paths so they hyperlink in IDE/CI consoles.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

$CrateRoots = @(
    'crates/mosaic-client/src',
    'crates/mosaic-crypto/src',
    'crates/mosaic-uniffi/src',
    'crates/mosaic-wasm/src',
    'crates/mosaic-domain/src',
    'crates/mosaic-media/src'
)

# Each pattern matches a logging macro call. We use word boundaries via
# look-behind on `[^A-Za-z0-9_:]` (or start-of-line) so we don't match e.g.
# `my_println!` or `mod println` or `crate::tracing` paths that aren't a
# logging call. The `!` suffix is required for macro invocations.
$Patterns = @(
    @{ Name = 'println!';   Regex = '(^|[^A-Za-z0-9_:])println!\s*\(' }
    @{ Name = 'eprintln!';  Regex = '(^|[^A-Za-z0-9_:])eprintln!\s*\(' }
    @{ Name = 'dbg!';       Regex = '(^|[^A-Za-z0-9_:])dbg!\s*\(' }
    @{ Name = 'print!';     Regex = '(^|[^A-Za-z0-9_:])print!\s*\(' }
    @{ Name = 'eprint!';    Regex = '(^|[^A-Za-z0-9_:])eprint!\s*\(' }
    @{ Name = 'log::';      Regex = '(^|[^A-Za-z0-9_:])log::(trace|debug|info|warn|error|log)!\s*\(' }
    @{ Name = 'tracing::';  Regex = '(^|[^A-Za-z0-9_:])tracing::(trace|debug|info|warn|error|event|span|instrument)!\s*\(' }
    # Bare `info!`, `warn!`, etc. macros (typical when `use log::*` or
    # `use tracing::*` is in scope). Conservative match.
    @{ Name = 'log_macro';  Regex = '(^|[^A-Za-z0-9_:])(trace|debug|info|warn|error)!\s*\(' }
)

$violations = New-Object System.Collections.Generic.List[string]

function Test-IsAllowedBySafetyComment {
    param(
        [string[]]$AllLines,
        [int]$LineIndex
    )
    # Look at the same line for an inline `// SAFETY: ...` comment that
    # comes BEFORE the macro call (covers `foo(); // SAFETY: spec ref`
    # patterns even though we discourage them).
    $line = $AllLines[$LineIndex]
    if ($line -match '//\s*SAFETY:') {
        return $true
    }
    # Look upward through immediately-preceding lines for the SAFETY
    # comment. We allow any non-blank comment line that mentions SAFETY:
    # to vouch for the *next* code line. Stop at the first non-comment
    # non-blank line.
    for ($probe = $LineIndex - 1; $probe -ge 0; $probe--) {
        $probeLine = $AllLines[$probe]
        if ($probeLine -match '^\s*$') { continue }
        if ($probeLine -match '^\s*//') {
            if ($probeLine -match '//\s*SAFETY:') {
                return $true
            }
            continue
        }
        return $false
    }
    return $false
}

foreach ($root in $CrateRoots) {
    if (-not (Test-Path $root)) {
        $violations.Add("Missing expected crate src tree: $root")
        continue
    }

    $rustFiles = Get-ChildItem -Path $root -Recurse -Filter '*.rs' -ErrorAction Stop
    foreach ($file in $rustFiles) {
        $rel = (Resolve-Path -Relative $file.FullName) -replace '\\', '/'
        # Remove leading "./" if present.
        if ($rel.StartsWith('./')) { $rel = $rel.Substring(2) }

        $lines = Get-Content -Path $file.FullName -ErrorAction Stop
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            # Skip lines that are entirely comments to keep matchers fast.
            if ($line -match '^\s*//') { continue }
            foreach ($pattern in $Patterns) {
                if ($line -match $pattern.Regex) {
                    if (Test-IsAllowedBySafetyComment -AllLines $lines -LineIndex $i) {
                        continue
                    }
                    $violations.Add("$rel`:$($i+1): direct logging macro '$($pattern.Name)' is forbidden in Rust boundary code -> $($line.TrimEnd())")
                }
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host ''
    Write-Host 'rust-no-secret-logs guard FAILED:' -ForegroundColor Red
    foreach ($v in $violations) {
        Write-Host "  $v"
    }
    Write-Host ''
    Write-Host 'Background: SPEC-CrossPlatformHardening forbids direct println!/eprintln!/' -ForegroundColor Yellow
    Write-Host 'dbg!/tracing::*/log::* macros in production Rust boundary code (see spec' -ForegroundColor Yellow
    Write-Host 'docs/specs/SPEC-CrossPlatformHardening.md, "Secret, PII, and Log Redaction' -ForegroundColor Yellow
    Write-Host 'Rules"). Route diagnostics through the existing structured FFI error envelopes' -ForegroundColor Yellow
    Write-Host '(ClientError + ClientErrorCode) instead, or annotate the call site with a' -ForegroundColor Yellow
    Write-Host '`// SAFETY: <SPEC reference>` comment after explicit reviewer approval.' -ForegroundColor Yellow
    exit 1
}

Write-Host 'rust-no-secret-logs guard: OK (no direct logging macros in Rust boundary src/ trees)'
