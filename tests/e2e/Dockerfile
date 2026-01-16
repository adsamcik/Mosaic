# syntax=docker/dockerfile:1

# E2E Tests Container with Playwright
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install curl for health check in entrypoint
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy test files
COPY tests/e2e/package*.json ./
RUN npm ci

COPY tests/e2e/ ./

# Install Playwright browsers
RUN npx playwright install --with-deps chromium firefox

# Copy entrypoint script
COPY tests/e2e/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Use entrypoint to start socat proxy before running tests
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npx", "playwright", "test"]
