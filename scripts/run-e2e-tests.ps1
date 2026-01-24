#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Run Mosaic E2E tests with full stack (PostgreSQL + Backend + Frontend)

.DESCRIPTION
    This script automates the complete E2E test environment:
    1. Starts PostgreSQL via Docker Compose
    2. Runs database migrations
    3. Starts the .NET backend
    4. Starts the Vite frontend dev server
    5. Runs Playwright tests
    6. Cleans up all processes on exit

.PARAMETER Project
    Playwright project to run (chromium, firefox, mobile-chrome, or all)
    Default: chromium

.PARAMETER TestFile
    Specific test file to run (e.g., "auth.spec.ts")
    Default: runs all tests

.PARAMETER Headed
    Run tests in headed mode (visible browser)

.PARAMETER Debug
    Run in Playwright debug mode

.PARAMETER SkipBuild
    Skip npm install steps

.EXAMPLE
    ./scripts/run-e2e-tests.ps1
    ./scripts/run-e2e-tests.ps1 -Project firefox
    ./scripts/run-e2e-tests.ps1 -TestFile auth.spec.ts -Headed
    ./scripts/run-e2e-tests.ps1 -Debug
#>

param(
    [ValidateSet("chromium", "firefox", "mobile-chrome", "all")]
    [string]$Project = "chromium",
    
    [string]$TestFile = "",
    
    [switch]$Headed,
    
    [switch]$Debug,
    
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$script:BackendProcess = $null
$script:FrontendProcess = $null
$script:CleanupDone = $false

# Colors for output
function Write-Step { param($msg) Write-Host "`n[$([char]0x2192)] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[$([char]0x2714)] $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "[$([char]0x2718)] $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "    $msg" -ForegroundColor Gray }

# Get the repository root
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path "$RepoRoot/docker-compose.dev.yml")) {
    $RepoRoot = $PSScriptRoot | Split-Path -Parent
}

Write-Host "`n========================================" -ForegroundColor Magenta
Write-Host "  Mosaic E2E Test Runner" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Info "Repository: $RepoRoot"

