#!/usr/bin/env pwsh
# Mosaic Docker Build Script
# Builds all Docker images for the Mosaic application

param(
    [switch]$NoPush,
    [string]$Tag = "latest",
    [string]$Registry = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "🏗️  Building Mosaic Docker images..." -ForegroundColor Cyan
Write-Host "   Tag: $Tag" -ForegroundColor Gray
Write-Host ""

# Navigate to project root
Push-Location $ProjectRoot

try {
    # Build with docker compose
    Write-Host "📦 Building all services..." -ForegroundColor Yellow
    docker compose build --parallel

    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed"
    }

    Write-Host ""
    Write-Host "✅ Build complete!" -ForegroundColor Green

    # Tag images if registry is specified
    if ($Registry -ne "") {
        Write-Host ""
        Write-Host "🏷️  Tagging images for registry: $Registry" -ForegroundColor Yellow
        
        $images = @("mosaic-backend", "mosaic-frontend")
        foreach ($image in $images) {
            $localTag = "${image}:latest"
            $remoteTag = "${Registry}/${image}:${Tag}"
            
            Write-Host "   $localTag -> $remoteTag" -ForegroundColor Gray
            docker tag $localTag $remoteTag
        }

        if (-not $NoPush) {
            Write-Host ""
            Write-Host "📤 Pushing images to registry..." -ForegroundColor Yellow
            foreach ($image in $images) {
                $remoteTag = "${Registry}/${image}:${Tag}"
                docker push $remoteTag
            }
            Write-Host "✅ Push complete!" -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "🚀 To start the application:" -ForegroundColor Cyan
    Write-Host "   docker compose up -d" -ForegroundColor White
    Write-Host ""
    Write-Host "📊 To view logs:" -ForegroundColor Cyan
    Write-Host "   docker compose logs -f" -ForegroundColor White
}
finally {
    Pop-Location
}
