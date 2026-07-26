# Mosaic Deployment Guide

A beginner-friendly guide to deploying Mosaic, a zero-knowledge encrypted photo gallery.

> **Preview status:** This checkout is not production-ready. This guide
> describes the candidate deployment contract, not proof of a released
> artifact. See [RELEASE_STATE.md](RELEASE_STATE.md).
>
> **Looking for advanced configuration?** See [DOCKER.md](DOCKER.md) for the complete reference.

---

## Prerequisites

Before you start, you'll need:

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Docker | 20.10+ | `docker --version` |
| Docker Compose plugin | Current; must support `--wait` and `!reset` | `docker compose version` |
| Git | Any | `git --version` |

**Don't have Docker?**
- **Windows/Mac:** Download [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux:** Follow the [official installation guide](https://docs.docker.com/engine/install/)

---

## Quick Start (5 Minutes)

### Step 1: Clone the Repository

```bash
git clone https://github.com/adsamcik/Mosaic.git
cd Mosaic
```

### Step 2: Configure Environment

```bash
# Copy the example configuration
cp .env.example .env
```

**Important:** Open `.env` and set both `AUTH_SERVER_SECRET` and `POSTGRES_PASSWORD`:

```bash
# Generate a stable auth server secret
openssl rand -base64 32
# Copy the output and paste it as AUTH_SERVER_SECRET in .env

# Generate a secure database password
openssl rand -base64 32
# Copy the output and paste it as POSTGRES_PASSWORD in .env
```

#### Auth server secret

`AUTH_SERVER_SECRET` is required for production Docker Compose deployments. It is used during LocalAuth initialization to derive deterministic fake-salt values for unknown usernames, which prevents user enumeration via timing or salt-stability differences.

Generate it once with `openssl rand -base64 32`, store it in `.env`, and keep it stable for the lifetime of the deployment. Changing it after users have registered will change auth init responses for existing accounts and may break password-manager stored derivations. Rotate it only as part of a coordinated password-rotation event.

Your `.env` should look like:
```ini
AUTH_SERVER_SECRET=your-stable-generated-auth-secret-here
POSTGRES_PASSWORD=your-secure-generated-password-here
FRONTEND_PORT=8080
```

### Step 3: Start Mosaic

```bash
# Start the database, apply the schema as an explicit one-shot operation,
# then start the serving containers.
docker compose up -d postgres
docker compose run --rm backend --migrate-only
docker compose up -d --wait
```

Wait about 30 seconds for all services to start.

### Step 4: Verify It's Running

```bash
docker compose ps
```

You should see three healthy containers:
```
NAME              STATUS              PORTS
mosaic-frontend   Up (healthy)        0.0.0.0:8080->8080/tcp
mosaic-backend    Up (healthy)
mosaic-postgres   Up (healthy)
```

### Step 5: Access the Application

Open your browser and go to:

**http://localhost:8080**

🎉 **Congratulations!** Mosaic is now running.

---

## Common Operations

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

### Stop Mosaic

```bash
docker compose down
```

### Restart Mosaic

```bash
docker compose restart
```

### Update to Latest Version

Use the canonical helper for a published-image upgrade:

```bash
./scripts/mosaic.sh update
```

```powershell
.\scripts\mosaic.ps1 update
```

The helper first creates and rehearses a matched database/blob backup, then
pulls candidate images, acquires the maintenance lock, stops the serving
backend, applies the schema once through `--migrate-only`, and recreates all
services with health checks. If migration or recreation fails after quiesce,
frontend and backend remain stopped; restore the matched pre-upgrade backup
before rolling back application images.

---

## Windows PowerShell Helper

Windows users can use the helper script for the same management contract.
`start` never applies migrations; use `update` for upgrades so backup rehearsal,
one-shot migration, health checks, and fail-closed recovery cannot be skipped.

```powershell
# Start Mosaic
.\scripts\mosaic.ps1 start

# Check status
.\scripts\mosaic.ps1 status

# Safely update published images and schema
.\scripts\mosaic.ps1 update

# View logs
.\scripts\mosaic.ps1 logs

# Stop Mosaic
.\scripts\mosaic.ps1 stop

# Create backup
.\scripts\mosaic.ps1 backup
```

---

## Backup & Restore

Database and blob data must always be captured and restored as one quiesced,
hash-bound pair. The repository helpers stop the backend for the capture,
serialize backup/restore operations with an exclusive lock, verify both
hashes, and reconcile active shard rows against blob size and digest before
declaring a restore successful. Each timestamped directory contains the
same canonical `manifest.sha256` format on Bash and PowerShell, so a complete
backup directory can be verified or restored with either helper.

### Linux/macOS

```bash
./scripts/mosaic.sh backup
./scripts/mosaic.sh verify-backup ./backups/<backup-directory>
./scripts/mosaic.sh restore ./backups/<backup-directory>
```

### Windows PowerShell

```powershell
.\scripts\mosaic.ps1 backup
.\scripts\mosaic.ps1 verify-backup .\backups\<backup-directory>
.\scripts\mosaic.ps1 restore .\backups\<backup-directory>
```

See [operations/BACKUP.md](operations/BACKUP.md) for scheduling, off-host
retention, restore drills, and the known-client decryption smoke corpus.

---

## Shipped Compose Hardening

The supplied production Compose contract pins the PostgreSQL 17 Alpine image
by digest. Backend and frontend use read-only root filesystems, drop all Linux
capabilities, set `no-new-privileges`, and receive only bounded tmpfs writable
paths. PostgreSQL, backend, and frontend also have default PID, memory, CPU,
and json-file log-growth limits.

Capacity-tested deployments can override only the documented knobs:
`POSTGRES_PIDS_LIMIT`, `POSTGRES_MEMORY_LIMIT`, `POSTGRES_CPU_LIMIT`,
`BACKEND_PIDS_LIMIT`, `BACKEND_MEMORY_LIMIT`, `BACKEND_CPU_LIMIT`,
`FRONTEND_PIDS_LIMIT`, `FRONTEND_MEMORY_LIMIT`, `FRONTEND_CPU_LIMIT`,
`LOG_MAX_SIZE`, and `LOG_MAX_FILE`. Preserve the read-only roots, capability
drops, and tmpfs boundaries. See
[DOCKER.md](DOCKER.md#runtime-hardening) for defaults and exact writable paths.

The serving backend keeps `RUN_MIGRATIONS=false`; do not enable runtime
migration as a convenience override.

---

## Production Deployment

For a production-candidate deployment, you should:

### 1. Use Strong Passwords

Generate a secure password for the database:

```bash
openssl rand -base64 32
```

### 2. Set Up HTTPS with a Reverse Proxy

Mosaic should run behind a reverse proxy that handles TLS. Here's a simple setup with **Caddy** (recommended - it handles certificates automatically):

```bash
# Install Caddy (Ubuntu/Debian)
sudo apt install -y caddy
```

Create `/etc/caddy/Caddyfile`:

```caddyfile
photos.yourdomain.com {
    reverse_proxy localhost:8080
}
```

```bash
# Start Caddy
sudo systemctl enable caddy
sudo systemctl start caddy
```

Caddy will automatically obtain and renew TLS certificates from Let's Encrypt.

### 3. Configure Authentication

The default `docker-compose.yml` configuration uses local username/password authentication (`LOCAL_AUTH_ENABLED=true`, `PROXY_AUTH_ENABLED=false`) so first deploys work without an external identity proxy.

ProxyAuth is candidate-only. Do not enable it by copying a client-controlled
identity header into `Remote-User`; an authenticated upstream must delete
spoofable identity first and overwrite `Remote-User` itself.

**Common authentication solutions:**

| Provider | Description |
|----------|-------------|
| [Authelia](https://www.authelia.com/) | Self-hosted SSO (recommended) |
| [Authentik](https://goauthentik.io/) | Open-source identity provider |
| [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) | OAuth2 authentication proxy |

The only documented candidate is the split-network Caddy + Authelia topology
in [AUTHELIA.md](AUTHELIA.md). Only Caddy publishes ports; it has a fixed edge
address, deletes client identity headers on public and protected routes, and
copies only Authelia's `Remote-User`. The frontend accepts only that exact
Caddy peer and mounts `nginx.proxyauth-deployment.conf`, never the test-only
`nginx.proxyauth.conf`.

**Backend Configuration:**

Update your `docker-compose.yml` to enable proxy authentication:

```yaml
backend:
  environment:
    Auth__LocalAuthEnabled: "false"      # Disable password auth
    Auth__ProxyAuthEnabled: "true"       # Enable header-based auth
    # Valid only with the exact candidate app-network topology.
    Auth__TrustedProxies__0: "172.30.0.4/32"
```

Never broaden that `/32` to a Docker/private range. See
[AUTHELIA.md](AUTHELIA.md) for the complete candidate and
[RELEASE_STATE.md](RELEASE_STATE.md) for the still-missing real ProxyAuth
boundary evidence. nginx and Traefik fragments are reference-only until they
meet the same exact-peer/header-deletion contract and receive their own
evidence.

---

## Troubleshooting

### Containers Won't Start

```bash
# Check for errors
docker compose logs

# Verify Docker is running
docker info

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Database Connection Errors

```bash
# Check if PostgreSQL is healthy
docker compose exec postgres pg_isready -U mosaic

# View PostgreSQL logs
docker compose logs postgres
```

### "Port already in use" Error

Change the port in `.env`:

```ini
FRONTEND_PORT=8081
```

Then restart:

```bash
docker compose down
docker compose up -d
```

### Permission Denied Errors

```bash
# Fix blob storage permissions
docker compose exec -u root backend chown -R mosaic:mosaic /app/data
```

### Out of Disk Space

```bash
# Check disk usage
docker system df

# Clean up unused Docker resources
docker system prune -a
```

### HTTP 400 "Bad Request" / "BadHost" After Putting Mosaic Behind a Custom Domain

`appsettings.Production.json` ships with `AllowedHosts=localhost` so the default
docker compose stack works out of the box (browser → `localhost:8080` → nginx →
backend). The frontend nginx forwards the inbound `Host` header verbatim, so as
soon as you put Mosaic behind a reverse proxy that terminates a different
hostname (Caddy, Traefik, Authelia, an outer nginx), every backend API call is
rejected with HTTP 400 BadHost until you override `AllowedHosts`.

Fix by setting `AllowedHosts` to the hostname(s) you actually serve from in
`.env`:

```ini
AllowedHosts=photos.example.com
# or, for multiple hosts (semicolon-separated):
# AllowedHosts=photos.example.com;photos.internal
```

Then forward it into the backend by adding to the `backend.environment` block
in your compose override:

```yaml
environment:
  AllowedHosts: "${AllowedHosts:-localhost}"
```

Restart the backend (`docker compose up -d backend`) and the 400s clear.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────┐
│                  Your Browser                       │
│  (All encryption/decryption happens here)          │
└──────────────────────┬─────────────────────────────┘
                       │ HTTPS (via reverse proxy)
                       ▼
┌────────────────────────────────────────────────────┐
│              Docker Containers                      │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │  Frontend   │─▶│   Backend   │─▶│ PostgreSQL │ │
│  │   (nginx)   │  │   (.NET)    │  │  Database  │ │
│  │  Port 8080  │  │  Internal   │  │  Internal  │ │
│  └─────────────┘  └─────────────┘  └────────────┘ │
│                          │                         │
│                   ┌──────┴───────┐                │
│                   │ Blob Storage │                │
│                   │   (Volume)   │                │
│                   └──────────────┘                │
└────────────────────────────────────────────────────┘
```

**Key points:**
- The **frontend** serves the React app and proxies API requests to the backend
- The **backend** stores encrypted blobs and metadata (never sees plaintext)
- **PostgreSQL** stores user accounts and album metadata
- **Blob storage** holds encrypted photo shards
- All containers run as **non-root users** for security

---

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password | `changeme` (change this!) |
| `FRONTEND_PORT` | Port to access Mosaic | `8080` |
| `DEFAULT_QUOTA_BYTES` | Storage quota per user | `10737418240` (10 GB) |
| `AllowedHosts` | Semicolon-separated host allow-list for the backend. Override when serving behind a custom domain or you will see HTTP 400 BadHost on every API call. | `localhost` |

For advanced configuration, see [DOCKER.md](DOCKER.md#configuration-reference).

---

## Getting Help

- **Documentation:** [docs/DOCKER.md](DOCKER.md) - Full Docker reference
- **Issues:** [GitHub Issues](https://github.com/adsamcik/Mosaic/issues)
- **Security:** See [SECURITY.md](SECURITY.md) for security-related information

---

## Next Steps

After deployment, you might want to:

1. **Set up regular backups** - Schedule automated backups of your database and photos
2. **Configure monitoring** - Add Prometheus/Grafana for observability
3. **Set up authentication** - Integrate with your identity provider
4. **Configure storage quotas** - Adjust `DEFAULT_QUOTA_BYTES` based on your needs

See [DOCKER.md](DOCKER.md) for detailed instructions on all of these topics.