# Cleanup function
function Invoke-Cleanup {
    if ($script:CleanupDone) { return }
    $script:CleanupDone = $true
    
    Write-Step "Cleaning up..."
    
    # Stop frontend
    if ($script:FrontendProcess -and -not $script:FrontendProcess.HasExited) {
        Write-Info "Stopping frontend server..."
        Stop-Process -Id $script:FrontendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Stop backend
    if ($script:BackendProcess -and -not $script:BackendProcess.HasExited) {
        Write-Info "Stopping backend server..."
        Stop-Process -Id $script:BackendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Kill any orphaned processes on our ports
    $portsToClean = @(5173, 8080)
    foreach ($port in $portsToClean) {
        $proc = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | 
                Select-Object -ExpandProperty OwningProcess -Unique
        if ($proc) {
            Stop-Process -Id $proc -Force -ErrorAction SilentlyContinue
        }
    }
    
    Write-Success "Cleanup complete"
}

# Register cleanup on script exit
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Invoke-Cleanup }
trap { Invoke-Cleanup; break }

try {
    # ==========================================================================
    # Step 1: Start PostgreSQL
    # ==========================================================================
    Write-Step "Starting PostgreSQL..."
    
    Push-Location $RepoRoot
    $dockerResult = docker compose -f docker-compose.dev.yml up -d postgres 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Failed to start PostgreSQL"
        Write-Host $dockerResult
        exit 1
    }
    Pop-Location
    
    # Wait for PostgreSQL to be healthy
    Write-Info "Waiting for PostgreSQL to be ready..."
    $maxWait = 30
    $waited = 0
    do {
        Start-Sleep -Seconds 1
        $waited++
        $health = docker inspect --format='{{.State.Health.Status}}' mosaic-postgres-dev 2>$null
    } while ($health -ne "healthy" -and $waited -lt $maxWait)
    
    if ($health -ne "healthy") {
        Write-Fail "PostgreSQL did not become healthy within ${maxWait}s"
        exit 1
    }
    Write-Success "PostgreSQL is ready"

    # ==========================================================================
    # Step 2: Run Database Migrations
    # ==========================================================================
    Write-Step "Running database migrations..."
    
    Push-Location "$RepoRoot/apps/backend/Mosaic.Backend"
    $migrationResult = dotnet ef database update 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Migration output: $migrationResult"
        # Don't fail - migrations might already be applied
    }
    Pop-Location
    Write-Success "Database migrations applied"

    # ==========================================================================
    # Step 3: Install dependencies (if not skipped)
    # ==========================================================================
    if (-not $SkipBuild) {
        Write-Step "Installing dependencies..."
        
        # Frontend
        Push-Location "$RepoRoot/apps/admin"
        npm install --silent 2>$null
        Pop-Location
        
        # E2E tests
        Push-Location "$RepoRoot/tests/e2e"
        npm install --silent 2>$null
        npx playwright install chromium --with-deps 2>$null
        Pop-Location
        
        Write-Success "Dependencies installed"
    }

    # ==========================================================================
    # Step 4: Start Backend
    # ==========================================================================
    Write-Step "Starting .NET backend on port 8080..."
    
    # Kill any existing process on port 8080
    $existing = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | 
                Select-Object -ExpandProperty OwningProcess -Unique
    if ($existing) {
        Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    
    $backendPath = "$RepoRoot/apps/backend/Mosaic.Backend"
    
    # Set environment variables for E2E tests:
    # - Development mode loads appsettings.Development.json (has trusted proxies for localhost)
    # - ProxyAuth enabled so Remote-User header is recognized
    # - LocalAuth enabled for tests that use username/password
    # Use cmd.exe with set commands to pass env vars to the process
    $script:BackendProcess = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "set ASPNETCORE_ENVIRONMENT=Development && set Auth__ProxyAuthEnabled=true && set Auth__LocalAuthEnabled=true && set Auth__TrustedProxies__0=127.0.0.0/8 && set Auth__TrustedProxies__1=::1/128 && dotnet run --urls=http://localhost:8080" `
        -WorkingDirectory $backendPath `
        -PassThru `
        -WindowStyle Hidden
    
    # Wait for backend to be ready
    Write-Info "Waiting for backend to be ready (max 60s)..."
    $maxWait = 60
    $waited = 0
    $backendReady = $false
    do {
        Start-Sleep -Seconds 2
        $waited += 2
        
        # Check if process died
        if ($script:BackendProcess.HasExited) {
            Write-Fail "Backend process died during startup (exit code: $($script:BackendProcess.ExitCode))"
            exit 1
        }
        
        try {
            # Use /health (not /api/health) - this endpoint bypasses auth
            $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                $backendReady = $true
            }
        } catch {
            # Not ready yet
        }
    } while (-not $backendReady -and $waited -lt $maxWait)
    
    if (-not $backendReady) {
        Write-Fail "Backend did not become ready within ${maxWait}s"
        # Kill the hung process
        if (-not $script:BackendProcess.HasExited) {
            Stop-Process -Id $script:BackendProcess.Id -Force -ErrorAction SilentlyContinue
        }
        exit 1
    }
    Write-Success "Backend is ready at http://localhost:8080"

    # ==========================================================================
    # Step 5: Start Frontend
    # ==========================================================================
    Write-Step "Starting Vite frontend on port 5173..."
    
    # Kill any existing process on port 5173
    $existing = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | 
                Select-Object -ExpandProperty OwningProcess -Unique
    if ($existing) {
        Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    
    $frontendPath = "$RepoRoot/apps/admin"
    
    # Set weak keys mode for fast E2E testing
    $env:VITE_E2E_WEAK_KEYS = "true"
    
    # Use cmd to run npm since npm.ps1 doesn't work well with Start-Process
    $script:FrontendProcess = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "set VITE_E2E_WEAK_KEYS=true && npm run dev" `
        -WorkingDirectory $frontendPath `
        -PassThru `
        -WindowStyle Hidden
    
    # Wait for frontend to be ready
    Write-Info "Waiting for frontend to be ready..."
    $maxWait = 60
    $waited = 0
    do {
        Start-Sleep -Seconds 1
        $waited++
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 2 -ErrorAction SilentlyContinue
            $frontendReady = $response.StatusCode -eq 200
        } catch {
            $frontendReady = $false
        }
    } while (-not $frontendReady -and $waited -lt $maxWait)
    
    if (-not $frontendReady) {
        Write-Fail "Frontend did not become ready within ${maxWait}s"
        exit 1
    }
    Write-Success "Frontend is ready at http://localhost:5173"

    # ==========================================================================
    # Step 6: Run Playwright Tests
    # ==========================================================================
    Write-Step "Running Playwright E2E tests..."
    Write-Host ""
    
    Push-Location "$RepoRoot/tests/e2e"
    
    # Build the playwright command
    $playwrightArgs = @("test")
    
    if ($TestFile) {
        $playwrightArgs += $TestFile
    }
    
    if ($Project -ne "all") {
        $playwrightArgs += "--project=$Project"
    }
    
    if ($Headed) {
        $playwrightArgs += "--headed"
    }
    
    if ($Debug) {
        $playwrightArgs += "--debug"
    }
    
    Write-Info "Command: npx playwright $($playwrightArgs -join ' ')"
    Write-Host ""
    
    # Run the tests - use the local playwright binary directly
    $playwrightBin = Join-Path $RepoRoot "tests/e2e/node_modules/.bin/playwright.ps1"
    if (Test-Path $playwrightBin) {
        & $playwrightBin @playwrightArgs
    } else {
        # Fallback to npx
        & npx playwright @playwrightArgs
    }
    $testExitCode = $LASTEXITCODE
    
    Pop-Location
    
    Write-Host ""
    if ($testExitCode -eq 0) {
        Write-Success "All tests passed!"
    } else {
        Write-Fail "Some tests failed (exit code: $testExitCode)"
    }

} finally {
    Invoke-Cleanup
}

exit $testExitCode
