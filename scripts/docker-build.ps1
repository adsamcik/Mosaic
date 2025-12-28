#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Mosaic Docker Build Script
    Builds, tags, and optionally pushes Docker images for Mosaic

.DESCRIPTION
    This script builds all Mosaic Docker images (backend and frontend),
    optionally tags them for a registry, and can push them.

.PARAMETER Service
    Build only a specific service: 'backend', 'frontend', or 'all' (default)

.PARAMETER Tag
    Docker image tag (default: 'latest')

.PARAMETER Registry
    Container registry to tag/push images to (e.g., 'ghcr.io/yourorg')

.PARAMETER NoPush
    Tag images for registry but don't push

.PARAMETER NoCache
    Build without using Docker layer cache

.PARAMETER Platform
    Target platform(s) for multi-arch builds (e.g., 'linux/amd64,linux/arm64')

.PARAMETER Dev
    Build using development compose file

.PARAMETER Test
    Build using test compose file

.EXAMPLE
    .\docker-build.ps1
    Build all services with default settings

.EXAMPLE
    .\docker-build.ps1 -Service backend -Tag v1.0.0
    Build only backend with specific tag

.EXAMPLE
    .\docker-build.ps1 -Registry ghcr.io/myorg -Tag v1.0.0
    Build, tag, and push to GitHub Container Registry

.EXAMPLE
    .\docker-build.ps1 -Platform "linux/amd64,linux/arm64" -Registry ghcr.io/myorg
    Build multi-architecture images and push
#>

