#!/bin/bash
# E2E Tests Docker Entrypoint
#
# This script starts socat proxies to make frontend and backend accessible
# via localhost, which browsers treat as a secure context for crypto.subtle.
#
# See: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

set -e

echo "[Entrypoint] Starting E2E test environment..."
echo "[Entrypoint] BASE_URL=$BASE_URL"
echo "[Entrypoint] API_URL=$API_URL"
echo "[Entrypoint] FRONTEND_HOST=$FRONTEND_HOST"
echo "[Entrypoint] BACKEND_HOST=$BACKEND_HOST"

# Start socat proxy for frontend (localhost:8080 -> frontend:8080)
if [ -n "$FRONTEND_HOST" ]; then
    echo "[Entrypoint] Starting frontend proxy: localhost:8080 -> $FRONTEND_HOST:8080"
    socat TCP-LISTEN:8080,fork,reuseaddr TCP:$FRONTEND_HOST:8080 &
    FRONTEND_PID=$!
    sleep 1
    
    if kill -0 $FRONTEND_PID 2>/dev/null; then
        echo "[Entrypoint] Frontend proxy started (PID: $FRONTEND_PID)"
    else
        echo "[Entrypoint] ERROR: Frontend proxy failed to start!"
        exit 1
    fi
fi

# Start socat proxy for backend (localhost:5000 -> backend:8080)
if [ -n "$BACKEND_HOST" ]; then
    echo "[Entrypoint] Starting backend proxy: localhost:5000 -> $BACKEND_HOST:8080"
    socat TCP-LISTEN:5000,fork,reuseaddr TCP:$BACKEND_HOST:8080 &
    BACKEND_PID=$!
    sleep 1
    
    if kill -0 $BACKEND_PID 2>/dev/null; then
        echo "[Entrypoint] Backend proxy started (PID: $BACKEND_PID)"
    else
        echo "[Entrypoint] ERROR: Backend proxy failed to start!"
        exit 1
    fi
fi

# Verify proxies are working
echo "[Entrypoint] Verifying proxy connections..."

if [ -n "$FRONTEND_HOST" ]; then
    if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8080/health 2>/dev/null | grep -q "200"; then
        echo "[Entrypoint] Frontend proxy verified ✓"
    else
        echo "[Entrypoint] WARNING: Frontend not responding on localhost:8080"
    fi
fi

if [ -n "$BACKEND_HOST" ]; then
    if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:5000/health 2>/dev/null | grep -q "200"; then
        echo "[Entrypoint] Backend proxy verified ✓"
    else
        echo "[Entrypoint] WARNING: Backend not responding on localhost:5000"
    fi
fi

# Execute the main command (npx playwright test)
echo "[Entrypoint] Executing: $@"
exec "$@"
