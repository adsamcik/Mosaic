#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Mosaic Docker Helper Script
    Common operations for managing Mosaic Docker deployment

.DESCRIPTION
    This script provides convenient commands for managing Mosaic containers,
    viewing logs, backing up data, and other operational tasks.

.PARAMETER Command
    The operation to perform

.PARAMETER Args
    Additional arguments for the command

.EXAMPLE
    .\mosaic.ps1 start
    Start all Mosaic services

.EXAMPLE
    .\mosaic.ps1 logs backend
    Follow logs for the backend service

.EXAMPLE
    .\mosaic.ps1 backup
    Create a backup of the database and blob storage
#>

param(
    [Parameter(Position=0)]
    [ValidateSet(
        "start", "stop", "restart", "status", "logs",
        "build", "pull", "update",
        "backup", "restore",
        "shell", "db",
        "clean", "reset",
        "help"
    )]
    [string]$Command = "help",
    
    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Colors
function Write-Title { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Step { param([string]$msg) Write-Host "  ▶ $msg" -ForegroundColor Yellow }
function Write-Done { param([string]$msg) Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Err { param([string]$msg) Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Warn { param([string]$msg) Write-Host "  ⚠️ $msg" -ForegroundColor Yellow }

# Check if Docker is available and running
function Test-DockerAvailable {
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

# Ensure Docker is running before proceeding
if ($Command -ne "help") {
    if (-not (Test-DockerAvailable)) {
        Write-Host ""
        Write-Err "Docker is not running!"
        Write-Host ""
        Write-Host "Please start Docker Desktop:" -ForegroundColor White
        Write-Host "  1. Open Docker Desktop from Start Menu" -ForegroundColor Gray
        Write-Host "  2. Wait for it to fully start (whale icon stops animating)" -ForegroundColor Gray
        Write-Host "  3. Run this command again" -ForegroundColor Gray
        Write-Host ""
        Write-Host "If Docker Desktop is not installed:" -ForegroundColor White
        Write-Host "  Download from: https://www.docker.com/products/docker-desktop/" -ForegroundColor Gray
        Write-Host ""
        exit 1
    }
}

Push-Location $ProjectRoot

try {
    switch ($Command) {
        "start" {
            Write-Title "Starting Mosaic..."
            docker compose up -d
            Write-Done "Mosaic is running at http://localhost:$($env:FRONTEND_PORT ?? '8080')"
        }
        
        "stop" {
            Write-Title "Stopping Mosaic..."
            docker compose down
            Write-Done "Mosaic stopped"
        }
        
        "restart" {
            Write-Title "Restarting Mosaic..."
            docker compose restart $Args
            Write-Done "Mosaic restarted"
        }
        
        "status" {
            Write-Title "Mosaic Status"
            docker compose ps
            Write-Host ""
            Write-Host "Health Checks:" -ForegroundColor White
            $containers = @("mosaic-frontend", "mosaic-backend", "mosaic-postgres")
            foreach ($container in $containers) {
                try {
                    $health = docker inspect --format='{{.State.Health.Status}}' $container 2>$null
                    if ($health) {
                        $color = switch ($health) {
                            "healthy" { "Green" }
                            "unhealthy" { "Red" }
                            default { "Yellow" }
                        }
                        Write-Host "  $container`: " -NoNewline
                        Write-Host $health -ForegroundColor $color
                    }
                } catch {}
            }
        }
        
        "logs" {
            $service = if ($Args.Count -gt 0) { $Args[0] } else { "" }
            if ($service) {
                docker compose logs -f $service
            } else {
                docker compose logs -f
            }
        }
        
        "build" {
            Write-Title "Building Mosaic..."
            & "$PSScriptRoot\docker-build.ps1" @Args
        }
        
        "pull" {
            Write-Title "Pulling latest images..."
            docker compose pull
            Write-Done "Images updated"
        }
        
        "update" {
            Write-Title "Updating Mosaic..."
            Write-Step "Pulling latest images"
            docker compose pull
            Write-Step "Recreating containers"
            docker compose up -d --remove-orphans
            Write-Done "Update complete"
        }
        
        "backup" {
            Write-Title "Creating Mosaic Backup"
            $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $backupDir = "backups\$timestamp"
            
            if (-not (Test-Path "backups")) {
                New-Item -ItemType Directory -Path "backups" | Out-Null
            }
            New-Item -ItemType Directory -Path $backupDir | Out-Null
            
            Write-Step "Backing up PostgreSQL database..."
            docker compose exec -T postgres pg_dump -U mosaic mosaic > "$backupDir\database.sql"
            
            Write-Step "Backing up blob storage..."
            docker run --rm -v mosaic_blob_data:/data -v "${PWD}\${backupDir}:/backup" alpine `
                tar czf /backup/blobs.tar.gz -C /data .
            
            Write-Done "Backup saved to $backupDir"
            Write-Host ""
            Write-Host "Files:" -ForegroundColor White
            Get-ChildItem $backupDir | ForEach-Object {
                $size = if ($_.Length -gt 1MB) { 
                    "{0:N1} MB" -f ($_.Length / 1MB) 
                } else { 
                    "{0:N1} KB" -f ($_.Length / 1KB) 
                }
                Write-Host "  $($_.Name): $size" -ForegroundColor Gray
            }
        }
        
        "restore" {
            if ($Args.Count -eq 0) {
                Write-Err "Please specify backup directory"
                Write-Host "Usage: .\mosaic.ps1 restore backups\20240101-120000"
                exit 1
            }
            
            $backupDir = $Args[0]
            if (-not (Test-Path $backupDir)) {
                Write-Err "Backup directory not found: $backupDir"
                exit 1
            }
            
            Write-Title "Restoring Mosaic from $backupDir"
            Write-Host ""
            Write-Host "⚠️  WARNING: This will overwrite current data!" -ForegroundColor Red
            $confirm = Read-Host "Type 'yes' to continue"
            if ($confirm -ne "yes") {
                Write-Host "Restore cancelled"
                exit 0
            }
            
            Write-Step "Restoring PostgreSQL database..."
            Get-Content "$backupDir\database.sql" | docker compose exec -T postgres psql -U mosaic mosaic
            
            if (Test-Path "$backupDir\blobs.tar.gz") {
                Write-Step "Restoring blob storage..."
                docker run --rm -v mosaic_blob_data:/data -v "${PWD}\${backupDir}:/backup" alpine `
                    tar xzf /backup/blobs.tar.gz -C /data
            }
            
            Write-Done "Restore complete"
        }
        
        "shell" {
            $service = if ($Args.Count -gt 0) { $Args[0] } else { "backend" }
            Write-Title "Opening shell in $service..."
            
            switch ($service) {
                "backend" { docker compose exec backend sh }
                "frontend" { docker compose exec frontend sh }
                "postgres" { docker compose exec postgres sh }
                default { docker compose exec $service sh }
            }
        }
        
        "db" {
            Write-Title "Connecting to PostgreSQL..."
            docker compose exec postgres psql -U mosaic mosaic
        }
        
        "clean" {
            Write-Title "Cleaning up Docker resources..."
            Write-Step "Removing stopped containers"
            docker compose down --remove-orphans
            Write-Step "Removing unused images"
            docker image prune -f
            Write-Done "Cleanup complete"
        }
        
        "reset" {
            Write-Host ""
            Write-Host "⚠️  WARNING: This will DELETE ALL DATA including:" -ForegroundColor Red
            Write-Host "    - All photos and albums" -ForegroundColor Red
            Write-Host "    - All user accounts" -ForegroundColor Red
            Write-Host "    - Database contents" -ForegroundColor Red
            Write-Host ""
            $confirm = Read-Host "Type 'DELETE ALL DATA' to continue"
            if ($confirm -ne "DELETE ALL DATA") {
                Write-Host "Reset cancelled"
                exit 0
            }
            
            Write-Title "Resetting Mosaic..."
            Write-Step "Stopping containers"
            docker compose down -v
            Write-Step "Removing volumes"
            docker volume rm mosaic_postgres_data mosaic_blob_data 2>$null
            Write-Done "Reset complete. Run '.\mosaic.ps1 start' to start fresh."
        }
        
        "help" {
            Write-Host ""
            Write-Host "Mosaic Docker Helper" -ForegroundColor Cyan
            Write-Host "===================" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "Usage: .\mosaic.ps1 <command> [args]" -ForegroundColor White
            Write-Host ""
            Write-Host "Commands:" -ForegroundColor Yellow
            Write-Host "  start              Start all Mosaic services"
            Write-Host "  stop               Stop all services"
            Write-Host "  restart [service]  Restart all or specific service"
            Write-Host "  status             Show container status and health"
            Write-Host "  logs [service]     Follow logs (all or specific service)"
            Write-Host ""
            Write-Host "  build [options]    Build Docker images (passes to docker-build.ps1)"
            Write-Host "  pull               Pull latest images from registry"
            Write-Host "  update             Pull and recreate containers"
            Write-Host ""
            Write-Host "  backup             Create backup of database and blobs"
            Write-Host "  restore <dir>      Restore from backup directory"
            Write-Host ""
            Write-Host "  shell [service]    Open shell in container (default: backend)"
            Write-Host "  db                 Connect to PostgreSQL CLI"
            Write-Host ""
            Write-Host "  clean              Remove stopped containers and unused images"
            Write-Host "  reset              ⚠️  DELETE all data and start fresh"
            Write-Host ""
            Write-Host "Examples:" -ForegroundColor Yellow
            Write-Host "  .\mosaic.ps1 start"
            Write-Host "  .\mosaic.ps1 logs backend"
            Write-Host "  .\mosaic.ps1 backup"
            Write-Host "  .\mosaic.ps1 shell postgres"
            Write-Host ""
        }
    }
}
finally {
    Pop-Location
}
