# Authelia Integration Guide

This guide explains how to integrate Mosaic with [Authelia](https://www.authelia.com/) for Single Sign-On (SSO) authentication.

## Overview

Mosaic uses the `Remote-User` header for authentication. Authelia acts as an authentication proxy that:

1. Intercepts requests to Mosaic
2. Redirects unauthenticated users to the Authelia login portal
3. Sets the `Remote-User` header with the authenticated username
4. Forwards authenticated requests to Mosaic

```
┌──────────┐     ┌───────────┐     ┌───────────┐     ┌─────────┐
│  Browser │────▶│   Caddy/  │────▶│  Authelia │────▶│ Mosaic  │
│          │◀────│   nginx   │◀────│  (auth)   │◀────│ (app)   │
└──────────┘     └───────────┘     └───────────┘     └─────────┘
                       │                 │
                       │  Remote-User    │
                       │◀────────────────┘
```

### Share Links (Anonymous Access)

Mosaic supports share links that allow anonymous access to specific albums without authentication. These links use the `/s/` path prefix:

- **Frontend**: `/s/{linkId}` - Renders the shared album viewer
- **API**: `/api/s/{linkId}/*` - Backend endpoints for share link data

**The following paths must bypass Authelia authentication** so that anyone with a valid share link can view the shared content:

| Path | Purpose |
|------|---------|
| `/s/*` | Share link frontend routes |
| `/api/s/*` | Share link API endpoints |
| `/assets/*` | JavaScript, CSS bundles (Vite output) |
| `/*.js`, `/*.css`, `/*.wasm` | Root-level static files |
| `/index.html` | SPA entry point |

All configuration examples in this guide include the proper bypass rules.

```
Share Link URL: https://photos.example.com/s/{linkId}#k={secret}
                                           └──────────────────────┘
                                           This path bypasses SSO
```

---

## Prerequisites

- Mosaic deployed via Docker (see [DEPLOYMENT.md](DEPLOYMENT.md))
- A domain name with DNS configured
- Basic familiarity with Docker Compose

---

## Option 1: Caddy + Authelia (Recommended)

Caddy is the recommended reverse proxy because it automatically handles TLS certificates.

### Directory Structure

```
mosaic-stack/
├── docker-compose.yml
├── .env
├── authelia/
│   ├── configuration.yml
│   └── users_database.yml
└── Caddyfile
```

### Step 1: Create docker-compose.yml

```yaml
# docker-compose.yml
services:
  # ===================
  # Mosaic Application
  # ===================
  postgres:
    image: postgres:17-alpine
    container_name: mosaic-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: mosaic
      POSTGRES_USER: mosaic
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mosaic -d mosaic"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/adsamcik/mosaic-backend:latest
    # Or build from source:
    # build:
    #   context: ./Mosaic/apps/backend/Mosaic.Backend
    #   dockerfile: Dockerfile
    container_name: mosaic-backend
    restart: unless-stopped
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      RUN_MIGRATIONS: "true"
      ConnectionStrings__Default: "Host=postgres;Database=mosaic;Username=mosaic;Password=${POSTGRES_PASSWORD}"
      Storage__Path: /app/data/blobs
      # Enable proxy authentication (Authelia)
      Auth__LocalAuthEnabled: "false"
      Auth__ProxyAuthEnabled: "true"
      # Trust the Docker internal network
      Auth__TrustedProxies__0: "172.16.0.0/12"
      Auth__TrustedProxies__1: "10.0.0.0/8"
      Auth__TrustedProxies__2: "192.168.0.0/16"
    volumes:
      - blob_data:/app/data/blobs
    networks:
      - internal
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    image: ghcr.io/adsamcik/mosaic-frontend:latest
    # Or build from source:
    # build:
    #   context: ./Mosaic
    #   dockerfile: apps/admin/Dockerfile
    container_name: mosaic-frontend
    restart: unless-stopped
    networks:
      - internal
    depends_on:
      - backend

  # ===================
  # Authentication
  # ===================
  authelia:
    image: authelia/authelia:latest
    container_name: authelia
    restart: unless-stopped
    volumes:
      - ./authelia:/config
    networks:
      - internal
    environment:
      TZ: ${TZ:-UTC}

  # Redis for Authelia sessions (recommended for production)
  redis:
    image: redis:alpine
    container_name: authelia-redis
    restart: unless-stopped
    volumes:
      - redis_data:/data
    networks:
      - internal
    command: redis-server --save 60 1 --loglevel warning

  # ===================
  # Reverse Proxy
  # ===================
  caddy:
    image: caddy:alpine
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - internal
    depends_on:
      - frontend
      - authelia

volumes:
  postgres_data:
  blob_data:
  redis_data:
  caddy_data:
  caddy_config:

networks:
  internal:
    driver: bridge
```

### Step 2: Create .env File

```bash
# .env
POSTGRES_PASSWORD=your-secure-password-here
TZ=America/New_York

# Your domain
DOMAIN=photos.example.com
AUTH_DOMAIN=auth.example.com
```

### Step 3: Create Caddyfile

```caddyfile
# Caddyfile

# Authelia Portal
auth.example.com {
    reverse_proxy authelia:9091
}

# Mosaic Application (protected by Authelia)
photos.example.com {
    # Static assets and share links - bypass authentication
    # Required for share link viewers to load the app
    @public {
        path /s/*
        path /api/s/*
        path /assets/*
        path_regexp \.(js|css|wasm|woff2?|ttf|ico|png|svg)$
    }
    handle @public {
        reverse_proxy frontend:8080
    }

    # All other routes require authentication
    handle {
        forward_auth authelia:9091 {
            uri /api/authz/forward-auth
            copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
        }

        # Proxy to Mosaic frontend (which proxies API to backend)
        reverse_proxy frontend:8080
    }
}
```

### Step 4: Create Authelia Configuration

Create the `authelia/` directory and add the configuration files:

#### authelia/configuration.yml

```yaml
# Authelia Configuration
# See: https://www.authelia.com/configuration/prologue/introduction/

theme: auto

server:
  address: 'tcp://:9091'

log:
  level: info

totp:
  issuer: 'Mosaic Photos'

authentication_backend:
  file:
    path: /config/users_database.yml
    password:
      algorithm: argon2id
      iterations: 3
      memory: 65536
      parallelism: 4
      key_length: 32
      salt_length: 16

access_control:
  default_policy: deny
  rules:
    # Static assets - allow anonymous access for app loading
    # Required for share link viewers to load JavaScript/CSS
    - domain: 'photos.example.com'
      resources:
        - '^/assets/.*$'
        - '.*\.(js|css|wasm|woff2?|ttf|ico|png|svg)$'
      policy: bypass

    # Share links - allow anonymous access for shared albums
    # Users with a valid share link can view content without authentication
    - domain: 'photos.example.com'
      resources:
        - '^/s/.*$'
        - '^/api/s/.*$'
      policy: bypass

    # Allow access to Mosaic for all authenticated users
    - domain: 'photos.example.com'
      policy: one_factor

session:
  cookies:
    - domain: 'example.com'
      authelia_url: 'https://auth.example.com'
      default_redirection_url: 'https://photos.example.com'

  redis:
    host: redis
    port: 6379

regulation:
  max_retries: 3
  find_time: 2m
  ban_time: 5m

storage:
  local:
    path: /config/db.sqlite3

notifier:
  # For production, use SMTP instead
  filesystem:
    filename: /config/notification.txt
```

#### authelia/users_database.yml

```yaml
# User Database
# Generate password hash: docker run --rm authelia/authelia:latest authelia crypto hash generate argon2

users:
  # Example user - replace with your users
  john:
    displayname: "John Doe"
    password: "$argon2id$v=19$m=65536,t=3,p=4$BV6dGIGr7uOOLkNdLvwXJQ$5xigREYVr5k5P0kSDgPJ17ZI8ykuXbR/SuFhvvPxDaI"
    email: john@example.com
    groups:
      - users
      - admins

  jane:
    displayname: "Jane Doe"
    password: "$argon2id$v=19$m=65536,t=3,p=4$BV6dGIGr7uOOLkNdLvwXJQ$5xigREYVr5k5P0kSDgPJ17ZI8ykuXbR/SuFhvvPxDaI"
    email: jane@example.com
    groups:
      - users
```

### Step 5: Generate Password Hashes

Generate secure password hashes for your users:

```bash
# Generate a password hash
docker run --rm -it authelia/authelia:latest authelia crypto hash generate argon2

# Enter your password when prompted
# Copy the output hash to users_database.yml
```

### Step 6: Start the Stack

```bash
# Start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

### Step 7: Access Mosaic

1. Open `https://photos.example.com`
2. You'll be redirected to `https://auth.example.com`
3. Log in with the credentials from `users_database.yml`
4. After authentication, you'll be redirected back to Mosaic

---

## Option 2: nginx + Authelia

For users who prefer nginx as their reverse proxy.

### nginx Configuration Files

Create the following nginx configuration structure:

```
nginx/
├── nginx.conf
├── snippets/
│   ├── proxy.conf
│   ├── authelia-location.conf
│   └── authelia-authrequest.conf
└── sites/
    ├── authelia.conf
    └── mosaic.conf
```

#### nginx/nginx.conf

```nginx
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    keepalive_timeout 65;

    # Include site configurations
    include /etc/nginx/sites/*.conf;
}
```

#### nginx/snippets/proxy.conf

```nginx
# Standard proxy headers
proxy_set_header Host $host;
proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-URI $request_uri;
proxy_set_header X-Forwarded-Ssl on;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;

# Proxy settings
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
```

#### nginx/snippets/authelia-location.conf

```nginx
# Authelia authorization endpoint
set $upstream_authelia http://authelia:9091/api/authz/auth-request;

location /internal/authelia/authz {
    internal;
    proxy_pass $upstream_authelia;

    # Required headers for Authelia
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Content-Length "";
    proxy_set_header Connection "";

    proxy_pass_request_body off;
    proxy_http_version 1.1;
    proxy_cache_bypass $cookie_session;
    proxy_no_cache $cookie_session;
}
```

#### nginx/snippets/authelia-authrequest.conf

```nginx
# Forward auth request to Authelia
auth_request /internal/authelia/authz;

# Capture Authelia response headers
auth_request_set $user $upstream_http_remote_user;
auth_request_set $groups $upstream_http_remote_groups;
auth_request_set $name $upstream_http_remote_name;
auth_request_set $email $upstream_http_remote_email;

# Forward user identity to backend
proxy_set_header Remote-User $user;
proxy_set_header Remote-Groups $groups;
proxy_set_header Remote-Email $email;
proxy_set_header Remote-Name $name;

# Handle 401 - redirect to Authelia login
auth_request_set $redirection_url $upstream_http_location;
error_page 401 =302 $redirection_url;
```

#### nginx/sites/authelia.conf

```nginx
server {
    listen 80;
    server_name auth.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name auth.example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://authelia:9091;
    }
}
```

#### nginx/sites/mosaic.conf

```nginx
server {
    listen 80;
    server_name photos.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name photos.example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    # Include Authelia location block
    include /etc/nginx/snippets/authelia-location.conf;

    # Static assets - bypass authentication for app loading
    # Required for share link viewers to load JavaScript/CSS
    location /assets/ {
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://frontend:8080;

        # Required headers for SharedArrayBuffer
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    # Static files by extension - bypass authentication
    location ~* \.(js|css|wasm|woff2?|ttf|ico|png|svg)$ {
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://frontend:8080;

        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    # Share links - bypass authentication for anonymous access
    # These paths allow unauthenticated users to view shared albums
    location ~ ^/(s|api/s)/ {
        # No auth_request - allow anonymous access
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://frontend:8080;

        # Required headers for SharedArrayBuffer
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    # All other routes require authentication
    location / {
        # Authenticate with Authelia
        include /etc/nginx/snippets/authelia-authrequest.conf;

        # Proxy to Mosaic frontend
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://frontend:8080;

        # Required headers for SharedArrayBuffer
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }
}
```

### nginx docker-compose.yml Addition

Replace the Caddy service with nginx:

```yaml
  nginx:
    image: nginx:alpine
    container_name: nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/snippets:/etc/nginx/snippets:ro
      - ./nginx/sites:/etc/nginx/sites:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    networks:
      - internal
    depends_on:
      - frontend
      - authelia
```

---

## Option 3: Traefik + Authelia

For users running Traefik as their reverse proxy.

### Traefik docker-compose.yml

```yaml
services:
  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.tlschallenge=true"
      - "--certificatesresolvers.le.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik_letsencrypt:/letsencrypt
    networks:
      - internal

  authelia:
    image: authelia/authelia:latest
    container_name: authelia
    restart: unless-stopped
    volumes:
      - ./authelia:/config
    networks:
      - internal
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.authelia.rule=Host(`auth.example.com`)"
      - "traefik.http.routers.authelia.entrypoints=websecure"
      - "traefik.http.routers.authelia.tls.certresolver=le"
      - "traefik.http.services.authelia.loadbalancer.server.port=9091"
      # ForwardAuth middleware
      - "traefik.http.middlewares.authelia.forwardauth.address=http://authelia:9091/api/authz/forward-auth"
      - "traefik.http.middlewares.authelia.forwardauth.trustForwardHeader=true"
      - "traefik.http.middlewares.authelia.forwardauth.authResponseHeaders=Remote-User,Remote-Groups,Remote-Email,Remote-Name"

  frontend:
    image: ghcr.io/adsamcik/mosaic-frontend:latest
    container_name: mosaic-frontend
    restart: unless-stopped
    networks:
      - internal
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mosaic.rule=Host(`photos.example.com`)"
      - "traefik.http.routers.mosaic.entrypoints=websecure"
      - "traefik.http.routers.mosaic.tls.certresolver=le"
      - "traefik.http.routers.mosaic.middlewares=authelia@docker,mosaic-headers@docker"
      - "traefik.http.services.mosaic.loadbalancer.server.port=8080"
      # Required headers for SharedArrayBuffer
      - "traefik.http.middlewares.mosaic-headers.headers.customresponseheaders.Cross-Origin-Opener-Policy=same-origin"
      - "traefik.http.middlewares.mosaic-headers.headers.customresponseheaders.Cross-Origin-Embedder-Policy=credentialless"

volumes:
  traefik_letsencrypt:
```

---

## Mosaic Backend Configuration

The Mosaic backend must be configured to accept proxy authentication:

```yaml
# In docker-compose.yml, backend service environment:
environment:
  # Disable local authentication (password-based)
  Auth__LocalAuthEnabled: "false"
  
  # Enable proxy authentication (header-based)
  Auth__ProxyAuthEnabled: "true"
  
  # Trust proxies on Docker internal networks
  Auth__TrustedProxies__0: "172.16.0.0/12"
  Auth__TrustedProxies__1: "10.0.0.0/8"
  Auth__TrustedProxies__2: "192.168.0.0/16"
```

**Security Note:** Only trust specific proxy IP ranges. The `Remote-User` header can be spoofed if accepted from untrusted sources.

---

## Troubleshooting

### User Not Being Authenticated

1. **Check Authelia logs:**
   ```bash
   docker compose logs authelia
   ```

2. **Verify the `Remote-User` header is being forwarded:**
   - Check nginx/Caddy configuration includes `copy_headers` or `proxy_set_header Remote-User`
   - Mosaic frontend proxies this header to the backend

3. **Check Mosaic backend logs:**
   ```bash
   docker compose logs backend
   ```

### 401 Unauthorized After Login

1. **Verify trusted proxies configuration:**
   - The backend must trust the IP of the container sending the `Remote-User` header
   - Check the Docker network CIDR and ensure it's in `Auth__TrustedProxies__*`

2. **Check network configuration:**
   ```bash
   docker network inspect mosaic-stack_internal
   ```

### Redirect Loop

1. **Check Authelia session configuration:**
   - Ensure `domain` in session cookies matches your domain
   - Verify `authelia_url` is correct

2. **Check cookie settings:**
   - Cookies must be set for the parent domain (e.g., `example.com` not `photos.example.com`)

### CORS/SharedArrayBuffer Issues

Ensure your reverse proxy adds these headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

---

## Production Checklist

- [ ] Strong `POSTGRES_PASSWORD` (use `openssl rand -base64 32`)
- [ ] Authelia `jwt_secret` and `session.secret` set (generate random values)
- [ ] TLS certificates configured (Caddy handles this automatically)
- [ ] Authelia notifier configured for SMTP (password reset emails)
- [ ] Redis configured for Authelia sessions (included in examples)
- [ ] Firewall configured to only expose ports 80/443
- [ ] Regular backups configured (database + blob storage)
- [ ] `Auth__LocalAuthEnabled` set to `false` (use Authelia only)

---

## See Also

- [Authelia Documentation](https://www.authelia.com/docs/)
- [Authelia + nginx Integration](https://www.authelia.com/integration/proxies/nginx/)
- [Authelia + Caddy Integration](https://www.authelia.com/integration/proxies/caddy/)
- [Authelia + Traefik Integration](https://www.authelia.com/integration/proxies/traefik/)
- [Mosaic Docker Guide](DOCKER.md)
- [Mosaic Deployment Guide](DEPLOYMENT.md)
