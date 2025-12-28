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
#   update             Pull and recreate containers
#
#   backup             Create backup of database and blobs
#   restore <dir>      Restore from backup directory
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

print_title() { echo -e "\n${CYAN}$1${NC}"; }
print_step() { echo -e "  ${YELLOW}▶ $1${NC}"; }
print_done() { echo -e "  ${GREEN}✅ $1${NC}"; }
print_err() { echo -e "  ${RED}❌ $1${NC}"; }

COMMAND="${1:-help}"
shift || true

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
        print_step "Pulling latest images"
        docker compose pull
        print_step "Recreating containers"
        docker compose up -d --remove-orphans
        print_done "Update complete"
        ;;
        
    backup)
        print_title "Creating Mosaic Backup"
        TIMESTAMP=$(date +%Y%m%d-%H%M%S)
        BACKUP_DIR="backups/$TIMESTAMP"
        
        mkdir -p "$BACKUP_DIR"
        
        print_step "Backing up PostgreSQL database..."
        docker compose exec -T postgres pg_dump -U mosaic mosaic > "$BACKUP_DIR/database.sql"
        
        print_step "Backing up blob storage..."
        docker run --rm -v mosaic_blob_data:/data -v "$(pwd)/$BACKUP_DIR:/backup" alpine \
            tar czf /backup/blobs.tar.gz -C /data .
        
        print_done "Backup saved to $BACKUP_DIR"
        echo ""
        echo -e "${WHITE}Files:${NC}"
        ls -lh "$BACKUP_DIR" | awk 'NR>1 {print "  " $9 ": " $5}'
        ;;
        
    restore)
        if [ -z "$1" ]; then
            print_err "Please specify backup directory"
            echo "Usage: ./mosaic.sh restore backups/20240101-120000"
            exit 1
        fi
        
        BACKUP_DIR="$1"
        if [ ! -d "$BACKUP_DIR" ]; then
            print_err "Backup directory not found: $BACKUP_DIR"
            exit 1
        fi
        
        print_title "Restoring Mosaic from $BACKUP_DIR"
        echo ""
        echo -e "${RED}⚠️  WARNING: This will overwrite current data!${NC}"
        read -p "Type 'yes' to continue: " confirm
        if [ "$confirm" != "yes" ]; then
            echo "Restore cancelled"
            exit 0
        fi
        
        print_step "Restoring PostgreSQL database..."
        docker compose exec -T postgres psql -U mosaic mosaic < "$BACKUP_DIR/database.sql"
        
        if [ -f "$BACKUP_DIR/blobs.tar.gz" ]; then
            print_step "Restoring blob storage..."
            docker run --rm -v mosaic_blob_data:/data -v "$(pwd)/$BACKUP_DIR:/backup" alpine \
                tar xzf /backup/blobs.tar.gz -C /data
        fi
        
        print_done "Restore complete"
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
        echo "  update             Pull and recreate containers"
        echo ""
        echo "  backup             Create backup of database and blobs"
        echo "  restore <dir>      Restore from backup directory"
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
