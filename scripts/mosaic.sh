#!/usr/bin/env bash
#
# Mosaic Docker Helper Script
# Common operations for managing Mosaic Docker deployment
#
# Usage: ./mosaic.sh <command> [args]
#
# Commands:
#   start              Start all Mosaic services
#   stop               Stop all services
#   restart [service]  Restart all or specific service
#   status             Show container status and health
#   logs [service]     Follow logs (all or specific service)
#
#   build [options]    Build Docker images
#   pull               Pull latest images from registry
#   update             Create backup, pull, migrate, and recreate
#
#   backup             Create backup of database and blobs
#   restore <dir>      Restore from backup directory
#   verify-backup <dir> Verify a backup through an isolated restore rehearsal
#
#   shell [service]    Open shell in container (default: backend)
#   db                 Connect to PostgreSQL CLI
#
#   clean              Remove stopped containers and unused images
#   reset              ⚠️  DELETE all data and start fresh

set -e

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
NC='\033[0m'
MOSAIC_UTILITY_IMAGE="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"

print_title() { echo -e "\n${CYAN}$1${NC}"; }
print_step() { echo -e "  ${YELLOW}▶ $1${NC}"; }
print_done() { echo -e "  ${GREEN}✅ $1${NC}"; }
print_err() { echo -e "  ${RED}❌ $1${NC}"; }

# Check if Docker is available and running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo ""
        print_err "Docker is not running!"
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

wait_backend_healthy() {
    local container_id health
    for _ in $(seq 1 60); do
        container_id="$(docker compose ps --status running -q backend)" || return 1
        if [ -n "$container_id" ]; then
            health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
            if [ "$health" = "healthy" ]; then
                return 0
            fi
        fi
        sleep 2
    done
    print_err "Backend did not become healthy within 120 seconds"
    return 1
}

resume_backend_without_reconcile() {
    # `up` may reconcile a newly edited digest override and start the candidate
    # before its migration. `start` resumes only the exact stopped container.
    docker compose start backend
    wait_backend_healthy
}

MAINTENANCE_LOCK_DIR=""

acquire_maintenance_lock() {
    local lock_key
    lock_key="$(printf "%s" "$PROJECT_ROOT" | tr "/:" "__")"
    MAINTENANCE_LOCK_DIR="${TMPDIR:-/tmp}/mosaic-backup-restore-${lock_key}"
    if ! mkdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null; then
        print_err "Another backup or restore is already running for this deployment"
        return 1
    fi
}

release_maintenance_lock() {
    if [ -n "$MAINTENANCE_LOCK_DIR" ]; then
        rmdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null || true
        MAINTENANCE_LOCK_DIR=""
    fi
}

sha256_file() {
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum "$1" | awk "{print \$1}"
    elif command -v shasum > /dev/null 2>&1; then
        shasum -a 256 "$1" | awk "{print \$1}"
    else
        print_err "Neither sha256sum nor shasum is available"
        return 1
    fi
}

write_backup_manifest() {
    local database_hash blob_hash
    database_hash="$(sha256_file "$BACKUP_DIR/database.dump")" || return 1
    blob_hash="$(sha256_file "$BACKUP_DIR/blobs.tar.gz")" || return 1
    printf "%s  database.dump\n%s  blobs.tar.gz\n" "$database_hash" "$blob_hash" > "$BACKUP_DIR/manifest.sha256"
}

verify_backup_manifest() {
    local database_hash blob_hash expected_manifest actual_manifest
    database_hash="$(sha256_file "$BACKUP_DIR/database.dump")" || return 1
    blob_hash="$(sha256_file "$BACKUP_DIR/blobs.tar.gz")" || return 1
    expected_manifest="$(printf "%s  database.dump\n%s  blobs.tar.gz" "$database_hash" "$blob_hash")"
    actual_manifest="$(tr -d "\r" < "$BACKUP_DIR/manifest.sha256")"
    [ "$actual_manifest" = "$expected_manifest" ]
}

COMMAND="${1:-help}"
shift || true

