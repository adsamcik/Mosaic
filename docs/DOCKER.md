# Mosaic Docker Deployment Guide

This guide covers how to build, deploy, and run Mosaic using Docker containers.

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Building Images](#building-images)
- [Deployment Scenarios](#deployment-scenarios)
- [Configuration Reference](#configuration-reference)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Persistent Storage](#persistent-storage)
- [Monitoring & Logs](#monitoring--logs)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

The fastest way to get Mosaic running:

```bash
# 1. Clone the repository
git clone https://github.com/your-org/mosaic.git
cd mosaic

# 2. Configure environment
cp .env.example .env
# Edit .env and set a strong POSTGRES_PASSWORD

# 3. Build and start
docker compose up -d

# 4. Check status
docker compose ps
docker compose logs -f
```

The application will be available at `http://localhost:8080`.

---

## Architecture Overview

Mosaic consists of three Docker containers:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Machine                              │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     Docker Network                          │ │
│  │                                                             │ │
│  │   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐  │ │
│  │   │  Frontend   │────▶│   Backend   │────▶│  PostgreSQL │  │ │
│  │   │   (nginx)   │     │   (.NET)    │     │   Database  │  │ │
│  │   │   :8080     │     │   :8080     │     │   :5432     │  │ │
│  │   └─────────────┘     └─────────────┘     └─────────────┘  │ │
│  │         │                    │                    │         │ │
│  └─────────┼────────────────────┼────────────────────┼─────────┘ │
│            │                    │                    │           │
│      ┌─────┴─────┐        ┌─────┴─────┐        ┌─────┴─────┐    │
│      │  Port     │        │   Blob    │        │  Database │    │
│      │  8080     │        │  Volume   │        │  Volume   │    │
│      └───────────┘        └───────────┘        └───────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

| Service    | Image            | Purpose                           |
|------------|------------------|-----------------------------------|
| `frontend` | `mosaic-frontend`| React SPA served by nginx         |
| `backend`  | `mosaic-backend` | .NET API for storage and metadata |
| `postgres` | `postgres:17`    | PostgreSQL database               |

---

## Building Images

### Using Build Scripts

#### PowerShell (Windows)

```powershell
# Build all images
.\scripts\docker-build.ps1

# Build specific service
.\scripts\docker-build.ps1 -Service backend

# Build with custom tag
.\scripts\docker-build.ps1 -Tag v1.0.0

# Build and push to registry
.\scripts\docker-build.ps1 -Registry ghcr.io/your-org -Tag v1.0.0

# Build without cache
.\scripts\docker-build.ps1 -NoCache

# Multi-architecture build (amd64 + arm64)
.\scripts\docker-build.ps1 -Platform "linux/amd64,linux/arm64" -Registry ghcr.io/your-org
```

#### Bash (Linux/macOS)

```bash
# Build all images
./scripts/docker-build.sh

# Build specific service
./scripts/docker-build.sh -s backend

# Build with custom tag
./scripts/docker-build.sh -t v1.0.0

# Build and push to registry
./scripts/docker-build.sh -r ghcr.io/your-org -t v1.0.0

# Build without cache
./scripts/docker-build.sh --no-cache

# Multi-architecture build
./scripts/docker-build.sh -p "linux/amd64,linux/arm64" -r ghcr.io/your-org
```

### Using Docker Compose Directly

```bash
# Build all services
docker compose build

# Build in parallel (faster)
docker compose build --parallel

# Build without cache
docker compose build --no-cache

# Build specific service
docker compose build backend
```

### Build Script Options

| Option          | Description                                   |
|-----------------|-----------------------------------------------|
| `-Service`      | Build `backend`, `frontend`, or `all`         |
| `-Tag`          | Docker image tag (default: `latest`)          |
| `-Registry`     | Container registry URL                        |
| `-NoPush`       | Tag but don't push to registry               |
| `-NoCache`      | Build without Docker layer cache             |
| `-Platform`     | Multi-arch platforms (e.g., `linux/amd64`)   |
| `-Dev`          | Use development compose file                 |
| `-Test`         | Use test compose file                        |

---

## Deployment Scenarios

### Scenario 1: Local Development

Use the development compose file for a PostgreSQL database while running the app locally:

```bash
# Start only PostgreSQL
docker compose -f docker-compose.dev.yml up -d

# Start with pgAdmin (database management UI)
docker compose -f docker-compose.dev.yml --profile tools up -d
```

Database connection string for local development:
```
Host=localhost;Database=mosaic;Username=mosaic;Password=dev
```

pgAdmin is available at `http://localhost:5050` (credentials: `admin@mosaic.local` / `admin`).

### Scenario 2: Single Server Production

For a single server deployment with all services:

```bash
# Configure environment
cp .env.example .env
nano .env  # Set strong POSTGRES_PASSWORD

# Build and start
docker compose up -d --build
```

**Important:** Put a reverse proxy in front for TLS termination. See [Reverse Proxy Setup](#reverse-proxy-setup).

### Scenario 3: Pre-built Images from Registry

If images are published to a container registry:

```yaml
# docker-compose.override.yml
services:
  backend:
    image: ghcr.io/your-org/mosaic-backend:v1.0.0
    build: !reset null
    
  frontend:
    image: ghcr.io/your-org/mosaic-frontend:v1.0.0
    build: !reset null
```

```bash
docker compose pull
docker compose up -d
```

### Scenario 4: Running Tests

```bash
# Run integration tests
docker compose -f docker-compose.test.yml --profile api-tests up --build --abort-on-container-exit

# Run E2E tests
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Configuration Reference

### Environment Variables

Configure via `.env` file or environment:

| Variable               | Description                          | Default              |
|------------------------|--------------------------------------|----------------------|
| `POSTGRES_PASSWORD`    | PostgreSQL password (required)       | `changeme`           |
| `FRONTEND_PORT`        | Host port for frontend               | `8080`               |
| `DEFAULT_QUOTA_BYTES`  | Default storage quota per user       | `10737418240` (10GB) |
| `DOMAIN`               | Domain name for production           | -                    |
| `ACME_EMAIL`           | Email for Let's Encrypt certificates | -                    |

### Backend Environment

Set in `docker-compose.yml` or via environment:

| Variable                       | Description                         |
|--------------------------------|-------------------------------------|
| `ASPNETCORE_ENVIRONMENT`       | Runtime environment                 |
| `ConnectionStrings__Default`   | PostgreSQL connection string        |
| `Storage__Path`                | Path for blob storage               |
| `Auth__TrustedProxies__0`      | Trusted proxy CIDR for auth headers |
| `Quota__DefaultMaxBytes`       | Default storage quota               |

### Resource Limits

Add resource limits for production:

```yaml
# docker-compose.override.yml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
          
  postgres:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
```

---

## Reverse Proxy Setup

Mosaic requires a reverse proxy for:
- TLS termination (HTTPS)
- Authentication header forwarding (`Remote-User`)
- Proper security headers

### Caddy (Recommended)

Caddy automatically provisions TLS certificates:

```caddyfile
# Caddyfile
photos.example.com {
    reverse_proxy localhost:8080
    
    # Forward authentication header from your auth provider
    # (e.g., Authelia, Authentik, oauth2-proxy)
    header_up Remote-User {http.request.header.X-Forwarded-User}
}
```

### Traefik

```yaml
# docker-compose.override.yml
services:
  frontend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mosaic.rule=Host(`photos.example.com`)"
      - "traefik.http.routers.mosaic.entrypoints=websecure"
      - "traefik.http.routers.mosaic.tls.certresolver=letsencrypt"
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name photos.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Forward auth header
        proxy_set_header Remote-User $http_x_forwarded_user;
        
        # Tus upload support
        proxy_request_buffering off;
        client_max_body_size 0;
    }
}
```

### Authentication Integration

Mosaic uses the `Remote-User` header for authentication, which should be set by an external authentication provider:

- **Authelia**: Configure `auth_header` in Authelia's nginx config
- **Authentik**: Use the nginx outpost with forward auth
- **oauth2-proxy**: Set `--pass-user-headers=true`

---

## Persistent Storage

Mosaic uses Docker volumes for persistent data:

| Volume         | Mount Point               | Purpose                    |
|----------------|---------------------------|----------------------------|
| `postgres_data`| `/var/lib/postgresql/data`| PostgreSQL database        |
| `blob_data`    | `/app/data/blobs`         | Encrypted photo shards     |

### Backup Strategy

```bash
# Backup PostgreSQL
docker compose exec postgres pg_dump -U mosaic mosaic > backup.sql

# Backup blob storage
docker run --rm -v mosaic_blob_data:/data -v $(pwd):/backup alpine \
    tar czf /backup/blobs-$(date +%Y%m%d).tar.gz -C /data .

# Restore PostgreSQL
docker compose exec -T postgres psql -U mosaic mosaic < backup.sql

# Restore blob storage
docker run --rm -v mosaic_blob_data:/data -v $(pwd):/backup alpine \
    tar xzf /backup/blobs-20240101.tar.gz -C /data
```

### External Storage

For NFS or other network storage:

```yaml
volumes:
  blob_data:
    driver: local
    driver_opts:
      type: nfs
      o: addr=nas.local,rw
      device: ":/volume1/mosaic/blobs"
```

---

## Monitoring & Logs

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend

# Last 100 lines
docker compose logs --tail 100 backend
```

### Health Checks

All services include health checks:

```bash
# Check container health
docker compose ps

# Detailed health info
docker inspect --format='{{json .State.Health}}' mosaic-backend | jq
```

Health endpoints:
- Frontend: `GET /health` → `200 OK`
- Backend: `GET /api/health` → `200 OK`
- PostgreSQL: `pg_isready` command

### Metrics (Optional)

Add Prometheus monitoring:

```yaml
# docker-compose.override.yml
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    profiles:
      - monitoring
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs for errors
docker compose logs backend

# Check container status
docker compose ps -a

# Inspect container
docker inspect mosaic-backend
```

### Database Connection Issues

```bash
# Verify PostgreSQL is healthy
docker compose exec postgres pg_isready -U mosaic

# Check connection from backend
docker compose exec backend curl -v http://postgres:5432
```

### Build Failures

```bash
# Clean build cache
docker builder prune

# Build with verbose output
docker compose build --progress=plain

# Build without cache
docker compose build --no-cache
```

### Permission Issues

```bash
# Check volume permissions
docker compose exec backend ls -la /app/data/blobs

# Fix permissions
docker compose exec -u root backend chown -R mosaic:mosaic /app/data
```

### Network Issues

```bash
# List networks
docker network ls

# Inspect network
docker network inspect mosaic_mosaic-internal

# Check DNS resolution
docker compose exec backend nslookup postgres
```

### Disk Space

```bash
# Check Docker disk usage
docker system df

# Clean unused resources
docker system prune -a

# Clean volumes (WARNING: removes data!)
docker volume prune
```

---

## Image Details

### mosaic-frontend

- **Base image:** `nginx:alpine`
- **Exposed port:** 8080
- **User:** `mosaic` (non-root)
- **Notable features:**
  - Pre-configured CORS headers for SharedArrayBuffer
  - API proxying to backend
  - Gzip compression
  - Static asset caching (1 year)
  - SPA routing fallback

### mosaic-backend

- **Base image:** `mcr.microsoft.com/dotnet/aspnet:10.0`
- **Exposed port:** 8080
- **User:** `mosaic` (non-root)
- **Notable features:**
  - Tus resumable upload support
  - Health check endpoint
  - Database migration on startup

---

## Container Registry

### GitHub Container Registry

```bash
# Login
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Build and push
./scripts/docker-build.sh -r ghcr.io/your-org -t v1.0.0
```

### Docker Hub

```bash
# Login
docker login

# Build and push
./scripts/docker-build.sh -r your-username -t v1.0.0
```

### Self-hosted Registry

```bash
./scripts/docker-build.sh -r registry.example.com:5000 -t v1.0.0
```

---

## Security Considerations

1. **Change default passwords**: Set a strong `POSTGRES_PASSWORD` in production
2. **Non-root containers**: Both frontend and backend run as non-root users
3. **Network isolation**: Services communicate on an internal Docker network
4. **TLS termination**: Always use a reverse proxy with TLS in production
5. **Authentication**: Configure your reverse proxy to set the `Remote-User` header
6. **Trusted proxies**: Backend only accepts auth headers from configured CIDR ranges
