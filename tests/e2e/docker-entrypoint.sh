#!/bin/bash
# E2E Tests Docker Entrypoint
#
# This script starts a socat proxy to forward localhost:8080 to frontend:8080.
# This makes the frontend accessible via localhost, which browsers treat as a
# secure context, enabling crypto.subtle without Chrome flag workarounds.
#
# See: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

set -e

echo "[Entrypoint] Starting E2E test environment setup..."
echo "[Entrypoint] BASE_URL=$BASE_URL"
echo "[Entrypoint] FRONTEND_HOST=$FRONTEND_HOST"

# Start socat proxy in background if FRONTEND_HOST is set
if [ -n "$FRONTEND_HOST" ]; then
    echo "[Entrypoint] Resolving $FRONTEND_HOST..."
    getent hosts "$FRONTEND_HOST" || echo "[Entrypoint] WARNING: Could not resolve $FRONTEND_HOST"
    
    echo "[Entrypoint] Starting localhost proxy: localhost:8080 -> $FRONTEND_HOST:8080"
    socat TCP-LISTEN:8080,fork,reuseaddr TCP:$FRONTEND_HOST:8080 &
    SOCAT_PID=$!
    
    # Wait for proxy to be ready
    sleep 2
    
    # Verify proxy is running
    if kill -0 $SOCAT_PID 2>/dev/null; then
        echo "[Entrypoint] Localhost proxy started (PID: $SOCAT_PID)"
    else
        echo "[Entrypoint] ERROR: socat proxy failed to start!"
        exit 1
    fi
    
    # Test the proxy
    echo "[Entrypoint] Testing proxy connection..."
    if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8080/health 2>/dev/null | grep -q "200"; then
        echo "[Entrypoint] Proxy test successful - frontend is accessible via localhost:8080"
    else
        echo "[Entrypoint] WARNING: Could not verify proxy (frontend may not be ready yet)"
    fi
fi

# Execute the main command (npx playwright test)
echo "[Entrypoint] Executing: $@"
exec "$@"
