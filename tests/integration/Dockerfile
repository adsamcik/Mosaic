# syntax=docker/dockerfile:1

# Integration Tests Container
FROM node:22-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy test files
COPY tests/integration/package*.json ./
RUN npm ci

COPY tests/integration/ ./

# Run tests
CMD ["npm", "test"]
