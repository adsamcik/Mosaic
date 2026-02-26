#!/usr/bin/env pwsh
# Mosaic Test Runner
# Runs integration and E2E tests using Docker

param(
    [ValidateSet('all', 'api', 'e2e', 'unit')]
    [string]$Suite = 'all',
    [switch]$Build,
    [switch]$Keep,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Colors
function Write-Info { param($msg) Write-Host $msg -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host $msg -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host $msg -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host $msg -ForegroundColor Red }

Write-Info "🧪 Mosaic Test Runner"
Write-Host "   Suite: $Suite"
Write-Host ""

Push-Location $ProjectRoot

try {
    $exitCode = 0
    $needsDocker = $Suite -eq 'all' -or $Suite -eq 'api' -or $Suite -eq 'e2e'

    # Only start Docker infrastructure if needed
    if ($needsDocker) {
        # Build if requested or if running for first time
        if ($Build) {
            Write-Info "📦 Building test containers..."
            docker compose -f docker-compose.test.yml build
            if ($LASTEXITCODE -ne 0) { throw "Build failed" }
        }

        # Start infrastructure
        Write-Info "🚀 Starting test infrastructure..."
        docker compose -f docker-compose.test.yml up -d postgres backend frontend
        if ($LASTEXITCODE -ne 0) { throw "Failed to start infrastructure" }

        # Wait for services to be healthy
        Write-Info "⏳ Waiting for services to be healthy..."
        $maxWait = 60
        $waited = 0
        while ($waited -lt $maxWait) {
            $healthy = docker compose -f docker-compose.test.yml ps --format json | 
                ConvertFrom-Json | 
                Where-Object { $_.Health -eq "healthy" }
            
            if ($healthy.Count -ge 3) {
                Write-Success "✅ All services healthy"
                break
            }
            
            Start-Sleep -Seconds 2
            $waited += 2
            Write-Host "." -NoNewline
        }
        
        if ($waited -ge $maxWait) {
            throw "Services did not become healthy in time"
        }
    }

    # Run API integration tests
    if ($Suite -eq 'all' -or $Suite -eq 'api') {
        Write-Info ""
        Write-Info "🔌 Running API integration tests..."
        docker compose -f docker-compose.test.yml run --rm api-tests
        if ($LASTEXITCODE -ne 0) { 
            Write-Err "❌ API tests failed"
            $exitCode = 1
        } else {
            Write-Success "✅ API tests passed"
        }
    }

    # Run E2E tests
    if ($Suite -eq 'all' -or $Suite -eq 'e2e') {
        Write-Info ""
        Write-Info "🎭 Running E2E tests..."
        docker compose -f docker-compose.test.yml run --rm e2e-tests
        if ($LASTEXITCODE -ne 0) { 
            Write-Err "❌ E2E tests failed"
            $exitCode = 1
        } else {
            Write-Success "✅ E2E tests passed"
        }
    }

    # Run unit tests (in host environment)
    if ($Suite -eq 'all' -or $Suite -eq 'unit') {
        Write-Info ""
        Write-Info "🧩 Running crypto library unit tests..."
        Push-Location "$ProjectRoot/libs/crypto"
        npm test -- run
        if ($LASTEXITCODE -ne 0) { 
            Write-Err "❌ Crypto unit tests failed"
            $exitCode = 1
        } else {
            Write-Success "✅ Crypto unit tests passed"
        }
        Pop-Location

        Write-Info ""
        Write-Info "🧩 Running admin frontend tests..."
        Push-Location "$ProjectRoot/apps/web"
        npm test -- run
        if ($LASTEXITCODE -ne 0) { 
            Write-Err "❌ Admin tests failed"
            $exitCode = 1
        } else {
            Write-Success "✅ Admin tests passed"
        }
        Pop-Location
    }

    Write-Host ""
    if ($exitCode -eq 0) {
        Write-Success "🎉 All tests passed!"
    } else {
        Write-Err "💥 Some tests failed"
    }

    exit $exitCode
}
finally {
    if ($needsDocker -and -not $Keep) {
        Write-Info ""
        Write-Info "🧹 Cleaning up..."
        docker compose -f docker-compose.test.yml down -v
    } elseif ($needsDocker -and $Keep) {
        Write-Warn "⚠️  Keeping containers running (use 'docker compose -f docker-compose.test.yml down -v' to clean up)"
    }
    Pop-Location
}
