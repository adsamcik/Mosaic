#!/usr/bin/env bash
# Mosaic Test Runner
# Runs integration and E2E tests using Docker

set -e

# Configuration
SUITE="${1:-all}"
BUILD="${BUILD:-false}"
KEEP="${KEEP:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo -e "${CYAN}🧪 Mosaic Test Runner${NC}"
echo "   Suite: $SUITE"
echo ""

cleanup() {
    if [ "$KEEP" != "true" ]; then
        echo -e "\n${CYAN}🧹 Cleaning up...${NC}"
        docker compose -f docker-compose.test.yml down -v
    else
        echo -e "\n${YELLOW}⚠️  Keeping containers running${NC}"
    fi
}

trap cleanup EXIT

# Build if requested
if [ "$BUILD" = "true" ]; then
    echo -e "${CYAN}📦 Building test containers...${NC}"
    docker compose -f docker-compose.test.yml build
fi

# Start infrastructure
echo -e "${CYAN}🚀 Starting test infrastructure...${NC}"
docker compose -f docker-compose.test.yml up -d postgres backend frontend

# Wait for services to be healthy
echo -e "${CYAN}⏳ Waiting for services to be healthy...${NC}"
max_wait=60
waited=0
while [ $waited -lt $max_wait ]; do
    healthy=$(docker compose -f docker-compose.test.yml ps --format json | jq -r 'select(.Health == "healthy")' | wc -l)
    if [ "$healthy" -ge 3 ]; then
        echo -e "${GREEN}✅ All services healthy${NC}"
        break
    fi
    sleep 2
    waited=$((waited + 2))
    printf "."
done

if [ $waited -ge $max_wait ]; then
    echo -e "${RED}❌ Services did not become healthy in time${NC}"
    exit 1
fi

exit_code=0

# Run API integration tests
if [ "$SUITE" = "all" ] || [ "$SUITE" = "api" ]; then
    echo -e "\n${CYAN}🔌 Running API integration tests...${NC}"
    if docker compose -f docker-compose.test.yml run --rm api-tests; then
        echo -e "${GREEN}✅ API tests passed${NC}"
    else
        echo -e "${RED}❌ API tests failed${NC}"
        exit_code=1
    fi
fi

# Run E2E tests
if [ "$SUITE" = "all" ] || [ "$SUITE" = "e2e" ]; then
    echo -e "\n${CYAN}🎭 Running E2E tests...${NC}"
    if docker compose -f docker-compose.test.yml run --rm e2e-tests; then
        echo -e "${GREEN}✅ E2E tests passed${NC}"
    else
        echo -e "${RED}❌ E2E tests failed${NC}"
        exit_code=1
    fi
fi

# Run unit tests
if [ "$SUITE" = "all" ] || [ "$SUITE" = "unit" ]; then
    echo -e "\n${CYAN}🧩 Running crypto library unit tests...${NC}"
    cd "$PROJECT_ROOT/libs/crypto"
    if npm test -- run; then
        echo -e "${GREEN}✅ Crypto unit tests passed${NC}"
    else
        echo -e "${RED}❌ Crypto unit tests failed${NC}"
        exit_code=1
    fi
    cd "$PROJECT_ROOT"

    echo -e "\n${CYAN}🧩 Running admin frontend tests...${NC}"
    cd "$PROJECT_ROOT/apps/web"
    if npm test -- run; then
        echo -e "${GREEN}✅ Admin tests passed${NC}"
    else
        echo -e "${RED}❌ Admin tests failed${NC}"
        exit_code=1
    fi
    cd "$PROJECT_ROOT"
fi

echo ""
if [ $exit_code -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
else
    echo -e "${RED}💥 Some tests failed${NC}"
fi

exit $exit_code
