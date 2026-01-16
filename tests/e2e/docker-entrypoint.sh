#!/bin/bash
# E2E Tests Docker Entrypoint
#
# With network_mode: host, the container shares the host's network stack.
# Chrome can directly access localhost:8080 (the frontend exposed port),
# which browsers treat as a secure context, enabling crypto.subtle.
#
# See: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

set -e

echo "[Entrypoint] Starting E2E test environment..."
echo "[Entrypoint] BASE_URL=$BASE_URL"

# Verify frontend is accessible
echo "[Entrypoint] Checking frontend health..."
MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8080/health 2>/dev/null | grep -q "200"; then
        echo "[Entrypoint] Frontend is healthy at localhost:8080"
        break
    fi
    RETRY=$((RETRY + 1))
    echo "[Entrypoint] Waiting for frontend... ($RETRY/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY -eq $MAX_RETRIES ]; then
    echo "[Entrypoint] ERROR: Frontend not accessible after $MAX_RETRIES retries"
    exit 1
fi

# Execute the main command (npx playwright test)
echo "[Entrypoint] Executing: $@"
exec "$@"
