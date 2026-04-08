# syntax=docker/dockerfile:1

# Mosaic Admin Frontend - React 19 + Vite
# Multi-stage build for optimized production image

# Build stage
FROM node:22-alpine@sha256:4d64b49e6c891c8fc821007cb1cdc6c0db7773110ac2c34bf2e6960adef62ed3 AS build
WORKDIR /app

# Copy workspace root files for monorepo support
COPY package*.json ./
COPY libs/crypto/package*.json ./libs/crypto/

# Install dependencies for crypto library
WORKDIR /app/libs/crypto
RUN npm ci

# Build crypto library
COPY libs/crypto/ ./
RUN npm run build

# Setup admin frontend
WORKDIR /app/apps/web
COPY apps/web/package*.json ./

# Copy admin source first (needed for postinstall to have public/ folder)
COPY apps/web/ ./

# Install dependencies (postinstall copies sql.js files to public/)
RUN npm ci

# Build arg for E2E weak crypto keys (for faster tests)
ARG VITE_E2E_WEAK_KEYS
ENV VITE_E2E_WEAK_KEYS=${VITE_E2E_WEAK_KEYS}

# Build frontend
RUN npm run build

# Production stage - nginx with custom config
FROM nginx:alpine@sha256:645eda1c2477aaa9b879f73909b9222c6f19798dd45be6706268d82a661c6e6d AS production

# OCI Image Labels (overwritten by docker/metadata-action in CI)
LABEL org.opencontainers.image.title="Mosaic Frontend" \
      org.opencontainers.image.description="Zero-knowledge encrypted photo gallery web interface" \
      org.opencontainers.image.url="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.source="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.vendor="Mosaic Contributors" \
      org.opencontainers.image.licenses="MIT"

# Copy custom nginx configuration
COPY apps/web/nginx.conf /etc/nginx/nginx.conf

# Copy built assets
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# Create non-root user for security
RUN addgroup -g 1001 -S mosaic && \
    adduser -u 1001 -S mosaic -G mosaic && \
    chown -R mosaic:mosaic /var/cache/nginx && \
    chown -R mosaic:mosaic /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R mosaic:mosaic /var/run/nginx.pid

# Switch to non-root user
USER mosaic

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
