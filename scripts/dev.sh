#!/usr/bin/env bash
#
# Mosaic Local Development Script
# Quick deployment and hosting of local builds
#
# Usage: ./scripts/dev.sh <command> [options]
#
# Commands:
#   up          Start PostgreSQL and show instructions for backend/frontend
#   down        Stop PostgreSQL and clean up
#   db          Start only PostgreSQL (add --admin for pgAdmin)
#   backend     Run backend with hot-reload (dotnet watch)
#   frontend    Run frontend with HMR (Vite dev server)
#   build       Build and run production containers locally
#   rebuild     Build without cache and run
#   logs        View recent logs (non-blocking, add -f to follow)
#   status      Show status of development environment
#   reset       Reset development environment (--full to remove node_modules)
#   help        Show this help message

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
DB_CONNECTION_STRING="Host=localhost;Database=mosaic;Username=mosaic;Password=dev"
BACKEND_PORT=5000
FRONTEND_PORT=5173
DB_PORT=5432

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

title() { echo -e "\n${CYAN}$1${NC}"; }
step() { echo -e "  ${YELLOW}▶${NC} $1"; }
done_msg() { echo -e "  ${GREEN}✅${NC} $1"; }
err() { echo -e "  ${RED}❌${NC} $1"; }
info() { echo -e "  ${GRAY}ℹ${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠️${NC} $1"; }

# Check if Docker is available and running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo ""
        err "Docker is not running!"
        echo ""
        echo -e "${WHITE}Please start Docker:${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo -e "  ${GRAY}1. Open Docker Desktop from Applications${NC}"
            echo -e "  ${GRAY}2. Wait for it to fully start (whale icon stops animating)${NC}"
        else
            echo -e "  ${GRAY}1. Run: sudo systemctl start docker${NC}"
            echo -e "  ${GRAY}2. Or start Docker Desktop if installed${NC}"
        fi
        echo -e "  ${GRAY}3. Run this command again${NC}"
        echo ""
        echo -e "${WHITE}If Docker is not installed:${NC}"
        echo -e "  ${GRAY}https://docs.docker.com/get-docker/${NC}"
        echo ""
        exit 1
    fi
}

# Commands that require Docker
DOCKER_COMMANDS="up down db build rebuild logs status reset"

cd "$PROJECT_ROOT"

wait_for_database() {
    step "Waiting for PostgreSQL to be ready..."
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if docker exec mosaic-postgres-dev pg_isready -U mosaic -d mosaic > /dev/null 2>&1; then
            done_msg "PostgreSQL is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    
    err "PostgreSQL failed to start within 30 seconds"
    return 1
}

start_database() {
    step "Starting PostgreSQL..."
    docker compose -f docker-compose.dev.yml up -d postgres
    wait_for_database
}

stop_database() {
    step "Stopping PostgreSQL..."
    docker compose -f docker-compose.dev.yml down
    done_msg "Database stopped"
}

start_backend() {
    title "Starting Backend (hot-reload)..."
    
    cd "$PROJECT_ROOT/apps/backend/Mosaic.Backend"
    
    export ASPNETCORE_ENVIRONMENT="Development"
    export ASPNETCORE_URLS="http://localhost:$BACKEND_PORT"
    export ConnectionStrings__Default="$DB_CONNECTION_STRING"
    export Storage__Path="$PROJECT_ROOT/data/blobs"
    export Auth__TrustedProxies__0="127.0.0.0/8"
    export RUN_MIGRATIONS="true"
    
    # Ensure storage directory exists
    mkdir -p "$PROJECT_ROOT/data/blobs"
    
    info "Backend URL: http://localhost:$BACKEND_PORT"
    info "API Docs: http://localhost:$BACKEND_PORT/swagger"
    echo ""
    
    dotnet watch run
}

start_frontend() {
    title "Starting Frontend (Vite HMR)..."
    
    # Check if crypto lib is built
    if [ ! -d "$PROJECT_ROOT/libs/crypto/dist" ]; then
        step "Building crypto library..."
        cd "$PROJECT_ROOT/libs/crypto"
        npm install
        npm run build
    fi
    
    cd "$PROJECT_ROOT/apps/admin"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        step "Installing frontend dependencies..."
        npm install
    fi
    
    info "Frontend URL: http://localhost:$FRONTEND_PORT"
    info "Backend proxy: http://localhost:$BACKEND_PORT"
    echo ""
    
    npm run dev
}

