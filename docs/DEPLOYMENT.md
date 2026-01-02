# Mosaic Deployment Guide

A beginner-friendly guide to deploying Mosaic, a zero-knowledge encrypted photo gallery.

> **Looking for advanced configuration?** See [DOCKER.md](DOCKER.md) for the complete reference.

---

## Prerequisites

Before you start, you'll need:

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Docker | 20.10+ | `docker --version` |
| Docker Compose | 2.0+ | `docker compose version` |
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

**Important:** Open `.env` and change the `POSTGRES_PASSWORD`:

```bash
# Generate a secure password
openssl rand -base64 32
# Copy the output and paste it as POSTGRES_PASSWORD in .env
```

Your `.env` should look like:
```ini
POSTGRES_PASSWORD=your-secure-generated-password-here
FRONTEND_PORT=8080
```

### Step 3: Start Mosaic

```bash
docker compose up -d
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

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose down
docker compose up -d --build
```

---

## Windows PowerShell Helper

Windows users can use the helper script for easier management:

```powershell
# Start Mosaic
.\scripts\mosaic.ps1 start

# Check status
.\scripts\mosaic.ps1 status

# View logs
.\scripts\mosaic.ps1 logs

# Stop Mosaic
.\scripts\mosaic.ps1 stop

# Create backup
.\scripts\mosaic.ps1 backup
```

---

## Backup & Restore

### Create a Backup

```bash
# Backup database
docker compose exec postgres pg_dump -U mosaic mosaic > backup-$(date +%Y%m%d).sql

# Backup photos (blob storage)
docker run --rm -v mosaic_blob_data:/data -v $(pwd):/backup alpine \
    tar czf /backup/photos-$(date +%Y%m%d).tar.gz -C /data .
```

### Restore from Backup

```bash
# Restore database
docker compose exec -T postgres psql -U mosaic mosaic < backup-20260102.sql

# Restore photos
docker run --rm -v mosaic_blob_data:/data -v $(pwd):/backup alpine \
    tar xzf /backup/photos-20260102.tar.gz -C /data
```

---

## Production Deployment

For production use, you should:

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

Mosaic uses the `Remote-User` header for authentication. Your reverse proxy should set this header based on your authentication provider.

**Common authentication solutions:**
- [Authelia](https://www.authelia.com/) - Self-hosted SSO
- [Authentik](https://goauthentik.io/) - Open-source identity provider
- [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) - OAuth2 authentication proxy

Example Caddy configuration with Authelia:

```caddyfile
photos.yourdomain.com {
    forward_auth localhost:9091 {
        uri /api/verify?rd=https://auth.yourdomain.com
        copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy localhost:8080
}
```

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
