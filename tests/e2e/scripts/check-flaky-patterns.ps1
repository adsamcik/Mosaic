#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Check for flaky test patterns in E2E test files.

.DESCRIPTION
    Scans test files for patterns known to cause test flakiness:
    - waitForTimeout() calls (use explicit waits instead)
    - networkidle waits (use domcontentloaded + element waits)
    - page.waitForLoadState without explicit state

.EXAMPLE
    .\check-flaky-patterns.ps1
    Runs the check on all test files and exits with error if violations found.

.EXAMPLE
    .\check-flaky-patterns.ps1 -Fix
    Shows suggested fixes for each violation.
#>

param(
    [switch]$Fix,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$script:violations = @()
$testsDir = Join-Path $PSScriptRoot ".." "tests"

# Patterns to check with severity and alternatives
$patterns = @(
    @{
        Pattern = 'waitForTimeout\s*\(\s*[1-9][0-9]{3,}\s*\)'  # 1000ms or more
        Message = "waitForTimeout() with long delays (>=1s) causes slow, flaky tests. Use expect().toPass() or element assertions."
        Severity = "error"
        Allowed = @(
            # Allow in page objects where delay is documented
            "page-objects"
        )
    },
    @{
        Pattern = 'waitForTimeout\s*\(\s*[2-9][0-9]{2}\s*\)'  # 200-999ms
        Message = "waitForTimeout() for animations. Consider CSS animation events or reduce if possible."
        Severity = "warning"
        Allowed = @(
            "page-objects",
            "gallery-animations"  # Animation tests may need delays
        )
    },
    @{
        Pattern = 'waitForLoadState\s*\(\s*[''"]networkidle[''"]'
        Message = "networkidle waits are slow and unreliable. Use 'domcontentloaded' + explicit element assertions."
        Severity = "error"
        Allowed = @()
    },
    @{
        Pattern = 'goto\s*\([^)]+,\s*\{[^}]*waitUntil\s*:\s*[''"]networkidle[''"]'
        Message = "networkidle in goto() is slow. Use 'domcontentloaded' + explicit element assertions."
        Severity = "error"
        Allowed = @()
    }
)

Write-Host "🔍 Checking for flaky test patterns..." -ForegroundColor Cyan
Write-Host ""

# Get all test files
$testFiles = Get-ChildItem -Path $testsDir -Filter "*.spec.ts" -Recurse

foreach ($file in $testFiles) {
    $relativePath = $file.FullName -replace [regex]::Escape((Get-Item $testsDir).Parent.FullName + "\"), ""
    $content = Get-Content $file.FullName -Raw
    $lines = Get-Content $file.FullName
    
    foreach ($check in $patterns) {
        $matches = [regex]::Matches($content, $check.Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        
        foreach ($match in $matches) {
            # Find line number
            $beforeMatch = $content.Substring(0, $match.Index)
            $lineNumber = ($beforeMatch -split "`n").Count
            $lineContent = $lines[$lineNumber - 1].Trim()
            
            # Check if in allowed path
            $isAllowed = $false
            foreach ($allowedPath in $check.Allowed) {
                if ($relativePath -like "*$allowedPath*") {
                    $isAllowed = $true
                    break
                }
            }
            
            if (-not $isAllowed) {
                $script:violations += @{
                    File = $relativePath
                    Line = $lineNumber
                    Content = $lineContent
                    Message = $check.Message
                    Severity = $check.Severity
                }
            }
        }
    }
}

# Report results
$errorCount = ($script:violations | Where-Object { $_.Severity -eq "error" }).Count
$warningCount = ($script:violations | Where-Object { $_.Severity -eq "warning" }).Count

if ($script:violations.Count -eq 0) {
    Write-Host "✅ No flaky patterns found!" -ForegroundColor Green
    exit 0
}

if ($errorCount -gt 0) {
    Write-Host "❌ Found $errorCount error(s) and $warningCount warning(s):" -ForegroundColor Red
} else {
    Write-Host "⚠️ Found $warningCount warning(s) (no blocking errors):" -ForegroundColor Yellow
}
Write-Host ""

foreach ($v in $script:violations) {
    $icon = if ($v.Severity -eq "error") { "🔴" } else { "🟡" }
    Write-Host "$icon $($v.File):$($v.Line)" -ForegroundColor Yellow
    Write-Host "   $($v.Content)" -ForegroundColor Gray
    Write-Host "   → $($v.Message)" -ForegroundColor Cyan
    Write-Host ""
}

if ($Fix) {
    Write-Host "💡 Suggested fixes:" -ForegroundColor Cyan
    Write-Host @"

For waitForTimeout():
  ❌ await page.waitForTimeout(1000);
  ✅ await expect(element).toBeVisible({ timeout: 5000 });
  ✅ await expect(async () => { ... }).toPass({ timeout: 5000 });

For networkidle:
  ❌ await page.goto('/', { waitUntil: 'networkidle' });
  ✅ await page.goto('/', { waitUntil: 'domcontentloaded' });
     await expect(page.getByTestId('main-content')).toBeVisible();

"@
}

Write-Host "Run with -Fix for suggested alternatives." -ForegroundColor Gray

# Exit with error only if there are blocking errors
if ($errorCount -gt 0) {
    exit 1
} else {
    exit 0
}