build_and_run() {
    local no_cache=""
    if [ "$1" = "--no-cache" ]; then
        no_cache="--no-cache"
    fi
    
    title "Building production containers..."
    docker compose build $no_cache
    
    title "Starting production containers..."
    docker compose up -d
    
    done_msg "Mosaic is running at http://localhost:8080"
    info "Run './scripts/dev.sh logs' to view container logs"
}

show_status() {
    title "Development Environment Status"
    echo ""
    
    echo -e "${NC}Docker Containers:${NC}"
    local dev_db
    dev_db=$(docker ps --filter "name=mosaic-postgres-dev" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true)
    if [ -n "$dev_db" ]; then
        echo "$dev_db"
    else
        info "No development containers running"
    fi
    echo ""
    
    echo -e "${NC}Local Processes:${NC}"
    
    # Check backend
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$BACKEND_PORT/health" 2>/dev/null | grep -q "200"; then
        echo -e "  Backend:  ${GREEN}Running${NC} (http://localhost:$BACKEND_PORT)"
    else
        echo -e "  Backend:  ${GRAY}Not running${NC}"
    fi
    
    # Check frontend
    if curl -s -o /dev/null "http://localhost:$FRONTEND_PORT" 2>/dev/null; then
        echo -e "  Frontend: ${GREEN}Running${NC} (http://localhost:$FRONTEND_PORT)"
    else
        echo -e "  Frontend: ${GRAY}Not running${NC}"
    fi
}

show_help() {
    cat << EOF

Mosaic Development Helper
=========================

Usage: ./scripts/dev.sh <command> [options]

Commands:
  up          Start PostgreSQL and show instructions for backend/frontend
  down        Stop PostgreSQL and clean up
  db          Start only PostgreSQL (add --admin for pgAdmin)
  backend     Run backend with hot-reload (dotnet watch)
  frontend    Run frontend with HMR (Vite dev server)
  build       Build and run production containers locally
  rebuild     Build without cache and run
  logs        View recent logs (non-blocking, add -f to follow)
  status      Show status of development environment
  test        Run tests (unit, e2e, or all)
  reset       Reset development environment (--full to remove node_modules)
  help        Show this help message

Test Commands:
  test             Run all unit tests (crypto, frontend, backend)
  test unit        Run all unit tests
  test e2e         Run E2E tests (requires running services)
  test e2e [opts]  Run E2E with Playwright options (--headed, --grep, etc.)

Quick Start:
  1. ./scripts/dev.sh up              # Start database
  2. ./scripts/dev.sh backend         # Terminal 1: Start backend
  3. ./scripts/dev.sh frontend        # Terminal 2: Start frontend

Production-like Build:
  ./scripts/dev.sh build              # Build and run Docker containers

URLs:
  Frontend (dev):  http://localhost:$FRONTEND_PORT
  Backend (dev):   http://localhost:$BACKEND_PORT
  Swagger:         http://localhost:$BACKEND_PORT/swagger
  Production:      http://localhost:8080

EOF
}

# Parse command
COMMAND="${1:-help}"
shift || true

# Check Docker for commands that need it
case "$COMMAND" in
    up|down|db|build|rebuild|logs|status|reset)
        check_docker
        ;;
esac

