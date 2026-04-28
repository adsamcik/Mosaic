#!/usr/bin/env pwsh

param(
    [string]$SpecPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SpecPath) {
    $SpecPath = Join-Path $ProjectRoot "docs\specs\SPEC-Band8FinalValidation.md"
}

function Get-PlainCell {
    param([string]$Value)

    $plain = $Value.Trim()
    if ($plain.StartsWith('`') -and $plain.EndsWith('`') -and $plain.Length -ge 2) {
        $plain = $plain.Substring(1, $plain.Length - 2)
    }

    return $plain.Trim()
}

function Resolve-RepoPath {
    param([string]$RelativePath)

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Path must be repository-relative, got: $RelativePath"
    }

    if ($RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Path must not escape the repository, got: $RelativePath"
    }

    if ($RelativePath -eq ".") {
        return $ProjectRoot
    }

    return Join-Path $ProjectRoot $RelativePath
}

function Get-PackageJson {
    param([string]$WorkingDirectory)

    $packageJsonPath = Join-Path $WorkingDirectory "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "Missing package.json in $WorkingDirectory"
    }

    return Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
}

function Assert-NpmScript {
    param(
        [string]$WorkingDirectory,
        [string]$ScriptName
    )

    $packageJson = Get-PackageJson -WorkingDirectory $WorkingDirectory
    if (-not $packageJson.scripts.PSObject.Properties.Name.Contains($ScriptName)) {
        throw "package.json in $WorkingDirectory does not define script '$ScriptName'"
    }

    $scriptValue = [string]$packageJson.scripts.$ScriptName
    if ($scriptValue -match '(--watch|\bwatch\b|--ui|--debug)') {
        throw "Interactive package script '$ScriptName' is not allowed in the Band 8 matrix: $scriptValue"
    }
}

function Assert-DotNetPath {
    param(
        [string]$Command,
        [string]$WorkingDirectory
    )

    $matches = [regex]::Matches($Command, '(?<!\S)(?<path>\.\\[^ ]+\.(?:slnx|csproj))(?!\S)')
    foreach ($match in $matches) {
        $candidate = Join-Path $WorkingDirectory $match.Groups["path"].Value
        if (-not (Test-Path -LiteralPath $candidate)) {
            throw "dotnet command references missing path: $($match.Groups["path"].Value)"
        }
    }
}

function Assert-Command {
    param(
        [string]$Command,
        [string]$WorkingDirectory
    )

    switch -Regex ($Command) {
        '^\.\\scripts\\[^ ]+\.ps1(?:\s|$)' {
            $scriptRelative = ($Command -split '\s+')[0]
            $scriptPath = Join-Path $ProjectRoot $scriptRelative
            if (-not (Test-Path -LiteralPath $scriptPath)) {
                throw "Missing script referenced by matrix: $scriptRelative"
            }
            return
        }
        '^npm ci$' {
            $lockPath = Join-Path $WorkingDirectory "package-lock.json"
            if (-not (Test-Path -LiteralPath $lockPath)) {
                throw "npm ci requires package-lock.json in $WorkingDirectory"
            }
            return
        }
        '^npm test$' {
            Assert-NpmScript -WorkingDirectory $WorkingDirectory -ScriptName "test"
            return
        }
        '^npm run (?<script>[A-Za-z0-9:_-]+)$' {
            Assert-NpmScript -WorkingDirectory $WorkingDirectory -ScriptName $Matches["script"]
            return
        }
        '^npx playwright install chromium$' {
            $packageJson = Get-PackageJson -WorkingDirectory $WorkingDirectory
            $hasPlaywright = $packageJson.devDependencies.PSObject.Properties.Name.Contains("@playwright/test")
            if (-not $hasPlaywright) {
                throw "Playwright install command must run from the E2E package directory"
            }
            return
        }
        '^dotnet (restore|build|test) ' {
            Assert-DotNetPath -Command $Command -WorkingDirectory $WorkingDirectory
            return
        }
        '^cargo fetch --locked$' {
            $cargoToml = Join-Path $ProjectRoot "Cargo.toml"
            if (-not (Test-Path -LiteralPath $cargoToml)) {
                throw "Missing root Cargo.toml for cargo command"
            }
            return
        }
        '^git --no-pager (status|diff) ' {
            return
        }
        default {
            throw "Unsupported or potentially interactive matrix command: $Command"
        }
    }
}

