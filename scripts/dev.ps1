#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Mosaic Development Environment Manager

.DESCRIPTION
    Manages local development services (database, backend, frontend) as background processes.
    All services run in the background by default. Use 'logs' to view output.

.EXAMPLE
    .\dev.ps1 start          # Start all services (db, backend, frontend)
    .\dev.ps1 stop           # Stop all services
    .\dev.ps1 restart        # Restart all services
    .\dev.ps1 status         # Show status of all services
    .\dev.ps1 logs backend   # View backend logs
    .\dev.ps1 logs frontend  # View frontend logs
#>

param(
    [Parameter(Position=0)]
    [ValidateSet(
        "start", "stop", "restart", "status", "logs",
        "build", "rebuild", "reset", "help"
    )]
    [string]$Command = "help",
    
    [Parameter(Position=1)]
    [ValidateSet("all", "db", "backend", "frontend", "")]
    [string]$Service = "",
    
    [Parameter(Position=2, ValueFromRemainingArguments=$true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# PID file locations (stored in .mosaic directory)
$PidDir = Join-Path $ProjectRoot ".mosaic"
$BackendPidFile = Join-Path $PidDir "backend.pid"
$FrontendPidFile = Join-Path $PidDir "frontend.pid"
$BackendLogFile = Join-Path $PidDir "backend.log"
$FrontendLogFile = Join-Path $PidDir "frontend.log"

# Configuration
$DbConnectionString = "Host=localhost;Database=mosaic;Username=mosaic;Password=dev"
$BackendPort = 5000
$FrontendPort = 5173
$DbPort = 5432

# Ensure .mosaic directory exists
if (-not (Test-Path $PidDir)) {
    New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
}

# Add to .gitignore if not already there
$gitignore = Join-Path $ProjectRoot ".gitignore"
if (Test-Path $gitignore) {
    $content = Get-Content $gitignore -Raw
    if ($content -notmatch "\.mosaic/") {
        Add-Content -Path $gitignore -Value "`n# Local dev environment state`n.mosaic/"
    }
}

# Colors
function Write-Title { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Step { param([string]$msg) Write-Host "  ▶ $msg" -ForegroundColor Yellow }
function Write-Done { param([string]$msg) Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Err { param([string]$msg) Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Info { param([string]$msg) Write-Host "  ℹ $msg" -ForegroundColor Gray }

function Test-DockerAvailable {
    try {
        $null = docker info 2>&1
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-ProcessRunning {
    param([string]$PidFile)
    if (-not (Test-Path $PidFile)) { return $false }
    $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
    if (-not $procId) { return $false }
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return $null -ne $proc
}

function Stop-ServiceByPidFile {
    param([string]$PidFile, [string]$ServiceName)
    if (Test-Path $PidFile) {
        $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
        if ($procId) {
            try {
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) {
                    # Stop the process tree (including child processes)
                    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    # Also kill any child processes
                    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $procId } | ForEach-Object {
                        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                    }
                    Write-Done "$ServiceName stopped (PID: $procId)"
                }
            } catch {
                # Process already gone
            }
        }
        Remove-Item $PidFile -ErrorAction SilentlyContinue
    }
}

function Wait-ForDatabase {
    $maxAttempts = 30
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        $result = docker exec mosaic-postgres-dev pg_isready -U mosaic -d mosaic 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-DatabaseService {
    $dbRunning = docker ps --filter "name=mosaic-postgres-dev" --format "{{.Names}}" 2>$null
    if ($dbRunning) {
        Write-Info "Database already running"
        return $true
    }
    
    Write-Step "Starting PostgreSQL..."
    Push-Location $ProjectRoot
    docker compose -f docker-compose.dev.yml up -d postgres 2>&1 | Out-Null
    Pop-Location
    
    Write-Step "Waiting for PostgreSQL..."
    if (Wait-ForDatabase) {
        Write-Done "PostgreSQL ready on port $DbPort"
        return $true
    } else {
        Write-Err "PostgreSQL failed to start"
        return $false
    }
}

function Stop-DatabaseService {
    Write-Step "Stopping PostgreSQL..."
    Push-Location $ProjectRoot
    docker compose -f docker-compose.dev.yml down 2>&1 | Out-Null
    Pop-Location
    Write-Done "PostgreSQL stopped"
}

function Start-BackendService {
    if (Test-ProcessRunning $BackendPidFile) {
        Write-Info "Backend already running"
        return
    }
    
    # Stop any orphaned process
    Stop-ServiceByPidFile $BackendPidFile "Backend"
    
    Write-Step "Starting Backend..."
    
    # Ensure storage directory exists
    $storagePath = Join-Path $ProjectRoot "data/blobs"
    New-Item -ItemType Directory -Force -Path $storagePath | Out-Null
    
    # Build the command
    $backendPath = Join-Path $ProjectRoot "apps/backend/Mosaic.Backend"
    
    # Create a wrapper script to run the backend
    $wrapperScript = @"
`$env:ASPNETCORE_ENVIRONMENT = 'Development'
`$env:ASPNETCORE_URLS = 'http://localhost:$BackendPort'
`$env:ConnectionStrings__Default = '$DbConnectionString'
`$env:Storage__Path = '$storagePath'
`$env:Auth__TrustedProxies__0 = '127.0.0.0/8'
`$env:RUN_MIGRATIONS = 'true'
Set-Location '$backendPath'
dotnet watch run --no-hot-reload 2>&1
"@
    
    $wrapperFile = Join-Path $PidDir "run-backend.ps1"
    $wrapperScript | Out-File -FilePath $wrapperFile -Encoding UTF8
    
    # Start as background job and capture PID
    $proc = Start-Process pwsh -ArgumentList "-NoProfile", "-File", $wrapperFile `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $BackendLogFile `
        -RedirectStandardError (Join-Path $PidDir "backend-error.log")
    
    $proc.Id | Out-File -FilePath $BackendPidFile -Encoding UTF8
    
    # Wait a moment and check if it started
    Start-Sleep -Seconds 3
    if (Test-ProcessRunning $BackendPidFile) {
        Write-Done "Backend started (PID: $($proc.Id)) - http://localhost:$BackendPort"
    } else {
        Write-Err "Backend failed to start. Check logs with: .\dev.ps1 logs backend"
    }
}

function Stop-BackendService {
    Stop-ServiceByPidFile $BackendPidFile "Backend"
    
    # Also kill any dotnet processes for this project
    Get-Process -Name "dotnet" -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.CommandLine -like "*Mosaic.Backend*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Start-FrontendService {
    if (Test-ProcessRunning $FrontendPidFile) {
        Write-Info "Frontend already running"
        return
    }
    
    # Stop any orphaned process
    Stop-ServiceByPidFile $FrontendPidFile "Frontend"
    
    Write-Step "Starting Frontend..."
    
    # Check if crypto lib is built
    $cryptoDistPath = Join-Path $ProjectRoot "libs/crypto/dist"
    if (-not (Test-Path $cryptoDistPath)) {
        Write-Step "Building crypto library..."
        Push-Location (Join-Path $ProjectRoot "libs/crypto")
        npm install 2>&1 | Out-Null
        npm run build 2>&1 | Out-Null
        Pop-Location
    }
    
    # Check if frontend dependencies are installed
    $frontendPath = Join-Path $ProjectRoot "apps/admin"
    $nodeModulesPath = Join-Path $frontendPath "node_modules"
    if (-not (Test-Path $nodeModulesPath)) {
        Write-Step "Installing frontend dependencies..."
        Push-Location $frontendPath
        npm install 2>&1 | Out-Null
        Pop-Location
    }
    
    # Create a wrapper script
    $wrapperScript = @"
Set-Location '$frontendPath'
npm run dev 2>&1
"@
    
    $wrapperFile = Join-Path $PidDir "run-frontend.ps1"
    $wrapperScript | Out-File -FilePath $wrapperFile -Encoding UTF8
    
    # Start as background process
    $proc = Start-Process pwsh -ArgumentList "-NoProfile", "-File", $wrapperFile `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $FrontendLogFile `
        -RedirectStandardError (Join-Path $PidDir "frontend-error.log")
    
    $proc.Id | Out-File -FilePath $FrontendPidFile -Encoding UTF8
    
    # Wait a moment and check if it started
    Start-Sleep -Seconds 3
    if (Test-ProcessRunning $FrontendPidFile) {
        Write-Done "Frontend started (PID: $($proc.Id)) - http://localhost:$FrontendPort"
    } else {
        Write-Err "Frontend failed to start. Check logs with: .\dev.ps1 logs frontend"
    }
}

function Stop-FrontendService {
    Stop-ServiceByPidFile $FrontendPidFile "Frontend"
    
    # Also kill any node processes for vite on this port
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        try {
            $connections = Get-NetTCPConnection -OwningProcess $_.Id -ErrorAction SilentlyContinue
            $connections | Where-Object { $_.LocalPort -eq $FrontendPort }
        } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Show-Status {
    Write-Title "Mosaic Development Environment Status"
    Write-Host ""
    
    # Database status
    Write-Host "  Database:  " -NoNewline
    $dbRunning = docker ps --filter "name=mosaic-postgres-dev" --format "{{.Status}}" 2>$null
    if ($dbRunning) {
        Write-Host "Running" -ForegroundColor Green -NoNewline
        Write-Host " (port $DbPort)"
    } else {
        Write-Host "Stopped" -ForegroundColor Gray
    }
    
    # Backend status
    Write-Host "  Backend:   " -NoNewline
    if (Test-ProcessRunning $BackendPidFile) {
        $backendProcId = Get-Content $BackendPidFile
        Write-Host "Running" -ForegroundColor Green -NoNewline
        Write-Host " (PID: $backendProcId, port $BackendPort)"
    } else {
        Write-Host "Stopped" -ForegroundColor Gray
    }
    
    # Frontend status
    Write-Host "  Frontend:  " -NoNewline
    if (Test-ProcessRunning $FrontendPidFile) {
        $frontendProcId = Get-Content $FrontendPidFile
        Write-Host "Running" -ForegroundColor Green -NoNewline
        Write-Host " (PID: $frontendProcId, port $FrontendPort)"
    } else {
        Write-Host "Stopped" -ForegroundColor Gray
    }
    
    Write-Host ""
    Write-Host "  URLs:" -ForegroundColor White
    Write-Host "    Frontend: http://localhost:$FrontendPort"
    Write-Host "    Backend:  http://localhost:$BackendPort"
    Write-Host "    Swagger:  http://localhost:$BackendPort/openapi/v1.json"
    Write-Host ""
}

function Show-Logs {
    param([string]$ServiceName)
    
    switch ($ServiceName) {
        "backend" {
            if (Test-Path $BackendLogFile) {
                Write-Title "Backend Logs (Ctrl+C to exit)"
                Get-Content $BackendLogFile -Tail 50 -Wait
            } else {
                Write-Err "No backend log file found. Is backend running?"
            }
        }
        "frontend" {
            if (Test-Path $FrontendLogFile) {
                Write-Title "Frontend Logs (Ctrl+C to exit)"
                Get-Content $FrontendLogFile -Tail 50 -Wait
            } else {
                Write-Err "No frontend log file found. Is frontend running?"
            }
        }
        "db" {
            Write-Title "Database Logs (Ctrl+C to exit)"
            docker logs -f mosaic-postgres-dev 2>&1
        }
        default {
            Write-Err "Specify a service: backend, frontend, or db"
            Write-Info "Example: .\dev.ps1 logs backend"
        }
    }
}

# Check Docker for commands that need it
$DockerCommands = @("start", "stop", "restart", "status", "build", "rebuild", "reset")
if ($Command -in $DockerCommands -and ($Service -eq "" -or $Service -eq "all" -or $Service -eq "db")) {
    if (-not (Test-DockerAvailable)) {
        Write-Err "Docker is not running! Please start Docker Desktop."
        exit 1
    }
}

Push-Location $ProjectRoot

try {
    switch ($Command) {
        "start" {
            $target = if ($Service -eq "") { "all" } else { $Service }
            
            Write-Title "🚀 Starting Mosaic Development Environment"
            
            switch ($target) {
                "all" {
                    Start-DatabaseService
                    Start-BackendService
                    Start-FrontendService
                    Write-Host ""
                    Show-Status
                }
                "db" { Start-DatabaseService }
                "backend" { 
                    # Ensure DB is running first
                    Start-DatabaseService
                    Start-BackendService 
                }
                "frontend" { Start-FrontendService }
            }
        }
        
        "stop" {
            $target = if ($Service -eq "") { "all" } else { $Service }
            
            Write-Title "Stopping services..."
            
            switch ($target) {
                "all" {
                    Stop-FrontendService
                    Stop-BackendService
                    Stop-DatabaseService
                    Write-Done "All services stopped"
                }
                "db" { Stop-DatabaseService }
                "backend" { Stop-BackendService }
                "frontend" { Stop-FrontendService }
            }
        }
        
        "restart" {
            $target = if ($Service -eq "") { "all" } else { $Service }
            
            Write-Title "Restarting services..."
            
            switch ($target) {
                "all" {
                    Stop-FrontendService
                    Stop-BackendService
                    Stop-DatabaseService
                    Start-Sleep -Seconds 1
                    Start-DatabaseService
                    Start-BackendService
                    Start-FrontendService
                    Show-Status
                }
                "db" {
                    Stop-DatabaseService
                    Start-Sleep -Seconds 1
                    Start-DatabaseService
                }
                "backend" {
                    Stop-BackendService
                    Start-Sleep -Seconds 1
                    Start-BackendService
                }
                "frontend" {
                    Stop-FrontendService
                    Start-Sleep -Seconds 1
                    Start-FrontendService
                }
            }
        }
        
        "status" {
            Show-Status
        }
        
        "logs" {
            Show-Logs $Service
        }
        
        "build" {
            Write-Title "Building production containers..."
            docker compose build
            Write-Done "Build complete"
            Write-Info "Run 'docker compose up -d' to start production containers"
        }
        
        "rebuild" {
            Write-Title "Rebuilding production containers (no cache)..."
            docker compose build --no-cache
            Write-Done "Rebuild complete"
        }
        
        "reset" {
            Write-Title "Resetting development environment..."
            
            # Stop all services
            Stop-FrontendService
            Stop-BackendService
            Stop-DatabaseService
            
            # Remove PID files and logs
            Write-Step "Cleaning state files..."
            Remove-Item -Path $PidDir -Recurse -Force -ErrorAction SilentlyContinue
            
            # Remove data directory
            Write-Step "Removing local data..."
            Remove-Item -Path (Join-Path $ProjectRoot "data") -Recurse -Force -ErrorAction SilentlyContinue
            
            # Remove Docker volumes
            Write-Step "Removing Docker volumes..."
            docker compose -f docker-compose.dev.yml down -v 2>&1 | Out-Null
            
            if ($ExtraArgs -contains "--full" -or $ExtraArgs -contains "-f") {
                Write-Step "Removing node_modules..."
                Remove-Item -Path (Join-Path $ProjectRoot "apps/admin/node_modules") -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -Path (Join-Path $ProjectRoot "libs/crypto/node_modules") -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -Path (Join-Path $ProjectRoot "libs/crypto/dist") -Recurse -Force -ErrorAction SilentlyContinue
            }
            
            Write-Done "Reset complete"
        }
        
        "help" {
            Write-Host @"

Mosaic Development Environment Manager
======================================

Usage: .\scripts\dev.ps1 <command> [service] [options]

Commands:
  start [service]     Start services (default: all)
  stop [service]      Stop services (default: all)
  restart [service]   Restart services (default: all)
  status              Show status of all services
  logs <service>      View logs for a service (backend, frontend, db)
  build               Build production Docker containers
  rebuild             Build with --no-cache
  reset               Reset environment (add --full to remove node_modules)
  help                Show this help

Services:
  all        All services (default)
  db         PostgreSQL database only
  backend    .NET backend API only
  frontend   Vite frontend only

Examples:
  .\dev.ps1 start              # Start all services in background
  .\dev.ps1 status             # Check what's running
  .\dev.ps1 logs backend       # View backend logs (live tail)
  .\dev.ps1 restart backend    # Restart just the backend
  .\dev.ps1 stop               # Stop everything

URLs (when running):
  Frontend:  http://localhost:$FrontendPort
  Backend:   http://localhost:$BackendPort
  Swagger:   http://localhost:$BackendPort/openapi/v1.json

"@
        }
    }
} catch {
    Write-Err $_.Exception.Message
    exit 1
} finally {
    Pop-Location
}
