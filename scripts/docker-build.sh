#!/usr/bin/env bash
# Mosaic Docker Build Script
# Builds all Docker images for the Mosaic application

set -e

# Configuration
TAG="${TAG:-latest}"
REGISTRY="${REGISTRY:-}"
NO_PUSH="${NO_PUSH:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo -e "${CYAN}🏗️  Building Mosaic Docker images...${NC}"
echo -e "${GRAY}   Tag: $TAG${NC}"
echo ""

# Build with docker compose
echo -e "${YELLOW}📦 Building all services...${NC}"
docker compose build --parallel

echo ""
echo -e "${GREEN}✅ Build complete!${NC}"

# Tag images if registry is specified
if [ -n "$REGISTRY" ]; then
    echo ""
    echo -e "${YELLOW}🏷️  Tagging images for registry: $REGISTRY${NC}"
    
    for image in mosaic-backend mosaic-frontend; do
        local_tag="${image}:latest"
        remote_tag="${REGISTRY}/${image}:${TAG}"
        
        echo -e "${GRAY}   $local_tag -> $remote_tag${NC}"
        docker tag "$local_tag" "$remote_tag"
    done

    if [ "$NO_PUSH" != "true" ]; then
        echo ""
        echo -e "${YELLOW}📤 Pushing images to registry...${NC}"
        for image in mosaic-backend mosaic-frontend; do
            remote_tag="${REGISTRY}/${image}:${TAG}"
            docker push "$remote_tag"
        done
        echo -e "${GREEN}✅ Push complete!${NC}"
    fi
fi

echo ""
echo -e "${CYAN}🚀 To start the application:${NC}"
echo "   docker compose up -d"
echo ""
echo -e "${CYAN}📊 To view logs:${NC}"
echo "   docker compose logs -f"