function Assert-ArtifactPath {
    param(
        [string]$ArtifactPath,
        [string]$Order,
        [hashtable]$SeenArtifacts
    )

    if ([System.IO.Path]::IsPathRooted($ArtifactPath)) {
        throw "Artifact path must be repository-relative, got: $ArtifactPath"
    }

    if ($ArtifactPath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Artifact path must not escape the repository, got: $ArtifactPath"
    }

    if ($ArtifactPath -match '(?i)(^|[\\/])(tmp|temp)([\\/]|$)|AppData|\\Users\\') {
        throw "Artifact path must not use temp or user-profile locations, got: $ArtifactPath"
    }

    $escapedOrder = [regex]::Escape($Order)
    if ($ArtifactPath -notmatch "^artifacts\\validation\\band8\\$escapedOrder-[a-z0-9-]+\.txt$") {
        throw "Artifact path must be artifacts\validation\band8\$Order-*.txt, got: $ArtifactPath"
    }

    if ($SeenArtifacts.ContainsKey($ArtifactPath)) {
        throw "Duplicate artifact path in matrix: $ArtifactPath"
    }

    $SeenArtifacts[$ArtifactPath] = $true
}

if (-not (Test-Path -LiteralPath $SpecPath)) {
    throw "Missing Band 8 validation spec: $SpecPath"
}

$content = Get-Content -LiteralPath $SpecPath
$start = [Array]::IndexOf($content, "<!-- BAND8_MATRIX_START -->")
$end = [Array]::IndexOf($content, "<!-- BAND8_MATRIX_END -->")

if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
    throw "Band 8 validation matrix markers are missing or out of order."
}

$matrixLines = $content[($start + 1)..($end - 1)]
$rows = @()
foreach ($line in $matrixLines) {
    if ($line -notmatch '^\|') {
        continue
    }

    if ($line -match '^\|\s*-+') {
        continue
    }

    $cells = $line.Trim().Trim('|') -split '\s*\|\s*'
    if ($cells.Count -ne 5) {
        throw "Matrix row must have 5 columns: $line"
    }

    if ((Get-PlainCell $cells[0]) -eq "Order") {
        continue
    }

    $rows += [pscustomobject]@{
        Order = Get-PlainCell $cells[0]
        Lane = Get-PlainCell $cells[1]
        WorkingDirectory = Get-PlainCell $cells[2]
        Command = Get-PlainCell $cells[3]
        Artifact = Get-PlainCell $cells[4]
    }
}

if ($rows.Count -eq 0) {
    throw "Band 8 validation matrix contains no command rows."
}

$seenOrders = @{}
$seenArtifacts = @{}
$requiredLanes = @("backend", "web", "rust", "android shell", "crypto", "e2e")

foreach ($row in $rows) {
    if ($row.Order -notmatch '^\d{2}$') {
        throw "Matrix order must be two digits, got: $($row.Order)"
    }

    if ($seenOrders.ContainsKey($row.Order)) {
        throw "Duplicate matrix order: $($row.Order)"
    }
    $seenOrders[$row.Order] = $true

    $workingDirectoryPath = Resolve-RepoPath -RelativePath $row.WorkingDirectory
    if (-not (Test-Path -LiteralPath $workingDirectoryPath -PathType Container)) {
        throw "Missing matrix working directory: $($row.WorkingDirectory)"
    }

    Assert-Command -Command $row.Command -WorkingDirectory $workingDirectoryPath
    Assert-ArtifactPath -ArtifactPath $row.Artifact -Order $row.Order -SeenArtifacts $seenArtifacts
}

$lanes = $rows | ForEach-Object { $_.Lane.ToLowerInvariant() } | Select-Object -Unique
foreach ($requiredLane in $requiredLanes) {
    if ($lanes -notcontains $requiredLane) {
        throw "Band 8 matrix is missing required lane: $requiredLane"
    }
}

$specText = $content -join "`n"
foreach ($requiredPhrase in @(
    "product regression",
    "test flake",
    "environment issue",
    "known deferred non-blocker",
    "Fix-Forward Rerun Policy",
    "Cleanup Rules",
    "Output Capture Contract"
)) {
    if ($specText -notmatch [regex]::Escape($requiredPhrase)) {
        throw "Spec is missing required readiness phrase: $requiredPhrase"
    }
}

$gitignorePath = Join-Path $ProjectRoot ".gitignore"
$gitignoreText = Get-Content -LiteralPath $gitignorePath -Raw
if ($gitignoreText -notmatch '(?m)^artifacts/$') {
    throw ".gitignore must ignore artifacts/ so Band 8 captures are not staged accidentally."
}

Write-Host "Band 8 validation readiness matrix is structurally valid."
Write-Host "Rows checked: $($rows.Count)"
Write-Host "No expensive validation commands were executed."
