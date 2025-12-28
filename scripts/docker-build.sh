#!/usr/bin/env bash
#
# Mosaic Docker Build Script
# Builds, tags, and optionally pushes Docker images for Mosaic
#
# Usage:
#   ./docker-build.sh [OPTIONS]
#
# Options:
#   -s, --service SERVICE    Build specific service: backend, frontend, or all (default: all)
#   -t, --tag TAG            Docker image tag (default: latest)
#   -r, --registry REGISTRY  Container registry to tag/push images to
#   -n, --no-push            Tag images but don't push to registry
#   --no-cache               Build without using Docker layer cache
#   -p, --platform PLATFORM  Target platform(s) for multi-arch builds
#   --dev                    Build using development compose file
#   --test                   Build using test compose file
#   -h, --help               Show this help message
#
# Examples:
#   ./docker-build.sh
#   ./docker-build.sh -s backend -t v1.0.0
#   ./docker-build.sh -r ghcr.io/myorg -t v1.0.0
#   ./docker-build.sh -p "linux/amd64,linux/arm64" -r ghcr.io/myorg

set -e

# ============================================================================
# Configuration
# ============================================================================

SERVICE="all"
TAG="latest"
REGISTRY=""
NO_PUSH="false"
NO_CACHE="false"
PLATFORM=""
COMPOSE_FILE="docker-compose.yml"

# Image names
declare -A IMAGE_NAMES=(
    ["backend"]="mosaic-backend"
    ["frontend"]="mosaic-frontend"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
NC='\033[0m'

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║               Mosaic Docker Build Script                     ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
}

print_step() {
    echo ""
    echo -e "${YELLOW}▶ $1${NC}"
}

print_success() {
    echo -e "  ${GREEN}✅ $1${NC}"
}

print_info() {
    echo -e "  ${GRAY}$1${NC}"
}

print_error() {
    echo -e "${RED}❌ Error: $1${NC}"
}

show_help() {
    head -30 "$0" | tail -28 | sed 's/^#//' | sed 's/^ //'
    exit 0
}

check_docker() {
    if ! docker info &>/dev/null; then
        print_error "Docker is not running. Please start Docker."
        exit 1
    fi
}

get_git_info() {
    GIT_BRANCH=""
    GIT_COMMIT=""
    GIT_CLEAN="true"
    
    if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null; then
        GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
        if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
            GIT_CLEAN="false"
        fi
    fi
}

# ============================================================================
# Parse Arguments
# ============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--service)
            SERVICE="$2"
            shift 2
            ;;
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        -r|--registry)
            REGISTRY="$2"
            shift 2
            ;;
        -n|--no-push)
            NO_PUSH="true"
            shift
            ;;
        --no-cache)
            NO_CACHE="true"
            shift
            ;;
        -p|--platform)
            PLATFORM="$2"
            shift 2
            ;;
        --dev)
            COMPOSE_FILE="docker-compose.dev.yml"
            shift
            ;;
        --test)
            COMPOSE_FILE="docker-compose.test.yml"
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Validate service
if [[ ! "$SERVICE" =~ ^(all|backend|frontend)$ ]]; then
    print_error "Invalid service: $SERVICE. Must be 'all', 'backend', or 'frontend'"
    exit 1
fi

# ============================================================================
# Main Script
# ============================================================================

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

print_header
check_docker
get_git_info

# Print configuration
echo ""
echo -e "${WHITE}Configuration:${NC}"
print_info "  Service:   $SERVICE"
print_info "  Tag:       $TAG"
print_info "  Registry:  ${REGISTRY:-"(local only)"}"
print_info "  Platform:  ${PLATFORM:-"(default)"}"
print_info "  No Cache:  $NO_CACHE"
if [ -n "$GIT_COMMIT" ]; then
    dirty_marker=""
    [ "$GIT_CLEAN" = "false" ] && dirty_marker=" (dirty)"
    print_info "  Git:       ${GIT_BRANCH}@${GIT_COMMIT}${dirty_marker}"
fi

# Determine services to build
if [ "$SERVICE" = "all" ]; then
    SERVICES=("backend" "frontend")
else
    SERVICES=("$SERVICE")
fi

# Build arguments
BUILD_ARGS=()
[ "$NO_CACHE" = "true" ] && BUILD_ARGS+=("--no-cache")

BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Multi-platform builds
if [ -n "$PLATFORM" ]; then
    print_step "Setting up Docker Buildx for multi-platform build"
    
    if ! docker buildx version &>/dev/null; then
        print_error "Docker Buildx is required for multi-platform builds"
        exit 1
    fi
    
    # Create or use builder
    BUILDER_NAME="mosaic-builder"
    docker buildx create --name "$BUILDER_NAME" --use 2>/dev/null || true
    docker buildx inspect --bootstrap &>/dev/null
    
    print_success "Buildx ready"
