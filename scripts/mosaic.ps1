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
        "backup", "restore", "verify-backup",
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
$MosaicUtilityImage = "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"

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

function Enter-MosaicMaintenanceLock {
    $lockPath = Join-Path $ProjectRoot ".mosaic-maintenance.lock"
    try {
        return [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None)
    }
    catch [System.IO.IOException] {
        throw "Another Mosaic backup or restore is already in progress. Wait for it to finish and retry."
    }
}

function Wait-MosaicBackendHealthy {
    param(
        [int]$TimeoutSeconds = 120,
        [int]$PollIntervalSeconds = 2
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $backendContainerId = docker compose ps --status running -q backend
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($backendContainerId)) {
            $healthStatus = docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' $backendContainerId
            if ($LASTEXITCODE -eq 0 -and $healthStatus -eq "healthy") {
                return
            }
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Backend did not become healthy within $TimeoutSeconds seconds."
}

$ActiveShardInventoryQuery = "SELECT storage_key, lower(sha256), size_bytes FROM shards WHERE status = 'ACTIVE' ORDER BY storage_key;"

function Get-MosaicVerifiedBackup {
    param([Parameter(Mandatory=$true)][string]$BackupDirectory)

    $resolvedDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
    $databasePath = Join-Path $resolvedDirectory "database.dump"
    $blobPath = Join-Path $resolvedDirectory "blobs.tar.gz"
    $manifestPath = Join-Path $resolvedDirectory "manifest.sha256"
    if (-not (Test-Path -LiteralPath $databasePath) -or
        -not (Test-Path -LiteralPath $blobPath) -or
        -not (Test-Path -LiteralPath $manifestPath)) {
        throw "Backup must contain database.dump, blobs.tar.gz, and manifest.sha256."
    }

    $databaseHash = (Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $blobHash = (Get-FileHash -LiteralPath $blobPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestText = [System.IO.File]::ReadAllText($manifestPath).Replace("`r", "").TrimEnd([char[]]"`n")
    $expectedManifest = "$databaseHash  database.dump`n$blobHash  blobs.tar.gz"
    if ($manifestText -cne $expectedManifest) {
        throw "Backup manifest does not exactly match its database/blob pair; refusing restore."
    }

    return [pscustomobject]@{
        Directory = $resolvedDirectory
        Database = $databasePath
        Blobs = $blobPath
    }
}

function Test-MosaicBlobArchive {
    param([Parameter(Mandatory=$true)][string]$BackupDirectory)

    $validator = @'
tar tzf /backup/blobs.tar.gz > /tmp/mosaic-archive-members
while IFS= read -r member; do
  case "$member" in
    "."|"./") ;;
    ./*)
      case "$member" in
        *"/../"*|*"/.."|*"\\"*) echo "unsafe blob archive member: $member" >&2; exit 1 ;;
      esac
      ;;
    *) echo "unsafe blob archive member: $member" >&2; exit 1 ;;
  esac
done < /tmp/mosaic-archive-members
tar tvzf /backup/blobs.tar.gz > /tmp/mosaic-archive-details
while IFS= read -r detail; do
  case "$detail" in
    -*|d*) ;;
    *) echo "unsafe non-file archive member: $detail" >&2; exit 1 ;;
  esac
done < /tmp/mosaic-archive-details
'@
    $null = docker run --rm --network none -v "${BackupDirectory}:/backup:ro" $MosaicUtilityImage sh -eu -c $validator
    if ($LASTEXITCODE -ne 0) { throw "Blob archive is unreadable or contains unsafe members; refusing restore." }
}

function Invoke-MosaicInventoryVerification {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$Inventory,
        [Parameter(Mandatory=$true)][string]$BlobVolume
    )

    $verifier = @'
checked=0
while IFS="|" read -r storage_key expected_sha256 expected_size; do
  [ -n "$storage_key" ] || continue
  expected_size="$(printf %s "$expected_size" | tr -d "\r")"
  case "$storage_key" in
    /*|*".."*|*"\\"*|*"|"*) echo "unsafe storage key: $storage_key" >&2; exit 1 ;;
  esac
  case "$expected_sha256" in
    ""|*[!0-9a-f]*) echo "invalid active shard hash inventory: $storage_key" >&2; exit 1 ;;
  esac
  case "$expected_size" in
    ""|*[!0-9]*) echo "invalid active shard size inventory: $storage_key" >&2; exit 1 ;;
  esac
  blob_path="/data/$storage_key"
  [ -f "$blob_path" ] || { echo "missing active shard blob: $storage_key" >&2; exit 1; }
  actual_size="$(wc -c < "$blob_path" | tr -d " ")"
  [ "$actual_size" = "$expected_size" ] || { echo "active shard size mismatch: $storage_key" >&2; exit 1; }
  actual_sha256="$(sha256sum "$blob_path" | awk "{print \$1}")"
  [ "$actual_sha256" = "$expected_sha256" ] || { echo "active shard hash mismatch: $storage_key" >&2; exit 1; }
  checked=$((checked + 1))
done
echo "Verified $checked active shard blob(s) against database inventory"
'@
    ($Inventory -join "`n") | docker run --rm --network none -i -v "${BlobVolume}:/data:ro" $MosaicUtilityImage sh -eu -c $verifier
    if ($LASTEXITCODE -ne 0) { throw "Active shard/blob inventory reconciliation failed." }
}

function Invoke-MosaicLiveInventoryVerification {
    Write-Step "Reconciling active production shard rows against the blob volume..."
    $inventory = @(docker compose exec -T postgres psql -At -F '|' -U mosaic -d mosaic -c $ActiveShardInventoryQuery)
    if ($LASTEXITCODE -ne 0) { throw "Could not read active shard inventory from PostgreSQL." }
    Invoke-MosaicInventoryVerification -Inventory $inventory -BlobVolume "mosaic_blob_data"
}

function Invoke-MosaicIsolatedBackupVerification {
    param([Parameter(Mandatory=$true)][string]$BackupDirectory)

    Test-MosaicBlobArchive -BackupDirectory $BackupDirectory
    $verifyId = [Guid]::NewGuid().ToString("N")
    $postgresContainer = "mosaic-backup-verify-$verifyId"
    $blobVolume = "mosaic_backup_verify_$verifyId"
    $postgresReady = $false
    try {
        Write-Step "Creating isolated verification resources..."
        $null = docker volume create $blobVolume
        if ($LASTEXITCODE -ne 0) { throw "Could not create isolated verification volume." }
        $null = docker run -d --rm --network none --name $postgresContainer `
            -e POSTGRES_DB=mosaic_verify `
            -e POSTGRES_USER=mosaic `
            -e POSTGRES_PASSWORD=mosaic_backup_verifier `
            -v "${BackupDirectory}:/backup:ro" $MosaicUtilityImage
        if ($LASTEXITCODE -ne 0) { throw "Could not start isolated PostgreSQL verifier." }

        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $null = docker exec $postgresContainer pg_isready -q -U mosaic -d mosaic_verify
            if ($LASTEXITCODE -eq 0) {
                $postgresReady = $true
                break
            }
            Start-Sleep -Seconds 1
        }
        if (-not $postgresReady) { throw "Isolated PostgreSQL verifier did not become ready." }

        Write-Step "Restoring the database and blob pair in isolation..."
        docker exec $postgresContainer pg_restore --clean --if-exists --no-owner --no-privileges -U mosaic -d mosaic_verify /backup/database.dump
        if ($LASTEXITCODE -ne 0) { throw "Isolated PostgreSQL restore failed." }
        docker run --rm --network none -v "${blobVolume}:/data" -v "${BackupDirectory}:/backup:ro" $MosaicUtilityImage tar xzf /backup/blobs.tar.gz -C /data
        if ($LASTEXITCODE -ne 0) { throw "Isolated blob restore failed." }

        $inventory = @(docker exec $postgresContainer psql -At -F '|' -U mosaic -d mosaic_verify -c $ActiveShardInventoryQuery)
        if ($LASTEXITCODE -ne 0) { throw "Could not read isolated active shard inventory." }
        Invoke-MosaicInventoryVerification -Inventory $inventory -BlobVolume $blobVolume
        Write-Done "Isolated backup restore and active-shard reconciliation passed"
    }
    finally {
        try { $null = docker rm -f $postgresContainer 2>&1 } catch {}
        try { $null = docker volume rm $blobVolume 2>&1 } catch {}
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
            Write-Step "Creating and rehearsing a matched pre-upgrade backup..."
            & $PSCommandPath backup
            if ($LASTEXITCODE -ne 0) { throw "Pre-upgrade backup failed; update refused." }

            Write-Step "Pulling candidate images..."
            docker compose pull
            if ($LASTEXITCODE -ne 0) { throw "Candidate image pull failed; current deployment was not changed." }

            $maintenanceLock = Enter-MosaicMaintenanceLock
            $deploymentQuiesced = $false
            $updateComplete = $false
            try {
                Write-Step "Stopping the serving backend before schema migration..."
                $deploymentQuiesced = $true
                docker compose stop backend
                if ($LASTEXITCODE -ne 0) { throw "Could not quiesce the backend; update refused." }

                Write-Step "Applying schema through the one-shot migration command..."
                docker compose run --rm --no-deps backend --migrate-only
                if ($LASTEXITCODE -ne 0) {
                    throw "Migration failed; backend remains stopped. Restore the matched pre-upgrade backup before rollback."
                }

                Write-Step "Recreating and health-checking candidate containers..."
                docker compose up -d --remove-orphans --wait
                if ($LASTEXITCODE -ne 0) {
                    throw "Candidate containers did not become healthy; serving containers will be stopped."
                }
                $updateComplete = $true
            }
            finally {
                try {
                    if ($deploymentQuiesced -and -not $updateComplete) {
                        Write-Err "Update failed after quiesce; stopping frontend/backend to prevent partial service."
                        docker compose stop frontend backend
                    }
                }
                finally {
                    $maintenanceLock.Dispose()
                }
            }

            Write-Done "Verified update complete"
        }
        
        "backup" {
            Write-Title "Creating Mosaic Backup"
            $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmss.fffZ", [System.Globalization.CultureInfo]::InvariantCulture)
            $backupRoot = "backups"
            $backupDir = Join-Path $backupRoot $timestamp
            $databasePath = Join-Path $backupDir "database.dump"
            $blobPath = Join-Path $backupDir "blobs.tar.gz"
            $manifestPath = Join-Path $backupDir "manifest.sha256"

            $maintenanceLock = Enter-MosaicMaintenanceLock
            $backendStopped = $false
            try {
                $backendWasRunning = -not [string]::IsNullOrWhiteSpace((docker compose ps --status running -q backend))
                if ($LASTEXITCODE -ne 0) { throw "Could not determine backend state before backup." }
                New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
                if (Test-Path -LiteralPath $backupDir) { throw "Backup directory already exists: $backupDir" }
                New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null

                if ($backendWasRunning) {
                    Write-Step "Stopping backend for a matched database/blob snapshot..."
                    docker compose stop backend
                    if ($LASTEXITCODE -ne 0) { throw "Could not stop backend for backup." }
                    $backendStopped = $true
                }

                $dumpPath = "/tmp/mosaic-backup-$timestamp.dump"
                Write-Step "Backing up PostgreSQL database..."
                docker compose exec -T postgres sh -ec "pg_dump --format=custom --no-owner --no-privileges -U mosaic mosaic > $dumpPath"
                if ($LASTEXITCODE -ne 0) { throw "PostgreSQL dump failed." }
                docker compose exec -T postgres pg_restore --list $dumpPath > $null
                if ($LASTEXITCODE -ne 0) { throw "PostgreSQL dump verification failed." }
                docker compose cp "postgres:$dumpPath" $databasePath
                if ($LASTEXITCODE -ne 0) { throw "Could not copy PostgreSQL dump from container." }
                docker compose exec -T postgres rm -f $dumpPath

                Write-Step "Backing up blob storage..."
                $backupDirAbsolute = (Resolve-Path $backupDir).Path
                docker run --rm -v mosaic_blob_data:/data -v "${backupDirAbsolute}:/backup" $MosaicUtilityImage tar czf /backup/blobs.tar.gz -C /data .
                if ($LASTEXITCODE -ne 0) { throw "Blob archive creation failed." }

                $databaseHash = (Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash.ToLowerInvariant()
                $blobHash = (Get-FileHash -LiteralPath $blobPath -Algorithm SHA256).Hash.ToLowerInvariant()
                $manifestText = "$databaseHash  database.dump`n$blobHash  blobs.tar.gz`n"
                [System.IO.File]::WriteAllText(
                    $manifestPath,
                    $manifestText,
                    [System.Text.UTF8Encoding]::new($false))
            }
            finally {
                try {
                    if ($backendStopped) {
                        Write-Step "Resuming backend..."
                        docker compose start backend
                        if ($LASTEXITCODE -ne 0) { throw "Could not restart backend after backup." }
                        Wait-MosaicBackendHealthy
                    }
                }
                finally {
                    $maintenanceLock.Dispose()
                }
            }

            $verifiedBackup = Get-MosaicVerifiedBackup -BackupDirectory $backupDir
            Write-Step "Rehearsing the matched backup in isolated Docker resources..."
            Invoke-MosaicIsolatedBackupVerification -BackupDirectory $verifiedBackup.Directory
            Write-Done "Matched backup pair saved to $backupDir"
        }
        
        "restore" {
            if ($Args.Count -ne 1) {
                Write-Err "Please specify backup directory"
                Write-Host "Usage: .\mosaic.ps1 restore backups\20240101T120000Z"
                exit 1
            }

            $verifiedBackup = Get-MosaicVerifiedBackup -BackupDirectory $Args[0]
            $backupDir = $verifiedBackup.Directory
            $databasePath = $verifiedBackup.Database

            Write-Step "Rehearsing backup restore and active-shard reconciliation in isolation..."
            Invoke-MosaicIsolatedBackupVerification -BackupDirectory $backupDir

            Write-Title "Restoring Mosaic from $backupDir"
            Write-Host ""
            Write-Host "⚠️  WARNING: This will overwrite current data!" -ForegroundColor Red
            $confirm = Read-Host "Type yes to continue"
            if ($confirm -ne "yes") {
                Write-Host "Restore cancelled"
                exit 0
            }

            $maintenanceLock = Enter-MosaicMaintenanceLock
            $backendStopped = $false
            $restoreComplete = $false
            try {
                $verifiedBackup = Get-MosaicVerifiedBackup -BackupDirectory $backupDir
                $databasePath = $verifiedBackup.Database

                $backendWasRunning = -not [string]::IsNullOrWhiteSpace((docker compose ps --status running -q backend))
                if ($LASTEXITCODE -ne 0) { throw "Could not determine backend state before restore." }
                if ($backendWasRunning) {
                    Write-Step "Stopping backend before replacing the matched snapshot pair..."
                    docker compose stop backend
                    if ($LASTEXITCODE -ne 0) { throw "Could not stop backend for restore." }
                    $backendStopped = $true
                }

                $restorePath = "/tmp/mosaic-restore-$([Guid]::NewGuid().ToString("N")).dump"
                docker compose cp $databasePath "postgres:$restorePath"
                if ($LASTEXITCODE -ne 0) { throw "Could not copy PostgreSQL archive into container." }
                docker compose exec -T postgres pg_restore --list $restorePath > $null
                if ($LASTEXITCODE -ne 0) { throw "PostgreSQL archive is not restorable." }

                Write-Step "Replacing PostgreSQL database..."
                docker compose exec -T postgres dropdb --if-exists --force -U mosaic mosaic
                if ($LASTEXITCODE -ne 0) { throw "Could not drop the current PostgreSQL database." }
                docker compose exec -T postgres createdb -U mosaic -O mosaic mosaic
                if ($LASTEXITCODE -ne 0) { throw "Could not create a clean PostgreSQL database." }
                docker compose exec -T postgres pg_restore --clean --if-exists --no-owner --no-privileges -U mosaic -d mosaic $restorePath
                if ($LASTEXITCODE -ne 0) { throw "PostgreSQL restore failed." }
                docker compose exec -T postgres rm -f $restorePath

                Write-Step "Replacing blob storage from the verified archive..."
                docker run --rm -v mosaic_blob_data:/data $MosaicUtilityImage sh -ec "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +"
                if ($LASTEXITCODE -ne 0) { throw "Could not clear blob storage before restore." }
                docker run --rm -v mosaic_blob_data:/data -v "${backupDir}:/backup:ro" $MosaicUtilityImage tar xzf /backup/blobs.tar.gz -C /data
                if ($LASTEXITCODE -ne 0) { throw "Blob restore failed." }

                Invoke-MosaicLiveInventoryVerification
                $restoreComplete = $true
            }
            finally {
                try {
                    if ($backendStopped) {
                        if ($restoreComplete) {
                            Write-Step "Starting backend after verified restore..."
                            docker compose start backend
                            if ($LASTEXITCODE -ne 0) { throw "Could not restart backend after restore." }
                            Wait-MosaicBackendHealthy
                        }
                        else {
                            Write-Err "Restore failed; backend remains stopped to avoid serving a partial restore."
                        }
                    }
                }
                finally {
                    $maintenanceLock.Dispose()
                }
            }
            if ($restoreComplete) { Write-Done "Verified restore complete" }
        }

        "verify-backup" {
            if ($Args.Count -ne 1) {
                Write-Err "Please specify exactly one backup directory"
                Write-Host "Usage: .\mosaic.ps1 verify-backup backups\20240101T120000Z"
                exit 1
            }

            $verifiedBackup = Get-MosaicVerifiedBackup -BackupDirectory $Args[0]
            Invoke-MosaicIsolatedBackupVerification -BackupDirectory $verifiedBackup.Directory
            Write-Done "Backup passed isolated restore verification"
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
            Write-Host "  update             Create backup, pull, migrate, and recreate"
            Write-Host ""
            Write-Host "  backup             Create backup of database and blobs"
            Write-Host "  restore <dir>      Restore from backup directory"
            Write-Host "  verify-backup <dir> Restore in isolation and verify active shard hashes"
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