# Check Docker for all commands except help
if [ "$COMMAND" != "help" ]; then
    check_docker
fi

case "$COMMAND" in
    start)
        print_title "Starting Mosaic..."
        docker compose up -d
        print_done "Mosaic is running at http://localhost:${FRONTEND_PORT:-8080}"
        ;;
        
    stop)
        print_title "Stopping Mosaic..."
        docker compose down
        print_done "Mosaic stopped"
        ;;
        
    restart)
        print_title "Restarting Mosaic..."
        docker compose restart "$@"
        print_done "Mosaic restarted"
        ;;
        
    status)
        print_title "Mosaic Status"
        docker compose ps
        echo ""
        echo -e "${WHITE}Health Checks:${NC}"
        for container in mosaic-frontend mosaic-backend mosaic-postgres; do
            health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
            case "$health" in
                healthy) color="$GREEN" ;;
                unhealthy) color="$RED" ;;
                *) color="$YELLOW" ;;
            esac
            echo -e "  $container: ${color}$health${NC}"
        done
        ;;
        
    logs)
        if [ -n "$1" ]; then
            docker compose logs -f "$1"
        else
            docker compose logs -f
        fi
        ;;
        
    build)
        print_title "Building Mosaic..."
        "$SCRIPT_DIR/docker-build.sh" "$@"
        ;;
        
    pull)
        print_title "Pulling latest images..."
        docker compose pull
        print_done "Images updated"
        ;;
        
    update)
        print_title "Updating Mosaic..."
        print_step "Creating and rehearsing a matched pre-upgrade backup..."
        "$SCRIPT_DIR/mosaic.sh" backup

        print_step "Pulling candidate images..."
        docker compose pull

        UPDATE_QUIESCED=false
        UPDATE_COMPLETE=false
        cleanup_update() {
            if [ "$UPDATE_QUIESCED" = true ] && [ "$UPDATE_COMPLETE" != true ]; then
                print_err "Update failed after quiesce; stopping frontend/backend to prevent partial service"
                docker compose stop frontend backend || true
            fi
            release_maintenance_lock
        }

        acquire_maintenance_lock || exit 1
        trap cleanup_update EXIT

        print_step "Stopping the serving backend before schema migration..."
        UPDATE_QUIESCED=true
        docker compose stop backend

        print_step "Applying schema through the one-shot migration command..."
        if ! docker compose run --rm --no-deps backend --migrate-only; then
            print_err "Migration failed; backend remains stopped. Restore the matched pre-upgrade backup before rollback"
            exit 1
        fi

        print_step "Recreating and health-checking candidate containers..."
        if ! docker compose up -d --remove-orphans --wait; then
            print_err "Candidate containers did not become healthy"
            exit 1
        fi

        UPDATE_COMPLETE=true
        release_maintenance_lock
        trap - EXIT
        print_done "Verified update complete"
        ;;
        
    backup)
        print_title "Creating Mosaic Backup"
        TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
        BACKUP_DIR="backups/$TIMESTAMP"
        BACKEND_WAS_RUNNING=""
        BACKEND_STOPPED=false

        cleanup_backup() {
            if [ "$BACKEND_STOPPED" = true ] && [ -n "$BACKEND_WAS_RUNNING" ]; then
                print_step "Resuming backend..."
                resume_backend_without_reconcile
            fi
            release_maintenance_lock
        }

        acquire_maintenance_lock || exit 1
        trap cleanup_backup EXIT
        mkdir -p backups
        if [ -e "$BACKUP_DIR" ]; then
            print_err "Backup directory already exists: $BACKUP_DIR"
            exit 1
        fi
        mkdir "$BACKUP_DIR"

        BACKEND_WAS_RUNNING="$(docker compose ps --status running -q backend)"
        if [ -n "$BACKEND_WAS_RUNNING" ]; then
            print_step "Stopping backend for a matched database/blob snapshot..."
            docker compose stop backend
            BACKEND_STOPPED=true
        fi

        print_step "Backing up PostgreSQL database..."
        docker compose exec -T postgres pg_dump --format=custom --no-owner --no-privileges -U mosaic mosaic > "$BACKUP_DIR/database.dump"

        print_step "Backing up blob storage..."
        docker run --rm -v mosaic_blob_data:/data -v "$(pwd)/$BACKUP_DIR:/backup" "$MOSAIC_UTILITY_IMAGE" \
            tar czf /backup/blobs.tar.gz -C /data .

        print_step "Verifying and binding the snapshot pair..."
        docker compose exec -T postgres pg_restore --list < "$BACKUP_DIR/database.dump" > /dev/null
        write_backup_manifest

        if [ "$BACKEND_STOPPED" = true ]; then
            print_step "Resuming backend..."
            resume_backend_without_reconcile
            BACKEND_STOPPED=false
        fi

        print_step "Rehearsing the matched backup in isolated Docker resources..."
        "$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"

        print_done "Matched backup pair saved to $BACKUP_DIR"
        echo ""
        echo -e "${WHITE}Files:${NC}"
        ls -lh "$BACKUP_DIR" | awk 'NR>1 {print "  " $9 ": " $5}'
        ;;
        
    restore)
        if [ "$#" -ne 1 ]; then
            print_err "Please specify backup directory"
            echo "Usage: ./mosaic.sh restore backups/20240101T120000Z"
            exit 1
        fi

        BACKUP_DIR="$1"
        if [ ! -d "$BACKUP_DIR" ]; then
            print_err "Backup directory not found: $BACKUP_DIR"
            exit 1
        fi
        BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
        BACKEND_WAS_RUNNING=""
        BACKEND_STOPPED=false
        RESTORE_COMPLETE=false

        cleanup_restore() {
            if [ "$BACKEND_STOPPED" = true ] && [ -n "$BACKEND_WAS_RUNNING" ]; then
                if [ "$RESTORE_COMPLETE" = true ]; then
                    print_step "Starting backend after verified restore..."
                    resume_backend_without_reconcile
                else
                    print_err "Restore failed; backend remains stopped to avoid serving a partial restore"
                fi
            fi
            release_maintenance_lock
        }

        acquire_maintenance_lock || exit 1
        trap cleanup_restore EXIT

        if [ ! -f "$BACKUP_DIR/database.dump" ] || [ ! -f "$BACKUP_DIR/blobs.tar.gz" ] || [ ! -f "$BACKUP_DIR/manifest.sha256" ]; then
            print_err "Backup must contain database.dump, blobs.tar.gz, and manifest.sha256"
            exit 1
        fi
        if ! verify_backup_manifest; then
            print_err "Backup manifest does not exactly match its database/blob pair; refusing restore"
            exit 1
        fi

        print_step "Rehearsing backup restore and active-shard reconciliation in isolation..."
        "$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"

        print_title "Restoring Mosaic from $BACKUP_DIR"
        echo ""
        echo -e "${RED}⚠️  WARNING: This will overwrite current data!${NC}"
        read -p "Type 'yes' to continue: " confirm
        if [ "$confirm" != "yes" ]; then
            echo "Restore cancelled"
            exit 0
        fi
        if ! verify_backup_manifest; then
            print_err "Backup changed after rehearsal; refusing restore"
            exit 1
        fi


        BACKEND_WAS_RUNNING="$(docker compose ps --status running -q backend)"
        if [ -n "$BACKEND_WAS_RUNNING" ]; then
            print_step "Stopping backend before replacing the matched snapshot pair..."
            docker compose stop backend
            BACKEND_STOPPED=true
        fi

        print_step "Replacing PostgreSQL database..."
        docker compose exec -T postgres dropdb --if-exists --force -U mosaic mosaic
        docker compose exec -T postgres createdb -U mosaic -O mosaic mosaic
        docker compose exec -T postgres pg_restore --clean --if-exists --no-owner --no-privileges -U mosaic -d mosaic < "$BACKUP_DIR/database.dump"

        print_step "Replacing blob storage from the verified archive..."
        docker run --rm -v mosaic_blob_data:/data "$MOSAIC_UTILITY_IMAGE" \
            sh -ec 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
        docker run --rm -v mosaic_blob_data:/data -v "$BACKUP_DIR:/backup:ro" "$MOSAIC_UTILITY_IMAGE" \
            tar xzf /backup/blobs.tar.gz -C /data

        "$SCRIPT_DIR/verify-backup.sh" --verify-live

        RESTORE_COMPLETE=true
        if [ "$BACKEND_STOPPED" = true ]; then
            print_step "Starting backend after verified restore..."
            resume_backend_without_reconcile
            BACKEND_STOPPED=false
        fi

        print_done "Verified restore complete"
        ;;
        
    verify-backup)
        if [ "$#" -ne 1 ]; then
            print_err "Please specify exactly one backup directory"
            echo "Usage: ./mosaic.sh verify-backup backups/20240101T120000Z"
            exit 1
        fi
        exec "$SCRIPT_DIR/verify-backup.sh" "$1"
        ;;
        
    shell)
        SERVICE="${1:-backend}"
        print_title "Opening shell in $SERVICE..."
        docker compose exec "$SERVICE" sh
        ;;
        
    db)
        print_title "Connecting to PostgreSQL..."
        docker compose exec postgres psql -U mosaic mosaic
        ;;
        
    clean)
        print_title "Cleaning up Docker resources..."
        print_step "Removing stopped containers"
        docker compose down --remove-orphans
        print_step "Removing unused images"
        docker image prune -f
        print_done "Cleanup complete"
        ;;
        
    reset)
        echo ""
        echo -e "${RED}⚠️  WARNING: This will DELETE ALL DATA including:${NC}"
        echo -e "${RED}    - All photos and albums${NC}"
        echo -e "${RED}    - All user accounts${NC}"
        echo -e "${RED}    - Database contents${NC}"
        echo ""
        read -p "Type 'DELETE ALL DATA' to continue: " confirm
        if [ "$confirm" != "DELETE ALL DATA" ]; then
            echo "Reset cancelled"
            exit 0
        fi
        
        print_title "Resetting Mosaic..."
        print_step "Stopping containers"
        docker compose down -v
        print_step "Removing volumes"
        docker volume rm mosaic_postgres_data mosaic_blob_data 2>/dev/null || true
        print_done "Reset complete. Run './mosaic.sh start' to start fresh."
        ;;
        
    help|*)
        echo ""
        echo -e "${CYAN}Mosaic Docker Helper${NC}"
        echo -e "${CYAN}===================${NC}"
        echo ""
        echo -e "${WHITE}Usage: ./mosaic.sh <command> [args]${NC}"
        echo ""
        echo -e "${YELLOW}Commands:${NC}"
        echo "  start              Start all Mosaic services"
        echo "  stop               Stop all services"
        echo "  restart [service]  Restart all or specific service"
        echo "  status             Show container status and health"
        echo "  logs [service]     Follow logs (all or specific service)"
        echo ""
        echo "  build [options]    Build Docker images (passes to docker-build.sh)"
        echo "  pull               Pull latest images from registry"
        echo "  update             Create backup, pull, migrate, and recreate"
        echo ""
        echo "  backup             Create backup of database and blobs"
        echo "  restore <dir>      Restore from backup directory"
        echo "  verify-backup <dir> Restore a backup into isolation and verify active shard hashes"
        echo ""
        echo "  shell [service]    Open shell in container (default: backend)"
        echo "  db                 Connect to PostgreSQL CLI"
        echo ""
        echo "  clean              Remove stopped containers and unused images"
        echo "  reset              ⚠️  DELETE all data and start fresh"
        echo ""
        echo -e "${YELLOW}Examples:${NC}"
        echo "  ./mosaic.sh start"
        echo "  ./mosaic.sh logs backend"
        echo "  ./mosaic.sh backup"
        echo "  ./mosaic.sh shell postgres"
        echo ""
        ;;
esac
