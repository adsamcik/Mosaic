#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Mosaic Local Development Script
    Quick deployment and hosting of local builds

.DESCRIPTION
    This script provides commands for local development workflows:
    - Start/stop PostgreSQL database
    - Run backend and frontend with hot-reload
    - Build and run production-like containers locally
    - Quick iteration and testing

.PARAMETER Command
    The operation to perform

.EXAMPLE
    .\dev.ps1 up
    Start database and run backend + frontend with hot-reload

.EXAMPLE
    .\dev.ps1 db
    Start only the PostgreSQL database

.EXAMPLE
    .\dev.ps1 backend
    Run backend with dotnet watch (hot-reload)

.EXAMPLE
    .\dev.ps1 frontend
    Run frontend with Vite dev server (HMR)

.EXAMPLE
    .\dev.ps1 build
    Build and run production containers locally
#>

param(
    [Parameter(Position=0)]
    [ValidateSet(
        "up", "down", "db", "backend", "frontend",
        "build", "rebuild", "logs", "status",
        "reset", "help"
    )]
    [string]$Command = "help",
    
    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Args,
    
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Colors
function Write-Title { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Step { param([string]$msg) Write-Host "  ▶ $msg" -ForegroundColor Yellow }
function Write-Done { param([string]$msg) Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Err { param([string]$msg) Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Info { param([string]$msg) Write-Host "  ℹ $msg" -ForegroundColor Gray }

# Configuration
$DbConnectionString = "Host=localhost;Database=mosaic;Username=mosaic;Password=dev"
$BackendPort = 5000
$FrontendPort = 5173
$DbPort = 5432

Push-Location $ProjectRoot

function Test-CommandExists {
    param([string]$cmd)
    return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Wait-ForDatabase {
    Write-Step "Waiting for PostgreSQL to be ready..."
    $maxAttempts = 30
    $attempt = 0
    
    while ($attempt -lt $maxAttempts) {
        try {
            $result = docker exec mosaic-postgres-dev pg_isready -U mosaic -d mosaic 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Done "PostgreSQL is ready"
                return $true
            }
        } catch {}
        
        $attempt++
        Start-Sleep -Seconds 1
    }
    
    Write-Err "PostgreSQL failed to start within 30 seconds"
    return $false
}

function Start-Database {
    Write-Step "Starting PostgreSQL..."
    docker compose -f docker-compose.dev.yml up -d postgres
    
    if (-not (Wait-ForDatabase)) {
        throw "Database failed to start"
    }
}

function Stop-Database {
    Write-Step "Stopping PostgreSQL..."
    docker compose -f docker-compose.dev.yml down
    Write-Done "Database stopped"
}

function Start-Backend {
    Write-Title "Starting Backend (hot-reload)..."
    
    Push-Location "$ProjectRoot/apps/backend/Mosaic.Backend"
    try {
        $env:ASPNETCORE_ENVIRONMENT = "Development"
        $env:ASPNETCORE_URLS = "http://localhost:$BackendPort"
        $env:ConnectionStrings__Default = $DbConnectionString
        $env:Storage__Path = "$ProjectRoot/data/blobs"
        $env:Auth__TrustedProxies__0 = "127.0.0.0/8"
        $env:RUN_MIGRATIONS = "true"
        
        # Ensure storage directory exists
        New-Item -ItemType Directory -Force -Path "$ProjectRoot/data/blobs" | Out-Null
        
        Write-Info "Backend URL: http://localhost:$BackendPort"
        Write-Info "API Docs: http://localhost:$BackendPort/swagger"
        Write-Host ""
        
        dotnet watch run
    } finally {
        Pop-Location
    }
}

function Start-Frontend {
    Write-Title "Starting Frontend (Vite HMR)..."
    
    # Check if crypto lib is built
    if (-not (Test-Path "$ProjectRoot/libs/crypto/dist")) {
        Write-Step "Building crypto library..."
        Push-Location "$ProjectRoot/libs/crypto"
        npm install
        npm run build
        Pop-Location
    }
    
    Push-Location "$ProjectRoot/apps/admin"
    try {
        # Install dependencies if needed
        if (-not (Test-Path "node_modules")) {
            Write-Step "Installing frontend dependencies..."
            npm install
        }
        
        Write-Info "Frontend URL: http://localhost:$FrontendPort"
        Write-Info "Backend proxy: http://localhost:$BackendPort"
        Write-Host ""
        
        npm run dev
    } finally {
        Pop-Location
    }
}

function Build-AndRun {
    param([switch]$NoCache)
    
    Write-Title "Building production containers..."
    
    $buildArgs = @()
    if ($NoCache) {
        $buildArgs += "--no-cache"
    }
    
    docker compose build @buildArgs
    
    Write-Title "Starting production containers..."
    docker compose up -d
    
    Write-Done "Mosaic is running at http://localhost:8080"
    Write-Info "Run '.\scripts\dev.ps1 logs' to view container logs"
}

try {
    switch ($Command) {
        "up" {
            Write-Title "🚀 Starting Mosaic Development Environment"
            Write-Host ""
            Write-Info "This will start:"
            Write-Info "  • PostgreSQL database (Docker)"
            Write-Info "  • Backend API with hot-reload (dotnet watch)"
            Write-Info "  • Frontend with HMR (Vite)"
            Write-Host ""
            
            # Start database
            Start-Database
            
            Write-Host ""
            Write-Done "Database is ready on port $DbPort"
            Write-Host ""
            Write-Host "Now start backend and frontend in separate terminals:" -ForegroundColor White
            Write-Host ""
            Write-Host "  Terminal 1: .\scripts\dev.ps1 backend" -ForegroundColor Yellow
            Write-Host "  Terminal 2: .\scripts\dev.ps1 frontend" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Or use the concurrent runner:" -ForegroundColor White
            Write-Host ""
            Write-Host "  .\scripts\dev.ps1 backend  # In background (new window)" -ForegroundColor Yellow
            Write-Host ""
            
            if (-not $NoBrowser) {
                Write-Info "Frontend will be at: http://localhost:$FrontendPort"
                Write-Info "Backend API at: http://localhost:$BackendPort"
            }
        }
        
        "down" {
            Write-Title "Stopping development environment..."
            Stop-Database
            Write-Done "Development environment stopped"
        }
        
        "db" {
            Write-Title "Starting PostgreSQL database..."
            Start-Database
            Write-Done "PostgreSQL is running on port $DbPort"
            Write-Info "Connection string: $DbConnectionString"
            
            # Optionally start pgAdmin
            if ($Args -contains "--admin" -or $Args -contains "-a") {
                Write-Step "Starting pgAdmin..."
                docker compose -f docker-compose.dev.yml --profile tools up -d pgadmin
                Write-Done "pgAdmin is running at http://localhost:5050"
                Write-Info "Login: admin@mosaic.local / admin"
            }
        }
        
        "backend" {
            # Ensure database is running
            $dbRunning = docker ps --filter "name=mosaic-postgres-dev" --format "{{.Names}}" 2>$null
            if (-not $dbRunning) {
                Start-Database
            }
            
            Start-Backend
        }
        
        "frontend" {
            Start-Frontend
        }
        
        "build" {
            Build-AndRun
        }
        
        "rebuild" {
            Build-AndRun -NoCache
        }
        
        "logs" {
            $service = if ($Args.Count -gt 0) { $Args[0] } else { "" }
            if ($service) {
                docker compose logs -f $service
            } else {
                docker compose logs -f
            }
        }
        
        "status" {
            Write-Title "Development Environment Status"
            Write-Host ""
            
            # Check Docker containers
            Write-Host "Docker Containers:" -ForegroundColor White
            $devDb = docker ps --filter "name=mosaic-postgres-dev" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>$null
            if ($devDb) {
                Write-Host $devDb
            } else {
                Write-Info "No development containers running"
            }
            Write-Host ""
            
            # Check if backend is running
            Write-Host "Local Processes:" -ForegroundColor White
            try {
                $backend = Invoke-WebRequest -Uri "http://localhost:$BackendPort/health" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
                if ($backend.StatusCode -eq 200) {
                    Write-Host "  Backend:  " -NoNewline
                    Write-Host "Running" -ForegroundColor Green -NoNewline
                    Write-Host " (http://localhost:$BackendPort)"
                }
            } catch {
                Write-Host "  Backend:  " -NoNewline
                Write-Host "Not running" -ForegroundColor Gray
            }
            
            try {
                $frontend = Invoke-WebRequest -Uri "http://localhost:$FrontendPort" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
                if ($frontend.StatusCode -eq 200) {
                    Write-Host "  Frontend: " -NoNewline
                    Write-Host "Running" -ForegroundColor Green -NoNewline
                    Write-Host " (http://localhost:$FrontendPort)"
                }
            } catch {
                Write-Host "  Frontend: " -NoNewline
                Write-Host "Not running" -ForegroundColor Gray
            }
        }
        
        "reset" {
            Write-Title "Resetting development environment..."
            
            Write-Step "Stopping containers..."
            docker compose -f docker-compose.dev.yml down -v
            docker compose down -v 2>$null
            
            Write-Step "Removing local data..."
            Remove-Item -Recurse -Force "$ProjectRoot/data" -ErrorAction SilentlyContinue
            
            Write-Step "Cleaning node_modules (optional)..."
            if ($Args -contains "--full" -or $Args -contains "-f") {
                Remove-Item -Recurse -Force "$ProjectRoot/apps/admin/node_modules" -ErrorAction SilentlyContinue
                Remove-Item -Recurse -Force "$ProjectRoot/libs/crypto/node_modules" -ErrorAction SilentlyContinue
                Write-Done "Full reset complete"
            } else {
                Write-Done "Reset complete (use --full to also remove node_modules)"
            }
        }
        
        "help" {
            Write-Host @"

Mosaic Development Helper
=========================

Usage: .\scripts\dev.ps1 <command> [options]

Commands:
  up          Start PostgreSQL and show instructions for backend/frontend
  down        Stop PostgreSQL and clean up
  db          Start only PostgreSQL (add --admin for pgAdmin)
  backend     Run backend with hot-reload (dotnet watch)
  frontend    Run frontend with HMR (Vite dev server)
  build       Build and run production containers locally
  rebuild     Build without cache and run
  logs        View container logs (optionally specify service)
  status      Show status of development environment
  reset       Reset development environment (--full to remove node_modules)
  help        Show this help message

Quick Start:
  1. .\scripts\dev.ps1 up              # Start database
  2. .\scripts\dev.ps1 backend         # Terminal 1: Start backend
  3. .\scripts\dev.ps1 frontend        # Terminal 2: Start frontend

Production-like Build:
  .\scripts\dev.ps1 build              # Build and run Docker containers

URLs:
  Frontend (dev):  http://localhost:$FrontendPort
  Backend (dev):   http://localhost:$BackendPort
  Swagger:         http://localhost:$BackendPort/swagger
  Production:      http://localhost:8080

"@
        }
    }
} catch {
    Write-Err $_.Exception.Message
    exit 1
} finally {
    Pop-Location
}