case "$COMMAND" in
    up)
        title "🚀 Starting Mosaic Development Environment"
        echo ""
        info "This will start:"
        info "  • PostgreSQL database (Docker)"
        info "  • Backend API with hot-reload (dotnet watch)"
        info "  • Frontend with HMR (Vite)"
        echo ""
        
        start_database
        
        echo ""
        done_msg "Database is ready on port $DB_PORT"
        echo ""
        echo -e "${NC}Now start backend and frontend in separate terminals:${NC}"
        echo ""
        echo -e "  ${YELLOW}Terminal 1: ./scripts/dev.sh backend${NC}"
        echo -e "  ${YELLOW}Terminal 2: ./scripts/dev.sh frontend${NC}"
        echo ""
        info "Frontend will be at: http://localhost:$FRONTEND_PORT"
        info "Backend API at: http://localhost:$BACKEND_PORT"
        ;;
    
    down)
        title "Stopping development environment..."
        stop_database
        done_msg "Development environment stopped"
        ;;
    
    db)
        title "Starting PostgreSQL database..."
        start_database
        done_msg "PostgreSQL is running on port $DB_PORT"
        info "Connection string: $DB_CONNECTION_STRING"
        
        if [[ "$*" == *"--admin"* ]] || [[ "$*" == *"-a"* ]]; then
            step "Starting pgAdmin..."
            docker compose -f docker-compose.dev.yml --profile tools up -d pgadmin
            done_msg "pgAdmin is running at http://localhost:5050"
            info "Login: admin@mosaic.local / admin"
        fi
        ;;
    
    backend)
        # Ensure database is running
        if ! docker ps --filter "name=mosaic-postgres-dev" --format "{{.Names}}" 2>/dev/null | grep -q "mosaic-postgres-dev"; then
            start_database
        fi
        start_backend
        ;;
    
    frontend)
        start_frontend
        ;;
    
    build)
        build_and_run
        ;;
    
    rebuild)
        build_and_run --no-cache
        ;;
    
    logs)
        service="${1:-}"
        shift || true
        follow=false
        tail_lines=50
        
        # Parse options
        for arg in "$@"; do
            case "$arg" in
                -f|--follow) follow=true ;;
                --tail=*) tail_lines="${arg#*=}" ;;
            esac
        done
        
        if [ "$follow" = true ]; then
            if [ -n "$service" ]; then
                docker compose logs -f --tail="$tail_lines" "$service"
            else
                docker compose logs -f --tail="$tail_lines"
            fi
        else
            if [ -n "$service" ]; then
                docker compose logs --tail="$tail_lines" "$service"
            else
                docker compose logs --tail="$tail_lines"
            fi
        fi
        ;;
    
    status)
        show_status
        ;;
    
    reset)
        title "Resetting development environment..."
        
        step "Stopping containers..."
        docker compose -f docker-compose.dev.yml down -v || true
        docker compose down -v 2>/dev/null || true
        
        step "Removing local data..."
        rm -rf "$PROJECT_ROOT/data"
        
        step "Cleaning node_modules (optional)..."
        if [[ "$*" == *"--full"* ]] || [[ "$*" == *"-f"* ]]; then
            rm -rf "$PROJECT_ROOT/apps/admin/node_modules"
            rm -rf "$PROJECT_ROOT/libs/crypto/node_modules"
            done_msg "Full reset complete"
        else
            done_msg "Reset complete (use --full to also remove node_modules)"
        fi
        ;;
    
    test)
        test_type="${1:-all}"
        shift || true
        
        case "$test_type" in
            all|unit)
                title "Running all unit tests..."
                
                step "Running crypto library tests..."
                pushd "$PROJECT_ROOT/libs/crypto" > /dev/null
                npm test
                popd > /dev/null
                
                step "Running frontend tests..."
                pushd "$PROJECT_ROOT/apps/admin" > /dev/null
                npm run test:run
                popd > /dev/null
                
                step "Running backend tests..."
                pushd "$PROJECT_ROOT/apps/backend/Mosaic.Backend.Tests" > /dev/null
                dotnet test
                popd > /dev/null
                
                done_msg "All unit tests completed!"
                ;;
            
            e2e)
                title "Running E2E tests..."
                
                # Check if services are accessible
                if ! curl -s "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
                    err "Backend not running on port $BACKEND_PORT"
                    info "Start services first with: ./scripts/dev.sh up && ./scripts/dev.sh backend"
                    exit 1
                fi
                
                if ! curl -s "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
                    err "Frontend not running on port $FRONTEND_PORT"
                    info "Start frontend with: ./scripts/dev.sh frontend"
                    exit 1
                fi
                
                info "Running against: Frontend=http://localhost:$FRONTEND_PORT Backend=http://localhost:$BACKEND_PORT"
                
                # Ensure E2E dependencies
                e2e_path="$PROJECT_ROOT/tests/e2e"
                if [ ! -d "$e2e_path/node_modules" ]; then
                    step "Installing E2E dependencies..."
                    pushd "$e2e_path" > /dev/null
                    npm install
                    npx playwright install chromium --with-deps
                    popd > /dev/null
                fi
                
                pushd "$e2e_path" > /dev/null
                
                export BASE_URL="http://localhost:$FRONTEND_PORT"
                export API_URL="http://localhost:$BACKEND_PORT"
                
                # Pass remaining args to playwright
                npx playwright test "$@"
                
                popd > /dev/null
                ;;
            
            *)
                err "Unknown test type: $test_type"
                info "Options: all, unit, e2e"
                exit 1
                ;;
        esac
        ;;
    
    help|*)
        show_help
        ;;
esac
