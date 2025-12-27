# syntax=docker/dockerfile:1

# Mosaic Admin Frontend - React 19 + Vite
# Multi-stage build for optimized production image

# Build stage
FROM node:22-alpine AS build
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
WORKDIR /app/apps/admin
COPY apps/admin/package*.json ./
RUN npm ci

# Copy admin source
COPY apps/admin/ ./

# Build frontend
RUN npm run build

# Production stage - nginx with custom config
FROM nginx:alpine AS production

# Copy custom nginx configuration
COPY apps/admin/nginx.conf /etc/nginx/nginx.conf

# Copy built assets
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html

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
    CMD wget -q --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
