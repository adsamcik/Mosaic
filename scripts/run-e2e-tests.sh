#!/usr/bin/env bash
#
# Mosaic E2E Test Runner
#
# Usage:
#   ./scripts/run-e2e-tests.sh                    # Run all tests on chromium
#   ./scripts/run-e2e-tests.sh -p firefox         # Run on firefox
#   ./scripts/run-e2e-tests.sh -t auth.spec.ts    # Run specific test
#   ./scripts/run-e2e-tests.sh -h                 # Headed mode
#   ./scripts/run-e2e-tests.sh -d                 # Debug mode
#

set -e

# Default values
PROJECT="chromium"
TEST_FILE=""
HEADED=false
DEBUG=false
SKIP_BUILD=false

# Parse arguments
while getopts "p:t:hds" opt; do
    case $opt in
        p) PROJECT="$OPTARG" ;;
        t) TEST_FILE="$OPTARG" ;;
        h) HEADED=true ;;
        d) DEBUG=true ;;
        s) SKIP_BUILD=true ;;
        *) echo "Usage: $0 [-p project] [-t testfile] [-h] [-d] [-s]"; exit 1 ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
MAGENTA='\033[0;35m'
NC='\033[0m'

step() { echo -e "\n${CYAN}[→] $1${NC}"; }
success() { echo -e "${GREEN}[✓] $1${NC}"; }
fail() { echo -e "${RED}[✗] $1${NC}"; }
info() { echo -e "${GRAY}    $1${NC}"; }

# Get repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "\n${MAGENTA}========================================"
echo -e "  Mosaic E2E Test Runner"
echo -e "========================================${NC}"
info "Repository: $REPO_ROOT"

# Track PIDs for cleanup
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    step "Cleaning up..."
    
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        info "Stopping frontend server..."
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        info "Stopping backend server..."
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
    
    # Kill any orphaned processes on our ports
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    lsof -ti:8080 | xargs kill -9 2>/dev/null || true
    
    success "Cleanup complete"
}

trap cleanup EXIT INT TERM

# ==========================================================================
# Step 1: Start PostgreSQL
# ==========================================================================
step "Starting PostgreSQL..."

cd "$REPO_ROOT"
docker compose -f docker-compose.dev.yml up -d postgres

info "Waiting for PostgreSQL to be ready..."
max_wait=30
waited=0
while [ $waited -lt $max_wait ]; do
    health=$(docker inspect --format='{{.State.Health.Status}}' mosaic-postgres-dev 2>/dev/null || echo "unknown")
    if [ "$health" = "healthy" ]; then
        break
    fi
    sleep 1
    waited=$((waited + 1))
done

if [ "$health" != "healthy" ]; then
    fail "PostgreSQL did not become healthy within ${max_wait}s"
    exit 1
fi
success "PostgreSQL is ready"

# ==========================================================================
# Step 2: Run Database Migrations
# ==========================================================================
step "Running database migrations..."

cd "$REPO_ROOT/apps/backend/Mosaic.Backend"
dotnet ef database update 2>&1 || true
success "Database migrations applied"

# ==========================================================================
# Step 3: Install dependencies
# ==========================================================================
if [ "$SKIP_BUILD" = false ]; then
    step "Installing dependencies..."
    
    cd "$REPO_ROOT/apps/admin"
    npm install --silent 2>/dev/null
    
    cd "$REPO_ROOT/tests/e2e"
    npm install --silent 2>/dev/null
    npx playwright install chromium --with-deps 2>/dev/null
    
    success "Dependencies installed"
fi

# ==========================================================================
# Step 4: Start Backend
# ==========================================================================
step "Starting .NET backend on port 8080..."

# Kill any existing process on port 8080
lsof -ti:8080 | xargs kill -9 2>/dev/null || true
sleep 1

cd "$REPO_ROOT/apps/backend/Mosaic.Backend"
dotnet run --urls="http://localhost:8080" > /dev/null 2>&1 &
BACKEND_PID=$!

info "Waiting for backend to be ready..."
max_wait=60
waited=0
while [ $waited -lt $max_wait ]; do
    # Use /health (not /api/health) - this endpoint bypasses auth
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
    waited=$((waited + 1))
done

if ! curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    fail "Backend did not become ready within ${max_wait}s"
    exit 1
fi
success "Backend is ready at http://localhost:8080"

# ==========================================================================
# Step 5: Start Frontend
# ==========================================================================
step "Starting Vite frontend on port 5173..."

# Kill any existing process on port 5173
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
sleep 1

cd "$REPO_ROOT/apps/admin"
npm run dev > /dev/null 2>&1 &
FRONTEND_PID=$!

info "Waiting for frontend to be ready..."
max_wait=60
waited=0
while [ $waited -lt $max_wait ]; do
    if curl -sf http://localhost:5173 > /dev/null 2>&1; then
        break
    fi
    sleep 1
    waited=$((waited + 1))
done

if ! curl -sf http://localhost:5173 > /dev/null 2>&1; then
    fail "Frontend did not become ready within ${max_wait}s"
    exit 1
fi
success "Frontend is ready at http://localhost:5173"

# ==========================================================================
# Step 6: Run Playwright Tests
# ==========================================================================
step "Running Playwright E2E tests..."
echo ""

cd "$REPO_ROOT/tests/e2e"

# Build the playwright command
PLAYWRIGHT_ARGS="playwright test"

if [ -n "$TEST_FILE" ]; then
    PLAYWRIGHT_ARGS="$PLAYWRIGHT_ARGS $TEST_FILE"
fi

if [ "$PROJECT" != "all" ]; then
    PLAYWRIGHT_ARGS="$PLAYWRIGHT_ARGS --project=$PROJECT"
fi

if [ "$HEADED" = true ]; then
    PLAYWRIGHT_ARGS="$PLAYWRIGHT_ARGS --headed"
fi

if [ "$DEBUG" = true ]; then
    PLAYWRIGHT_ARGS="$PLAYWRIGHT_ARGS --debug"
fi

info "Command: npx $PLAYWRIGHT_ARGS"
echo ""

# Run the tests
set +e
npx $PLAYWRIGHT_ARGS
TEST_EXIT_CODE=$?
set -e

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
    success "All tests passed!"
else
    fail "Some tests failed (exit code: $TEST_EXIT_CODE)"
fi

exit $TEST_EXIT_CODE