param(
    [ValidateSet("all", "backend", "frontend")]
    [string]$Service = "all",
    
    [string]$Tag = "latest",
    
    [string]$Registry = "",
    
    [switch]$NoPush,
    
    [switch]$NoCache,
    
    [string]$Platform = "",
    
    [switch]$Dev,
    
    [switch]$Test
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Image names mapping
$ImageNames = @{
    "backend"  = "mosaic-backend"
    "frontend" = "mosaic-frontend"
}

function Write-Step {
    param([string]$Message, [string]$Color = "Yellow")
    Write-Host ""
    Write-Host "▶ $Message" -ForegroundColor $Color
}

function Write-Success {
    param([string]$Message)
    Write-Host "  ✅ $Message" -ForegroundColor Green
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Gray
}

function Test-DockerRunning {
    try {
        docker info 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Get-GitInfo {
    $info = @{
        Branch = ""
        Commit = ""
        Clean = $true
    }
    
    try {
        $info.Branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        $info.Commit = (git rev-parse --short HEAD 2>$null).Trim()
        $status = git status --porcelain 2>$null
        $info.Clean = [string]::IsNullOrEmpty($status)
    }
    catch {
        # Git not available or not a git repo
    }
    
    return $info
}

# ============================================================================
# Main Script
# ============================================================================

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║               Mosaic Docker Build Script                     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# Check Docker is running
if (-not (Test-DockerRunning)) {
    Write-Host ""
    Write-Host "❌ Docker is not running. Please start Docker Desktop." -ForegroundColor Red
    exit 1
}

# Get git info for build labels
$GitInfo = Get-GitInfo

# Print configuration
Write-Host ""
Write-Host "Configuration:" -ForegroundColor White
Write-Info "  Service:   $Service"
Write-Info "  Tag:       $Tag"
Write-Info "  Registry:  $(if ($Registry) { $Registry } else { '(local only)' })"
Write-Info "  Platform:  $(if ($Platform) { $Platform } else { '(default)' })"
Write-Info "  No Cache:  $NoCache"
if ($GitInfo.Commit) {
    Write-Info "  Git:       $($GitInfo.Branch)@$($GitInfo.Commit)$(if (-not $GitInfo.Clean) { ' (dirty)' })"
}

# Navigate to project root
Push-Location $ProjectRoot

try {
    # Determine compose file
    $ComposeFile = "docker-compose.yml"
    if ($Dev) {
        $ComposeFile = "docker-compose.dev.yml"
    }
    elseif ($Test) {
        $ComposeFile = "docker-compose.test.yml"
    }

    # Build arguments
    $BuildArgs = @("compose", "-f", $ComposeFile, "build")
    
    if ($NoCache) {
        $BuildArgs += "--no-cache"
    }
    
    # Add build args for labels
    $BuildArgs += "--build-arg"
    $BuildArgs += "BUILD_DATE=$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
    
    if ($GitInfo.Commit) {
        $BuildArgs += "--build-arg"
        $BuildArgs += "VCS_REF=$($GitInfo.Commit)"
    }
    
    # Multi-platform builds require buildx
    if ($Platform) {
        Write-Step "Setting up Docker Buildx for multi-platform build"
        
        # Check if buildx is available
        $null = docker buildx version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Buildx is required for multi-platform builds. Please install Docker Buildx."
        }
        
        # Create or use builder
        $builderName = "mosaic-builder"
        docker buildx create --name $builderName --use 2>$null
        docker buildx inspect --bootstrap 2>$null
        
        Write-Success "Buildx ready"
    }
    
    # Determine services to build
    $ServicesToBuild = @()
    if ($Service -eq "all") {
        $ServicesToBuild = @("backend", "frontend")
        $BuildArgs += "--parallel"
    }
    else {
        $ServicesToBuild = @($Service)
        $BuildArgs += $Service
    }

    # Execute build
    Write-Step "Building Docker images"
    
    if ($Platform) {
        # Multi-platform build with buildx
        foreach ($svc in $ServicesToBuild) {
            $imageName = $ImageNames[$svc]
            $fullTag = if ($Registry) { "${Registry}/${imageName}:${Tag}" } else { "${imageName}:${Tag}" }
            
            Write-Info "Building $svc for platforms: $Platform"
            
            $buildxArgs = @(
                "buildx", "build",
                "--platform", $Platform,
                "-t", $fullTag
            )
            
            if (-not $NoPush -and $Registry) {
                $buildxArgs += "--push"
            }
            else {
                $buildxArgs += "--load"
            }
            
            if ($NoCache) {
                $buildxArgs += "--no-cache"
            }
            
            # Add context and dockerfile based on service
            if ($svc -eq "backend") {
                $buildxArgs += "-f"
                $buildxArgs += "apps/backend/Mosaic.Backend/Dockerfile"
                $buildxArgs += "apps/backend/Mosaic.Backend"
            }
            else {
                $buildxArgs += "-f"
                $buildxArgs += "apps/admin/Dockerfile"
                $buildxArgs += "."
            }
            
            & docker @buildxArgs
            
            if ($LASTEXITCODE -ne 0) {
                throw "Build failed for $svc"
            }
        }
    }
    else {
        # Standard build with compose
        & docker @BuildArgs
        
        if ($LASTEXITCODE -ne 0) {
            throw "Docker build failed"
        }
    }

    Write-Success "Build complete"

    # Tag images for registry (if not using buildx which already tags)
    if ($Registry -and -not $Platform) {
        Write-Step "Tagging images for registry: $Registry"
        
        foreach ($svc in $ServicesToBuild) {
            $imageName = $ImageNames[$svc]
            $localTag = "${imageName}:latest"
            $remoteTag = "${Registry}/${imageName}:${Tag}"
            
            Write-Info "$localTag → $remoteTag"
            docker tag $localTag $remoteTag
            
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to tag $imageName"
            }
            
            # Also tag with commit SHA if available
            if ($GitInfo.Commit -and $Tag -ne $GitInfo.Commit) {
                $commitTag = "${Registry}/${imageName}:$($GitInfo.Commit)"
                Write-Info "$localTag → $commitTag"
                docker tag $localTag $commitTag
            }
        }
        
        Write-Success "Tagging complete"
    }

    # Push images
    if ($Registry -and -not $NoPush -and -not $Platform) {
        Write-Step "Pushing images to registry"
        
        foreach ($svc in $ServicesToBuild) {
            $imageName = $ImageNames[$svc]
            $remoteTag = "${Registry}/${imageName}:${Tag}"
            
            Write-Info "Pushing $remoteTag"
            docker push $remoteTag
            
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to push $imageName"
            }
            
            # Push commit SHA tag if available
            if ($GitInfo.Commit -and $Tag -ne $GitInfo.Commit) {
                $commitTag = "${Registry}/${imageName}:$($GitInfo.Commit)"
                Write-Info "Pushing $commitTag"
                docker push $commitTag
            }
        }
        
        Write-Success "Push complete"
    }

    # Print summary
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  Build Summary" -ForegroundColor Green
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Green
    
    foreach ($svc in $ServicesToBuild) {
        $imageName = $ImageNames[$svc]
        if ($Registry) {
            Write-Host "  📦 ${Registry}/${imageName}:${Tag}" -ForegroundColor White
        }
        else {
            Write-Host "  📦 ${imageName}:latest" -ForegroundColor White
        }
    }
    
    Write-Host ""
    Write-Host "  Next Steps:" -ForegroundColor Cyan
    Write-Host "  ─────────────────────────────────────────────────────────────"
    
    if (-not $Registry) {
        Write-Host "  Start application:    docker compose up -d" -ForegroundColor White
        Write-Host "  View logs:            docker compose logs -f" -ForegroundColor White
        Write-Host "  Stop application:     docker compose down" -ForegroundColor White
    }
    else {
        Write-Host "  Pull images:          docker compose pull" -ForegroundColor White
        Write-Host "  Start application:    docker compose up -d" -ForegroundColor White
    }
    
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "❌ Error: $_" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}
