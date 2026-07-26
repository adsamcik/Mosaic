# Mosaic Docker Deployment Guide

This guide covers how to build, deploy, and run Mosaic using Docker containers.

> **Preview status:** This checkout is not production-ready. This guide
> describes the candidate deployment contract, not proof of a released
> artifact. See [RELEASE_STATE.md](RELEASE_STATE.md).

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Building Images](#building-images)
- [Deployment Scenarios](#deployment-scenarios)
- [Configuration Reference](#configuration-reference)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Authentication Integration](#authentication-integration) ← See also [AUTHELIA.md](AUTHELIA.md)
- [Persistent Storage](#persistent-storage)
- [Monitoring & Logs](#monitoring--logs)
- [Troubleshooting](#troubleshooting)
- [Container Registry and Release Artifacts](#container-registry-and-release-artifacts)
- [Security Considerations](#security-considerations)

---

## Quick Start

The fastest way to get Mosaic running:

```bash
# 1. Clone the repository
git clone https://github.com/adsamcik/Mosaic.git
cd Mosaic

# 2. Configure environment
cp .env.example .env
# Edit .env and set strong POSTGRES_PASSWORD and AUTH_SERVER_SECRET values.

# 3. Start PostgreSQL and apply the schema explicitly
docker compose up -d postgres
docker compose run --rm backend --migrate-only

# 4. Build and start the serving containers
docker compose up -d

# 5. Check status
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
| `postgres` | Digest-pinned `postgres:17-alpine` | PostgreSQL database |

---

## Building Images

### Using Build Scripts

#### PowerShell (Windows)

```powershell
# Build all images
.\scripts\docker-build.ps1

# Build specific service
.\scripts\docker-build.ps1 -Service backend

# Build with an explicitly non-stable local tag
.\scripts\docker-build.ps1 -Tag dev-example

# Build and push an operator-owned preview image
.\scripts\docker-build.ps1 -Registry ghcr.io/your-org -Tag dev-example

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

# Build with an explicitly non-stable local tag
./scripts/docker-build.sh -t dev-example

# Build and push an operator-owned preview image
./scripts/docker-build.sh -r ghcr.io/your-org -t dev-example

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
| `-Tag`          | Local/preview tag (default `latest`; not a stable release claim) |
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
nano .env  # Set strong POSTGRES_PASSWORD and AUTH_SERVER_SECRET values

# Build, apply the schema once, then start serving
docker compose build
docker compose up -d postgres
docker compose run --rm backend --migrate-only
docker compose up -d --wait
```

**Important:** Put a reverse proxy in front for TLS termination. See [Reverse Proxy Setup](#reverse-proxy-setup).

### Scenario 3: Pre-built Images from Registry

If images are published to a container registry:

```yaml
# docker-compose.override.yml
services:
  backend:
    image: ghcr.io/your-org/mosaic-backend@sha256:<backend-digest-from-release>
    build: !reset null
    
  frontend:
    image: ghcr.io/your-org/mosaic-frontend@sha256:<frontend-digest-from-release>
    build: !reset null
```

```bash
docker compose pull
docker compose up -d postgres
docker compose run --rm backend --migrate-only
docker compose up -d --wait
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

### Compose environment overrides

The shipped `docker-compose.yml` consumes these operator overrides. Values not
listed here are fixed by the candidate deployment contract and should be
changed only in a reviewed Compose override.

| Variable | Purpose | Default |
|---|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL password; required | none |
| `AUTH_SERVER_SECRET` | Stable LocalAuth server secret; required | none |
| `FRONTEND_PORT` | Published frontend port | `8080` |
| `DEFAULT_QUOTA_BYTES` | Default per-user quota | `10737418240` (10 GiB) |
| `LOCAL_AUTH_ENABLED` | Enable LocalAuth | `true` |
| `PROXY_AUTH_ENABLED` | Enable trusted-header authentication | `false` |
| `POSTGRES_PIDS_LIMIT` | PostgreSQL PID ceiling | `256` |
| `POSTGRES_MEMORY_LIMIT` | PostgreSQL memory ceiling | `1g` |
| `POSTGRES_CPU_LIMIT` | PostgreSQL CPU ceiling | `2.0` |
| `BACKEND_PIDS_LIMIT` | Backend PID ceiling | `256` |
| `BACKEND_MEMORY_LIMIT` | Backend memory ceiling | `1g` |
| `BACKEND_CPU_LIMIT` | Backend CPU ceiling | `2.0` |
| `FRONTEND_PIDS_LIMIT` | Frontend PID ceiling | `128` |
| `FRONTEND_MEMORY_LIMIT` | Frontend memory ceiling | `256m` |
| `FRONTEND_CPU_LIMIT` | Frontend CPU ceiling | `1.0` |
| `LOG_MAX_SIZE` | Maximum json-file log segment | `10m` |
| `LOG_MAX_FILE` | Retained json-file segments per service | `3` |

`RUN_MIGRATIONS` is deliberately fixed to `false` for the serving backend.
Apply schema changes with `docker compose run --rm backend --migrate-only`
before starting a new candidate. ProxyAuth also remains off by default; when
it is enabled, configure only the exact proxy addresses and follow
[AUTHELIA.md](AUTHELIA.md).

### Runtime hardening

The production Compose file already applies the routine container controls; an
extra `deploy.resources` override is not required:

- PostgreSQL uses the digest-pinned multi-architecture
  `postgres:17-alpine` OCI index, `no-new-privileges`, and bounded CPU, memory,
  PIDs, and json-file log growth. Its database volume remains writable.
- Backend and frontend root filesystems are read-only, drop every Linux
  capability, set `no-new-privileges`, and enforce the limits listed above.
- Backend writes temporary files only to a `64m` `/tmp` tmpfs. Persistent
  writes are limited to the mounted blob and audit volumes.
- Frontend writable paths are bounded tmpfs mounts: `/tmp` (`16m`),
  `/var/cache/nginx` (`32m`), `/var/log/nginx` (`16m`), and `/var/run` (`4m`).

Raise a limit only after measuring the workload and document the override in
deployment change control. A read-only-root or limit failure is an operational
signal to investigate, not a reason to remove the control globally.

---

## Reverse Proxy Setup

Mosaic requires a reverse proxy for:
- TLS termination (HTTPS)
- Proper security headers

The shipped Compose stack uses LocalAuth and its frontend clears all
`Remote-*` identity headers. A TLS-only proxy must do the same.

### Caddy (Recommended)

Caddy automatically provisions TLS certificates:

```caddyfile
# Caddyfile
photos.example.com {
    route {
        request_header -Remote-*
        request_header -X-Auth-Request-*
        request_header -X-Forwarded-*
        request_header -Forwarded
        reverse_proxy localhost:8080
    }
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
        
        # LocalAuth/TLS-only mode: never translate a client-controlled header
        # into Mosaic identity.
        proxy_set_header Remote-User "";
        proxy_set_header Remote-Groups "";
        proxy_set_header Remote-Email "";
        proxy_set_header Remote-Name "";
        
        # Tus upload support
        proxy_request_buffering off;
        client_max_body_size 0;
    }
}
```

### ProxyAuth Candidate

ProxyAuth is not enabled safely by forwarding `X-Forwarded-User` or another
browser-supplied header. The current candidate path is the exact Caddy +
Authelia topology in [AUTHELIA.md](AUTHELIA.md). It:

1. publishes only Caddy on ports 80/443;
2. deletes spoofable identity headers before every public or protected route;
3. copies only Authelia's `Remote-User` result after successful auth;
4. restricts the frontend to Caddy's fixed `172.31.0.5` address;
5. restricts backend trust to the frontend's fixed `172.30.0.4/32` address; and
6. mounts `nginx.proxyauth-deployment.conf`, never the test-only
   `nginx.proxyauth.conf`.

This remains candidate-only until real ProxyAuth boundary evidence is approved
for the exact release commit.

**Backend Configuration:**

```yaml
# docker-compose.yml - backend environment
environment:
  Auth__LocalAuthEnabled: "false"      # Disable password auth
  Auth__ProxyAuthEnabled: "true"       # Enable header auth
  # Valid only with the exact app-network address in AUTHELIA.md.
  Auth__TrustedProxies__0: "172.30.0.4/32"
```

Do not broaden that `/32` to a private range. See [AUTHELIA.md](AUTHELIA.md)
for the complete candidate topology and its explicit stable-release blocker.

---

## Persistent Storage

Mosaic uses Docker volumes for persistent data:

| Volume         | Mount Point               | Purpose                    |
|----------------|---------------------------|----------------------------|
| `postgres_data`| `/var/lib/postgresql/data`| PostgreSQL database        |
| `blob_data`    | `/app/data/blobs`         | Encrypted photo shards     |
| `audit_data`   | `/app/data/audit`         | Persistent audit-log sink  |

### Paired Backup and Restore

Never dump PostgreSQL and copy the blob volume as independent operations. Use
the canonical helper, which stops a running backend during capture, hash-binds
the database and blob archives, and rehearses the pair in isolated resources:

```bash
./scripts/mosaic.sh backup
./scripts/mosaic.sh verify-backup backups/<timestamp>
./scripts/mosaic.sh restore backups/<timestamp>
```

```powershell
.\scripts\mosaic.ps1 backup
.\scripts\mosaic.ps1 verify-backup backups\<timestamp>
.\scripts\mosaic.ps1 restore backups\<timestamp>
```

Retain and copy the complete timestamped directory as one unit. Bash and
PowerShell both write the identical two-line `manifest.sha256` contract, so the
complete directory is portable between the canonical helpers. Restore refuses
a mixed or corrupt pair and verifies every active shard file against database
length and SHA-256 before reporting success. See
[BACKUP_DR_RUNBOOK.md](BACKUP_DR_RUNBOOK.md) and
[operations/BACKUP.md](operations/BACKUP.md) for retention and drill evidence.

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
- Backend: `GET /api/v1/health` → `200 OK`
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
  - Serving process runs with migrations disabled
  - Explicit one-shot `--migrate-only` schema boundary
  - Read-only root with persistent blob/audit mounts and bounded `/tmp`

---

## Container Registry and Release Artifacts

Local build helpers create operator-owned preview images. Use an explicitly
non-stable tag such as `dev-<commit>`; a local or manually pushed image is not a
Mosaic stable release.

Stable web/backend images are published only by `.github/workflows/publish.yml`
to:

- `ghcr.io/OWNER/mosaic-backend`
- `ghcr.io/OWNER/mosaic-frontend`

### Immutable stable publication contract

A tag push publishes only when all of these conditions pass:

1. The tagged tree sets `.github/release-readiness.json`
   `stable_publication_enabled` to `true` and contains all eight required
   `passed`, publicly downloadable, digest-verified, source-bound, unexpired
   external evidence records. It is currently `false`, so stable publication
   is blocked.
2. The ref is an annotated exact `vMAJOR.MINOR.PATCH` tag whose peeled commit
   is a non-merge child of the assessed source commit, changes only the
   readiness manifest, and is reachable from `main`.
3. The complete reusable release-assurance workflow succeeds for the tagged
   commit, including supported web/backend unit, integration, build, security,
   and E2E gates.
4. Backend and frontend candidates are built for `linux/amd64` and
   `linux/arm64`, pushed by digest, and receive registry SBOM/provenance plus
   retained SPDX SBOM artifacts and signed GitHub build provenance.
5. A clean consumer pulls the exact digests, verifies labels, attestations,
   registry evidence, and container health, then completes registration, album
   creation, upload, reload-persistence, and logout against those images.
6. The workflow creates or confirms one immutable exact-version tag and a
   GitHub Release that records both image digests and retains the verified
   external-evidence bundle plus its SHA-256.

The workflow does not create `latest`, moving major/minor tags, or a manual
stable channel. A manual dispatch can build signed Android developer-preview
artifacts only; those artifacts are never attached to a stable release.

### Verify and consume a published release

Copy both digests from the GitHub Release, then verify the immutable subjects:

```bash
gh attestation verify oci://ghcr.io/OWNER/mosaic-backend@sha256:<backend-digest> --repo OWNER/Mosaic
gh attestation verify oci://ghcr.io/OWNER/mosaic-frontend@sha256:<frontend-digest> --repo OWNER/Mosaic

docker buildx imagetools inspect ghcr.io/OWNER/mosaic-backend@sha256:<backend-digest>
docker buildx imagetools inspect ghcr.io/OWNER/mosaic-frontend@sha256:<frontend-digest>
```

Use the same digest references in a Compose override:

```yaml
services:
  backend:
    image: ghcr.io/OWNER/mosaic-backend@sha256:<backend-digest>
    build: !reset null
  frontend:
    image: ghcr.io/OWNER/mosaic-frontend@sha256:<frontend-digest>
    build: !reset null
```

With the digest override saved in a Compose file loaded by `docker compose`,
apply the candidate through the canonical update helper:

```bash
./scripts/mosaic.sh update
```

```powershell
.\scripts\mosaic.ps1 update
```

The helper rehearses a matched backup before pulling, quiesces the backend,
runs the one-shot migration, and requires healthy recreation. A failure after
quiesce leaves frontend and backend stopped rather than serving a partial
upgrade.

If the tag, GitHub Release, digest pair, attestation, or clean-consumer run is
missing, treat the image as an unsupported preview. See
[RELEASE_STATE.md](RELEASE_STATE.md) and [RELEASE.md](RELEASE.md) for the full
evidence and operator release checklist.

## Security Considerations

1. **Change default passwords**: Set a strong `POSTGRES_PASSWORD` in production
2. **Non-root containers**: Both frontend and backend run as non-root users
3. **Network isolation**: Services communicate on an internal Docker network
4. **TLS termination**: Always use a reverse proxy with TLS in production
5. **Authentication**: LocalAuth is the default; ProxyAuth requires the candidate boundary in [AUTHELIA.md](AUTHELIA.md)
6. **Trusted proxies**: Use only the exact immediate frontend `/32`, never a whole private range
