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
        "build", "rebuild", "reset", "test", "help"
    )]
    [string]$Command = "help",
    
    [Parameter(Position=1)]
    [ValidateSet("all", "db", "backend", "frontend", "unit", "e2e", "")]
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
    param(
        [string]$ServiceName,
        [int]$TailLines = 50,
        [bool]$Follow = $false
    )
    
    switch ($ServiceName) {
        "backend" {
            if (Test-Path $BackendLogFile) {
                if ($Follow) {
                    Write-Title "Backend Logs (Ctrl+C to exit)"
                    Get-Content $BackendLogFile -Tail $TailLines -Wait
                } else {
                    Write-Title "Backend Logs (last $TailLines lines)"
                    Get-Content $BackendLogFile -Tail $TailLines
                }
            } else {
                Write-Err "No backend log file found. Is backend running?"
            }
        }
        "frontend" {
            if (Test-Path $FrontendLogFile) {
                if ($Follow) {
                    Write-Title "Frontend Logs (Ctrl+C to exit)"
                    Get-Content $FrontendLogFile -Tail $TailLines -Wait
                } else {
                    Write-Title "Frontend Logs (last $TailLines lines)"
                    Get-Content $FrontendLogFile -Tail $TailLines
                }
            } else {
                Write-Err "No frontend log file found. Is frontend running?"
            }
        }
        "db" {
            if ($Follow) {
                Write-Title "Database Logs (Ctrl+C to exit)"
                docker logs -f mosaic-postgres-dev 2>&1
            } else {
                Write-Title "Database Logs (last $TailLines lines)"
                docker logs --tail $TailLines mosaic-postgres-dev 2>&1
            }
        }
        default {
            Write-Err "Specify a service: backend, frontend, or db"
            Write-Info "Example: .\dev.ps1 logs backend"
            Write-Info "         .\dev.ps1 logs backend --follow  # Live tail"
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
            $follow = $ExtraArgs -contains "--follow" -or $ExtraArgs -contains "-f"
            $tailLines = 50
            foreach ($arg in $ExtraArgs) {
                if ($arg -match "^--tail=(\d+)$") {
                    $tailLines = [int]$Matches[1]
                }
            }
            Show-Logs -ServiceName $Service -TailLines $tailLines -Follow $follow
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
        
        "test" {
            $target = if ($Service -eq "") { "all" } else { $Service }
            
            switch ($target) {
                "all" {
                    Write-Title "Running all tests..."
                    
                    # Unit tests
                    Write-Step "Running crypto library tests..."
                    Push-Location (Join-Path $ProjectRoot "libs/crypto")
                    npm test 2>&1
                    $cryptoExit = $LASTEXITCODE
                    Pop-Location
                    
                    Write-Step "Running frontend tests..."
                    Push-Location (Join-Path $ProjectRoot "apps/admin")
                    npm run test:run 2>&1
                    $frontendExit = $LASTEXITCODE
                    Pop-Location
                    
                    Write-Step "Running backend tests..."
                    Push-Location (Join-Path $ProjectRoot "apps/backend/Mosaic.Backend.Tests")
                    dotnet test 2>&1
                    $backendExit = $LASTEXITCODE
                    Pop-Location
                    
                    if ($cryptoExit -eq 0 -and $frontendExit -eq 0 -and $backendExit -eq 0) {
                        Write-Done "All unit tests passed!"
                    } else {
                        Write-Err "Some tests failed"
                        exit 1
                    }
                }
                "unit" {
                    Write-Title "Running unit tests..."
                    
                    Write-Step "Running crypto library tests..."
                    Push-Location (Join-Path $ProjectRoot "libs/crypto")
                    npm test 2>&1
                    Pop-Location
                    
                    Write-Step "Running frontend tests..."
                    Push-Location (Join-Path $ProjectRoot "apps/admin")
                    npm run test:run 2>&1
                    Pop-Location
                    
                    Write-Step "Running backend tests..."
                    Push-Location (Join-Path $ProjectRoot "apps/backend/Mosaic.Backend.Tests")
                    dotnet test 2>&1
                    Pop-Location
                }
                "e2e" {
                    Write-Title "Running E2E tests..."
                    
                    # Check if services are running
                    $backendRunning = Test-ProcessRunning $BackendPidFile
                    $frontendRunning = Test-ProcessRunning $FrontendPidFile
                    
                    if (-not $backendRunning -or -not $frontendRunning) {
                        Write-Err "Dev services not running. Start them first with: .\dev.ps1 start"
                        Write-Info "Or run the full E2E test suite with: .\scripts\run-e2e-tests.ps1"
                        exit 1
                    }
                    
                    Write-Info "Running against: Frontend=http://localhost:$FrontendPort Backend=http://localhost:$BackendPort"
                    
                    # Ensure E2E dependencies
                    $e2ePath = Join-Path $ProjectRoot "tests/e2e"
                    $e2eNodeModules = Join-Path $e2ePath "node_modules"
                    if (-not (Test-Path $e2eNodeModules)) {
                        Write-Step "Installing E2E dependencies..."
                        Push-Location $e2ePath
                        npm install 2>&1 | Out-Null
                        npx playwright install chromium --with-deps 2>&1 | Out-Null
                        Pop-Location
                    }
                    
                    Push-Location $e2ePath
                    
                    # Build playwright command
                    $playwrightArgs = @("test")
                    
                    # Parse extra args for options
                    $project = "chromium"
                    $testFile = ""
                    $headed = $false
                    $grep = ""
                    
                    for ($i = 0; $i -lt $ExtraArgs.Count; $i++) {
                        $arg = $ExtraArgs[$i]
                        switch -Regex ($arg) {
                            "^--project=(.+)$" { $project = $Matches[1] }
                            "^--headed$" { $headed = $true }
                            "^--grep=(.+)$" { $grep = $Matches[1] }
                            "^-g$" { 
                                if ($i + 1 -lt $ExtraArgs.Count) { 
                                    $grep = $ExtraArgs[$i + 1]
                                    $i++ 
                                } 
                            }
                            "^--debug$" { $playwrightArgs += "--debug" }
                            "\.spec\.ts$" { $testFile = $arg }
                            default { 
                                if (-not $arg.StartsWith("-")) { $testFile = $arg }
                            }
                        }
                    }
                    
                    if ($testFile) { $playwrightArgs += $testFile }
                    if ($project -ne "all") { $playwrightArgs += "--project=$project" }
                    if ($headed) { $playwrightArgs += "--headed" }
                    if ($grep) { $playwrightArgs += "--grep=$grep" }
                    
                    Write-Info "Command: npx playwright $($playwrightArgs -join ' ')"
                    Write-Host ""
                    
                    # Set environment variables
                    $env:BASE_URL = "http://localhost:$FrontendPort"
                    $env:API_URL = "http://localhost:$BackendPort"
                    
                    # Run playwright
                    npx playwright @playwrightArgs
                    $testExit = $LASTEXITCODE
                    
                    Pop-Location
                    
                    if ($testExit -eq 0) {
                        Write-Done "E2E tests passed!"
                    } else {
                        Write-Err "E2E tests failed (exit code: $testExit)"
                        exit $testExit
                    }
                }
                default {
                    Write-Err "Unknown test type: $target"
                    Write-Info "Options: all, unit, e2e"
                }
            }
        }
        
        "help" {
            Write-Host @"

Mosaic Development Environment Manager
======================================

Usage: .\scripts\dev.ps1 <command> [target] [options]

Commands:
  start [service]     Start services (default: all)
  stop [service]      Stop services (default: all)
  restart [service]   Restart services (default: all)
  status              Show status of all services
  logs <service>      View recent logs for a service (non-blocking)
  test [type]         Run tests (unit, e2e, or all)
  build               Build production Docker containers
  rebuild             Build with --no-cache
  reset               Reset environment (add --full to remove node_modules)
  help                Show this help

Services:
  all        All services (default)
  db         PostgreSQL database only
  backend    .NET backend API only
  frontend   Vite frontend only

Test Types:
  all        Run all unit tests (crypto, frontend, backend)
  unit       Same as 'all' - run all unit tests
  e2e        Run E2E tests against running dev environment

Examples:
  .\dev.ps1 start              # Start all services in background
  .\dev.ps1 status             # Check what's running
  .\dev.ps1 logs backend       # View last 50 lines of backend logs
  .\dev.ps1 logs backend -f    # Live tail (interactive, Ctrl+C to exit)
  .\dev.ps1 logs backend --tail=100  # View last 100 lines
  .\dev.ps1 restart backend    # Restart just the backend
  .\dev.ps1 stop               # Stop everything
  
  # Testing
  .\dev.ps1 test               # Run all unit tests
  .\dev.ps1 test unit          # Run all unit tests
  .\dev.ps1 test e2e           # Run E2E tests (services must be running)
  .\dev.ps1 test e2e auth.spec.ts             # Run specific test file
  .\dev.ps1 test e2e --grep "P0-IDENTITY"     # Run tests matching pattern
  .\dev.ps1 test e2e --headed                 # Run with visible browser
  .\dev.ps1 test e2e --project=firefox        # Run on Firefox

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
