# Authelia Integration Guide

This guide explains how to integrate Mosaic with [Authelia](https://www.authelia.com/) for Single Sign-On (SSO) authentication.

> **Candidate-only topology:** ProxyAuth is not an approved stable deployment.
> The real boundary test listed in [RELEASE_STATE.md](RELEASE_STATE.md) has not
> passed for the exact release commit. The Caddy topology below is the sole
> candidate example: use only digest-addressed images, publish only Caddy, and
> preserve the hardening from the canonical repository `docker-compose.yml`.

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
- **API**: `/api/v1/s/{linkId}/*` - Backend endpoints for share link data

**The following paths must bypass Authelia authentication** so that anyone with a valid share link can view the shared content:

| Path | Purpose |
|------|---------|
| `/s/*` | Share link frontend routes |
| `/api/v1/s/*` | Share link API endpoints |
| `/assets/*` | JavaScript, CSS bundles (Vite output) |
| `/index.html`, `/manifest.webmanifest`, `/icon.svg`, `/robots.txt` | Fixed root metadata assets |
| `/sql-wasm.wasm`, `/sw.js` | Fixed root runtime assets |

The candidate Caddy configuration below includes these bypass rules while
deleting all client-supplied identity headers on both public and protected
routes.

```
Share Link URL: https://photos.example.com/s/{linkId}#k={secret}
                                           └──────────────────────┘
                                           This path bypasses SSO
```

---

## Prerequisites

- Mosaic deployed via Docker (see [DEPLOYMENT.md](DEPLOYMENT.md))
- Docker Compose 2.33.1 or newer (`gw_priority` makes Caddy's public egress deterministic)
- A domain name with DNS configured
- Basic familiarity with Docker Compose

---

## Candidate topology: Caddy + Authelia

This is the only ProxyAuth topology documented as a Mosaic deployment
candidate. It is still blocked from stable release until the external boundary
evidence is approved for the exact release commit.

### Directory Structure

```
mosaic-stack/
├── docker-compose.yml
├── .env
├── nginx.proxyauth-deployment.conf
├── authelia/
│   ├── configuration.yml
│   ├── users_database.yml
│   └── secrets/
│       ├── JWT_SECRET
│       ├── SESSION_SECRET
│       └── STORAGE_ENCRYPTION_KEY
└── Caddyfile
```

Copy `apps/web/nginx.proxyauth-deployment.conf` from the same exact release
commit as the frontend image. Never deploy `apps/web/nginx.proxyauth.conf`; that
file is deliberately test-only and accepts Playwright's client-injected
`Remote-User`. The deployment configuration accepts network traffic only from
Caddy's fixed `172.31.0.5` edge address and passes only `Remote-User` to the
backend.

### Step 1: Create docker-compose.yml

```yaml
# docker-compose.yml
services:
  # ===================
  # Mosaic Application
  # ===================
  postgres:
    image: postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
    container_name: mosaic-postgres
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    mem_limit: 1g
    cpus: 2.0
    environment:
      POSTGRES_DB: mosaic
      POSTGRES_USER: mosaic
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      database:
        ipv4_address: 172.29.0.2
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mosaic -d mosaic"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: "${MOSAIC_BACKEND_IMAGE:?set an immutable repository@sha256 digest}"
    # Or build from source:
    # build:
    #   context: ./Mosaic/apps/backend/Mosaic.Backend
    #   dockerfile: Dockerfile
    container_name: mosaic-backend
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    mem_limit: 1g
    cpus: 2.0
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m,mode=1777
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      # The image health check uses Host: localhost; public traffic uses DOMAIN.
      AllowedHosts: "${DOMAIN:?DOMAIN must be set};localhost"
      RUN_MIGRATIONS: "false"
      ConnectionStrings__Default: "Host=postgres;Database=mosaic;Username=mosaic;Password=${POSTGRES_PASSWORD}"
      Storage__Path: /app/data/blobs
      Audit__LogPath: /app/data/audit/audit-.log
      Auth__ServerSecret: "${AUTH_SERVER_SECRET:?AUTH_SERVER_SECRET must be set}"
      # Enable proxy authentication (Authelia)
      Auth__LocalAuthEnabled: "false"
      Auth__ProxyAuthEnabled: "true"
      # Trust only the immediate frontend Nginx hop, never a whole private range.
      Auth__TrustedProxies__0: "172.30.0.4/32"
    volumes:
      - blob_data:/app/data/blobs
      - audit_data:/app/data/audit
    networks:
      database:
        ipv4_address: 172.29.0.3
      app:
        ipv4_address: 172.30.0.3
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    image: "${MOSAIC_FRONTEND_IMAGE:?set an immutable repository@sha256 digest}"
    # Or build from source:
    # build:
    #   context: ./Mosaic
    #   dockerfile: apps/web/Dockerfile
    container_name: mosaic-frontend
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    mem_limit: 256m
    cpus: 1.0
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m,mode=1777
      - /var/cache/nginx:rw,noexec,nosuid,size=32m,uid=1001,gid=1001,mode=0755
      - /var/log/nginx:rw,noexec,nosuid,size=16m,uid=1001,gid=1001,mode=0755
      - /var/run:rw,noexec,nosuid,size=4m,uid=1001,gid=1001,mode=0755
    volumes:
      # Copy the deployment config, never the similarly named test-only config.
      - ./nginx.proxyauth-deployment.conf:/etc/nginx/nginx.conf:ro
    networks:
      app:
        ipv4_address: 172.30.0.4
      edge:
        ipv4_address: 172.31.0.4
    depends_on:
      - backend

  # ===================
  # Authentication
  # ===================
  authelia:
    image: "${AUTHELIA_IMAGE:?set an immutable repository@sha256 digest}"
    container_name: authelia
    restart: unless-stopped
    volumes:
      - ./authelia:/config
    secrets:
      - authelia_jwt_secret
      - authelia_session_secret
      - authelia_storage_encryption_key
    networks:
      edge:
        ipv4_address: 172.31.0.6
      auth:
        ipv4_address: 172.32.0.6
    environment:
      TZ: ${TZ:-UTC}
      AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE: /run/secrets/authelia_jwt_secret
      AUTHELIA_SESSION_SECRET_FILE: /run/secrets/authelia_session_secret
      AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE: /run/secrets/authelia_storage_encryption_key

  # Redis for Authelia sessions (recommended for production)
  redis:
    image: "${REDIS_IMAGE:?set an immutable repository@sha256 digest}"
    container_name: authelia-redis
    restart: unless-stopped
    volumes:
      - redis_data:/data
    networks:
      auth:
        ipv4_address: 172.32.0.7
    command: redis-server --save 60 1 --loglevel warning

  # ===================
  # Reverse Proxy
  # ===================
  caddy:
    image: "${CADDY_IMAGE:?set an immutable repository@sha256 digest}"
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
      public:
        # Compose 2.33.1+: select this as Caddy's ACME/Internet gateway.
        gw_priority: 1
      edge:
        # Must match the allow rule in nginx.proxyauth-deployment.conf.
        ipv4_address: 172.31.0.5
    depends_on:
      - frontend
      - authelia

volumes:
  postgres_data:
  blob_data:
  audit_data:
  redis_data:
  caddy_data:
  caddy_config:

secrets:
  authelia_jwt_secret:
    file: ./authelia/secrets/JWT_SECRET
  authelia_session_secret:
    file: ./authelia/secrets/SESSION_SECRET
  authelia_storage_encryption_key:
    file: ./authelia/secrets/STORAGE_ENCRYPTION_KEY

networks:
  # Only Caddy is attached to this non-internal network for ACME/Internet
  # access. Every application/authentication network below is internal.
  public:
    driver: bridge
  database:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.29.0.0/24
  app:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.30.0.0/24
  edge:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.31.0.0/24
  auth:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.32.0.0/24
```

### Step 2: Create .env File

```bash
# .env
# Generate both secrets locally; do not commit this file.
POSTGRES_PASSWORD=
AUTH_SERVER_SECRET=

# Set every image to a reviewed repository@sha256:<64-hex> subject.
MOSAIC_BACKEND_IMAGE=
MOSAIC_FRONTEND_IMAGE=
AUTHELIA_IMAGE=
REDIS_IMAGE=
CADDY_IMAGE=
NGINX_IMAGE=
TRAEFIK_IMAGE=
TZ=America/New_York

# Your domain
DOMAIN=photos.example.com
AUTH_DOMAIN=auth.example.com
```

Generate `POSTGRES_PASSWORD` and `AUTH_SERVER_SECRET` locally (for example,
`openssl rand -base64 48` for each). Keep `.env` mode `0600` and never commit it.

Create the required Authelia secrets as separate mode-`0600` files. Compose
mounts them read-only and points Authelia at them with its supported `_FILE`
environment variables:

```bash
install -d -m 0700 authelia/secrets
umask 077
openssl rand -hex 32 > authelia/secrets/JWT_SECRET
openssl rand -hex 32 > authelia/secrets/SESSION_SECRET
openssl rand -hex 32 > authelia/secrets/STORAGE_ENCRYPTION_KEY
```

### Step 3: Create Caddyfile

```caddyfile
# Caddyfile

# Authelia Portal
auth.example.com {
    route {
        # Never pass browser-provided identity to the auth service.
        request_header -Remote-*
        request_header -X-Auth-Request-*
        request_header -X-Forwarded-*
        request_header -Forwarded
        reverse_proxy authelia:9091
    }
}

# Mosaic Application (protected by Authelia)
photos.example.com {
    # Static assets and share links - bypass authentication
    # Required for share link viewers to load the app
    @public path /s /s/* /api/v1/s /api/v1/s/* /assets /assets/* /index.html /manifest.webmanifest /sql-wasm.wasm /sw.js /icon.svg /robots.txt
    handle @public {
        route {
            # Bypass authentication, never identity-header deletion.
            request_header -Remote-*
            request_header -X-Auth-Request-*
            request_header -X-Forwarded-*
            request_header -Forwarded
            reverse_proxy frontend:8080
        }
    }

    # All other routes require authentication
    handle {
        route {
            # Delete spoofable identity before the auth subrequest. forward_auth
            # then overwrites only Remote-User from Authelia's response.
            request_header -Remote-*
            request_header -X-Auth-Request-*
            request_header -X-Forwarded-*
            request_header -Forwarded
            forward_auth authelia:9091 {
                uri /api/authz/forward-auth
                copy_headers Remote-User
            }

            # Proxy to Mosaic frontend (which proxies API to backend).
            reverse_proxy frontend:8080
        }
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
      algorithm: argon2
      argon2:
        variant: argon2id
        iterations: 3
        memory: 65535
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
        - '^/assets(?:/.*)?$'
        - '^/index\.html$'
        - '^/manifest\.webmanifest$'
        - '^/sql-wasm\.wasm$'
        - '^/sw\.js$'
        - '^/icon\.svg$'
        - '^/robots\.txt$'
      policy: bypass

    # Share links - allow anonymous access for shared albums
    # Users with a valid share link can view content without authentication
    - domain: 'photos.example.com'
      resources:
        - '^/s(?:/.*)?$'
        - '^/api/v1/s(?:/.*)?$'
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
  # This candidate keeps Authelia off public/egress networks. To use SMTP,
  # add a reviewed outbound-only relay/network and repeat the boundary test.
  filesystem:
    filename: /config/notification.txt
```

#### authelia/users_database.yml

```yaml
# User Database
# Generate password hash: docker run --rm "${AUTHELIA_IMAGE:?set an immutable repository@sha256 digest}" authelia crypto hash generate argon2

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
docker run --rm -it "${AUTHELIA_IMAGE:?set an immutable repository@sha256 digest}" authelia crypto hash generate argon2

# Enter your password when prompted
# Copy the output hash to users_database.yml
```

### Step 6: Start the Stack

```bash
# On upgrades, first run `backup` and `verify-backup` with the canonical
# scripts from the exact release checkout. Then start the database and migrate.
docker compose up -d postgres
docker compose run --rm --no-deps backend --migrate-only

# Start serving only after migration succeeds.
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

## Reference only: nginx + Authelia

The snippets in this section are design reference, not a deployable Mosaic
candidate. They have not been bound to the fixed-address Compose topology or
the required real ProxyAuth boundary test. Do not expose or deploy them until
they provide the same header deletion, exact-peer restriction, anonymous-share
routing, and external evidence as the Caddy candidate above.

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

    log_format main '$remote_addr - $remote_user [$time_local] '
                    '"$request_method $loggable_uri $server_protocol" '
                    '$status $body_bytes_sent '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    # Redact bearer-adjacent share IDs and resource IDs from access logs.
    # Referer is deliberately omitted because an asset request can carry a
    # share route in that header.
    map $uri $loggable_uri {
        ~*^/api/v1/s/[^/]+/shards/   "/api/v1/s/<redacted>/shards/<redacted>";
        ~*^/api/v1/s/                "/api/v1/s/<redacted>";
        ~*^/api/v1/albums/[^/]+      "/api/v1/albums/<redacted>";
        ~*^/api/v1/manifests/[^/]+   "/api/v1/manifests/<redacted>";
        ~*^/api/v1/shards/[^/]+      "/api/v1/shards/<redacted>";
        ~*^/api/v1/share-links/[^/]+ "/api/v1/share-links/<redacted>";
        ~*^/api/v1/files/[^/]+       "/api/v1/files/<redacted>";
        ~*^/api/v1/tiles/             "/api/v1/tiles/<redacted>";
        ~*^/api/s/[^/]+/shards/      "/api/s/<redacted>/shards/<redacted>";
        ~*^/api/s/                   "/api/s/<redacted>";
        ~*^/s/                       "/s/<redacted>";
        ~*^/api/albums/[^/]+         "/api/albums/<redacted>";
        ~*^/api/manifests/[^/]+      "/api/manifests/<redacted>";
        ~*^/api/shards/[^/]+         "/api/shards/<redacted>";
        ~*^/api/share-links/[^/]+    "/api/share-links/<redacted>";
        default                     $uri;
    }

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

# Delete any identity supplied by the browser. A protected location may
# overwrite only Remote-User after a successful auth_request.
proxy_set_header Remote-User "";
proxy_set_header Remote-Groups "";
proxy_set_header Remote-Email "";
proxy_set_header Remote-Name "";

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
# Forward only the authenticated user identity.
proxy_set_header Remote-User $user;

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
    location ~ ^/(s|api/s|api/v1/s)/ {
        # No auth_request - allow anonymous access
        include /etc/nginx/snippets/proxy.conf;
        proxy_pass http://frontend:8080;

        # Required headers for SharedArrayBuffer
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }

    # All other routes require authentication
    location / {
        # Clear browser identity first, then overwrite Remote-User only after
        # a successful Authelia subrequest.
        include /etc/nginx/snippets/proxy.conf;
        include /etc/nginx/snippets/authelia-authrequest.conf;
        proxy_pass http://frontend:8080;

        # Required headers for SharedArrayBuffer
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "credentialless" always;
    }
}
```

### nginx docker-compose.yml Addition

This incomplete service fragment is retained only to show where an edge proxy
would attach. It is not a replacement for the candidate Caddy service.

```yaml
  nginx:
    image: "${NGINX_IMAGE:?set an immutable repository@sha256 digest}"
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
      edge:
        ipv4_address: 172.31.0.5
    depends_on:
      - frontend
      - authelia
```

---

## Reference only: Traefik + Authelia

This fragment is intentionally not ProxyAuth-functional and is not a
deployment candidate. It lacks the reviewed share-route split and exact
frontend peer contract. Do not mount either ProxyAuth Nginx configuration into
this fragment; first implement and test controls equivalent to the Caddy
candidate and obtain the exact-commit external boundary evidence.

### Traefik docker-compose.yml

```yaml
services:
  traefik:
    image: "${TRAEFIK_IMAGE:?set an immutable repository@sha256 digest}"
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
    image: "${AUTHELIA_IMAGE:?set an immutable repository@sha256 digest}"
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
      - "traefik.http.middlewares.authelia.forwardauth.trustForwardHeader=false"
      - "traefik.http.middlewares.authelia.forwardauth.authResponseHeaders=Remote-User"

  frontend:
    image: "${MOSAIC_FRONTEND_IMAGE:?set an immutable repository@sha256 digest}"
    container_name: mosaic-frontend
    restart: unless-stopped
    networks:
      internal:
        ipv4_address: 172.30.0.4
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
  
  # Trust only the exact frontend address from the candidate app network.
  Auth__TrustedProxies__0: "172.30.0.4/32"
```

**Security Note:** Trust only the exact immediate frontend proxy address as a `/32`. The `Remote-User` header can be spoofed if accepted from any broader or directly reachable source.

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
   - Inspect the immediate `mosaic-frontend` container address and require its exact `/32`; ensure it's in `Auth__TrustedProxies__*`

2. **Check network configuration:**
   ```bash
   docker network inspect mosaic-stack_edge
   docker network inspect mosaic-stack_app
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

## Candidate Checklist (not stable approval)

- [ ] Strong `POSTGRES_PASSWORD` (use `openssl rand -base64 32`)
- [ ] Authelia `jwt_secret` and `session.secret` set (generate random values)
- [ ] TLS certificates configured (Caddy handles this automatically)
- [ ] Notification delivery reviewed; any SMTP relay uses a dedicated outbound-only path
- [ ] Redis configured for Authelia sessions (included in examples)
- [ ] Firewall configured to only expose ports 80/443
- [ ] Only Caddy publishes host ports; frontend, backend, database, Authelia, and Redis publish none
- [ ] `nginx.proxyauth-deployment.conf` mounted; test-only `nginx.proxyauth.conf` absent
- [ ] Caddy fixed at `172.31.0.5`; frontend reachable only from that exact peer
- [ ] Client identity headers deleted before auth; only Authelia `Remote-User` copied
- [ ] Regular backups configured (database + blob storage)
- [ ] `Auth__LocalAuthEnabled` set to `false` (use Authelia only)
- [ ] Real ProxyAuth boundary evidence approved for this exact commit (currently missing)

---

## See Also

- [Authelia Documentation](https://www.authelia.com/docs/)
- [Authelia + nginx Integration](https://www.authelia.com/integration/proxies/nginx/)
- [Authelia + Caddy Integration](https://www.authelia.com/integration/proxies/caddy/)
- [Authelia + Traefik Integration](https://www.authelia.com/integration/proxies/traefik/)
- [Mosaic Docker Guide](DOCKER.md)
- [Mosaic Deployment Guide](DEPLOYMENT.md)