fi

# Execute build
print_step "Building Docker images"

if [ -n "$PLATFORM" ]; then
    # Multi-platform build with buildx
    for svc in "${SERVICES[@]}"; do
        image_name="${IMAGE_NAMES[$svc]}"
        if [ -n "$REGISTRY" ]; then
            full_tag="${REGISTRY}/${image_name}:${TAG}"
        else
            full_tag="${image_name}:${TAG}"
        fi
        
        print_info "Building $svc for platforms: $PLATFORM"
        
        buildx_args=(
            "buildx" "build"
            "--platform" "$PLATFORM"
            "-t" "$full_tag"
            "--build-arg" "BUILD_DATE=$BUILD_DATE"
        )
        
        [ -n "$GIT_COMMIT" ] && buildx_args+=("--build-arg" "VCS_REF=$GIT_COMMIT")
        
        if [ "$NO_PUSH" = "false" ] && [ -n "$REGISTRY" ]; then
            buildx_args+=("--push")
        else
            buildx_args+=("--load")
        fi
        
        [ "$NO_CACHE" = "true" ] && buildx_args+=("--no-cache")
        
        # Add context and dockerfile based on service
        if [ "$svc" = "backend" ]; then
            buildx_args+=("-f" "apps/backend/Mosaic.Backend/Dockerfile")
            buildx_args+=("apps/backend/Mosaic.Backend")
        else
            buildx_args+=("-f" "apps/admin/Dockerfile")
            buildx_args+=(".")
        fi
        
        docker "${buildx_args[@]}"
    done
else
    # Standard build with compose
    compose_args=("compose" "-f" "$COMPOSE_FILE" "build")
    
    [ "$SERVICE" = "all" ] && compose_args+=("--parallel")
    [ "$SERVICE" != "all" ] && compose_args+=("$SERVICE")
    
    compose_args+=("${BUILD_ARGS[@]}")
    compose_args+=("--build-arg" "BUILD_DATE=$BUILD_DATE")
    [ -n "$GIT_COMMIT" ] && compose_args+=("--build-arg" "VCS_REF=$GIT_COMMIT")
    
    docker "${compose_args[@]}"
fi

print_success "Build complete"

# Tag images for registry (if not using buildx which already tags)
if [ -n "$REGISTRY" ] && [ -z "$PLATFORM" ]; then
    print_step "Tagging images for registry: $REGISTRY"
    
    for svc in "${SERVICES[@]}"; do
        image_name="${IMAGE_NAMES[$svc]}"
        local_tag="${image_name}:latest"
        remote_tag="${REGISTRY}/${image_name}:${TAG}"
        
        print_info "$local_tag → $remote_tag"
        docker tag "$local_tag" "$remote_tag"
        
        # Also tag with commit SHA if available
        if [ -n "$GIT_COMMIT" ] && [ "$TAG" != "$GIT_COMMIT" ]; then
            commit_tag="${REGISTRY}/${image_name}:${GIT_COMMIT}"
            print_info "$local_tag → $commit_tag"
            docker tag "$local_tag" "$commit_tag"
        fi
    done
    
    print_success "Tagging complete"
fi

# Push images
if [ -n "$REGISTRY" ] && [ "$NO_PUSH" = "false" ] && [ -z "$PLATFORM" ]; then
    print_step "Pushing images to registry"
    
    for svc in "${SERVICES[@]}"; do
        image_name="${IMAGE_NAMES[$svc]}"
        remote_tag="${REGISTRY}/${image_name}:${TAG}"
        
        print_info "Pushing $remote_tag"
        docker push "$remote_tag"
        
        # Push commit SHA tag if available
        if [ -n "$GIT_COMMIT" ] && [ "$TAG" != "$GIT_COMMIT" ]; then
            commit_tag="${REGISTRY}/${image_name}:${GIT_COMMIT}"
            print_info "Pushing $commit_tag"
            docker push "$commit_tag"
        fi
    done
    
    print_success "Push complete"
fi

# Print summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Summary${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"

for svc in "${SERVICES[@]}"; do
    image_name="${IMAGE_NAMES[$svc]}"
    if [ -n "$REGISTRY" ]; then
        echo -e "  📦 ${WHITE}${REGISTRY}/${image_name}:${TAG}${NC}"
    else
        echo -e "  📦 ${WHITE}${image_name}:latest${NC}"
    fi
done

echo ""
echo -e "  ${CYAN}Next Steps:${NC}"
echo "  ─────────────────────────────────────────────────────────────"

if [ -z "$REGISTRY" ]; then
    echo "  Start application:    docker compose up -d"
    echo "  View logs:            docker compose logs -f"
    echo "  Stop application:     docker compose down"
else
    echo "  Pull images:          docker compose pull"
    echo "  Start application:    docker compose up -d"
fi

echo ""
