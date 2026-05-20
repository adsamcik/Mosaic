#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WasmBindgenVersion = "0.2.118"

Push-Location $ProjectRoot

try {
    # Security guard (HIGH security-review-2026-05-20-02 + -03): weak-kdf
    # feature MUST NOT write into the canonical production WASM path.
    # Canonicalizes both sides to defeat `./`, `..`, trailing separators,
    # absolute aliases, and symlinks. See scripts/build-rust-wasm.sh for the
    # matching bash guard.
    $CanonicalOutDir = 'apps/web/src/generated/mosaic-wasm'
    $ExpectedWeakOutDir = 'apps/web/src/generated/mosaic-wasm-test-weak'

    function Resolve-MosaicCanonicalPath {
        param([Parameter(Mandatory)][string]$Path)
        # [System.IO.Path]::GetFullPath resolves `.`, `..`, repeated and
        # trailing separators without requiring the path to exist.
        $full = [System.IO.Path]::GetFullPath($Path)
        if (Test-Path -LiteralPath $full) {
            try {
                $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
                # ReparsePoint flag covers symlinks and junctions on Windows.
                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    if ($item.Target) {
                        $target = $item.Target
                        if (-not [System.IO.Path]::IsPathRooted($target)) {
                            $target = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $full) $target))
                        }
                        return [System.IO.Path]::GetFullPath($target)
                    }
                }
                return $item.FullName
            }
            catch {
                return $full
            }
        }
        return $full
    }

    $RepoRootAbs = [System.IO.Path]::GetFullPath($ProjectRoot)
    $CanonicalAbs = Resolve-MosaicCanonicalPath (Join-Path $RepoRootAbs $CanonicalOutDir)
    $ExpectedWeakAbs = Resolve-MosaicCanonicalPath (Join-Path $RepoRootAbs $ExpectedWeakOutDir)

    if ($env:MOSAIC_WASM_CARGO_FEATURES) {
        $featureList = ",$($env:MOSAIC_WASM_CARGO_FEATURES),"
        if ($featureList -like '*,weak-kdf,*') {
            $effectiveRaw = if ($env:MOSAIC_WASM_OUT_DIR) { $env:MOSAIC_WASM_OUT_DIR } else { $CanonicalOutDir }
            if ([System.IO.Path]::IsPathRooted($effectiveRaw)) {
                $effectiveInput = $effectiveRaw
            }
            else {
                $effectiveInput = Join-Path $RepoRootAbs $effectiveRaw
            }
            $effectiveAbs = Resolve-MosaicCanonicalPath $effectiveInput

            # Case-insensitive on Windows, case-sensitive on Linux/macOS.
            $cmp = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
                [System.StringComparison]::OrdinalIgnoreCase
            }
            else {
                [System.StringComparison]::Ordinal
            }

            if ([string]::Equals($effectiveAbs, $CanonicalAbs, $cmp)) {
                [Console]::Error.WriteLine("[ERROR] weak-kdf feature must NOT write to the canonical production path.")
                [Console]::Error.WriteLine("   canonical: $CanonicalAbs")
                [Console]::Error.WriteLine("   requested: $effectiveAbs (raw: $effectiveRaw)")
                [Console]::Error.WriteLine("   Writing weak-kdf bytes there would undermine the production crypto floor (security-review-2026-05-20-02 + -03).")
                exit 64
            }
            if (-not [string]::Equals($effectiveAbs, $ExpectedWeakAbs, $cmp)) {
                [Console]::Error.WriteLine("[ERROR] weak-kdf builds must write to $ExpectedWeakOutDir.")
                [Console]::Error.WriteLine("   expected: $ExpectedWeakAbs")
                [Console]::Error.WriteLine("   requested: $effectiveAbs (raw: $effectiveRaw)")
                exit 64
            }
            # Symlink defense-in-depth.
            if (Test-Path -LiteralPath $effectiveInput) {
                $linkItem = Get-Item -LiteralPath $effectiveInput -Force -ErrorAction SilentlyContinue
                if ($linkItem -and ($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $linkItem.Target) {
                    $linkTarget = $linkItem.Target
                    if (-not [System.IO.Path]::IsPathRooted($linkTarget)) {
                        $linkTarget = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $effectiveInput) $linkTarget))
                    }
                    $linkTargetAbs = [System.IO.Path]::GetFullPath($linkTarget)
                    if ([string]::Equals($linkTargetAbs, $CanonicalAbs, $cmp)) {
                        [Console]::Error.WriteLine("[ERROR] MOSAIC_WASM_OUT_DIR is a symlink resolving to canonical production path.")
                        [Console]::Error.WriteLine("   link: $effectiveInput -> $linkTargetAbs")
                        exit 64
                    }
                }
            }
        }
    }

    $installedTargets = rustup target list --installed
    if ($installedTargets -notcontains "wasm32-unknown-unknown") {
        rustup target add wasm32-unknown-unknown
    }

    if (-not (Get-Command wasm-bindgen -ErrorAction SilentlyContinue)) {
        throw "wasm-bindgen CLI is required. Install it with: cargo install wasm-bindgen-cli --version $WasmBindgenVersion --locked"
    }

    $versionOutput = wasm-bindgen --version
    if ($versionOutput -notmatch "wasm-bindgen\s+([0-9]+\.[0-9]+\.[0-9]+)") {
        throw "Unable to parse wasm-bindgen version from: $versionOutput"
    }

    if ($Matches[1] -ne $WasmBindgenVersion) {
        throw "wasm-bindgen CLI version mismatch: expected $WasmBindgenVersion, got $($Matches[1])"
    }

    # Deterministic WASM artifacts across hosts (Windows MSVC vs Linux):
    # --remap-path-prefix collapses absolute build paths into stable
    # relative tokens so embedded path strings do not leak the host
    # filesystem layout or host target triple. Combined with
    # `lto = "fat"` + `codegen-units = 1` in [profile.release]
    # (Cargo.toml), the wasm-rebuild-invariance CI job sees byte-identical
    # bytes regardless of runner host.
    $RustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { try { rustup show home } catch { Join-Path $env:USERPROFILE ".rustup" } }
    $CargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
    $RustVersionLine = rustc -V
    $RustVersion = if ($RustVersionLine -match "rustc\s+(\S+)") { $Matches[1] } else { "" }
    $HostTriple = (rustc -Vv | Select-String "^host:" | ForEach-Object { $_.Line -split "\s+" } | Select-Object -Last 1)
    $ToolchainDir = Join-Path $RustupHome "toolchains/$RustVersion-$HostTriple"
    $ChannelToolchainDir = Join-Path $RustupHome "toolchains/$RustVersion"
    $Remap = @(
        "--remap-path-prefix=$ProjectRoot=mosaic"
        "--remap-path-prefix=$CargoHome=cargo-home"
        "--remap-path-prefix=$ToolchainDir=rust-toolchain"
        "--remap-path-prefix=$ChannelToolchainDir=rust-toolchain"
        "--remap-path-prefix=$RustupHome=rustup-home"
    ) -join ' '

    $PreviousRustFlags = $env:RUSTFLAGS
    try {
        $env:RUSTFLAGS = if ($PreviousRustFlags) { "$PreviousRustFlags $Remap" } else { $Remap }
        # MEDIUM security-review-2026-05-20-03: previously the PS1 path
        # never forwarded MOSAIC_WASM_CARGO_FEATURES to cargo, so Windows
        # weak-kdf builds silently produced production WASM bytes.
        $cargoArgs = @('build', '-p', 'mosaic-wasm', '--target', 'wasm32-unknown-unknown', '--release', '--locked')
        if ($env:MOSAIC_WASM_CARGO_FEATURES) {
            $cargoArgs += @('--features', $env:MOSAIC_WASM_CARGO_FEATURES)
        }
        & cargo @cargoArgs
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        if ($null -eq $PreviousRustFlags) {
            Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
        }
        else {
            $env:RUSTFLAGS = $PreviousRustFlags
        }
    }

    $OutDir = Join-Path $ProjectRoot "target/wasm-bindgen/mosaic-wasm"
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    wasm-bindgen `
        --target web `
        --out-dir $OutDir `
        "$ProjectRoot/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"

    # Output directory inside the web app. Defaults to the canonical
    # production path; can be overridden (e.g. for the test-only weak-kdf
    # artifact at apps/web/src/generated/mosaic-wasm-test-weak). Override
    # is interpreted relative to $ProjectRoot when given as a relative path.
    $OutSubpath = if ($env:MOSAIC_WASM_OUT_DIR) { $env:MOSAIC_WASM_OUT_DIR } else { 'apps/web/src/generated/mosaic-wasm' }
    if ([System.IO.Path]::IsPathRooted($OutSubpath)) {
        $WebOutDir = $OutSubpath
    } else {
        $WebOutDir = Join-Path $ProjectRoot $OutSubpath
    }
    New-Item -ItemType Directory -Force -Path $WebOutDir | Out-Null
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.js") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm.d.ts") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm") -Destination $WebOutDir
    Copy-Item -Force -Path (Join-Path $OutDir "mosaic_wasm_bg.wasm.d.ts") -Destination $WebOutDir
}
finally {
    Pop-Location
}
