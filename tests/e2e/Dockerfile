# syntax=docker/dockerfile:1

# E2E Tests Container with Playwright
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copy test files
COPY tests/e2e/package*.json ./
RUN npm ci

COPY tests/e2e/ ./

# Install Playwright browsers
RUN npx playwright install --with-deps chromium firefox

# Run tests
CMD ["npx", "playwright", "test", "--reporter=list,junit,html"]
