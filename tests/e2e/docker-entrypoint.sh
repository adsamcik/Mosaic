#!/bin/bash
# E2E Tests Docker Entrypoint
#
# This script starts a socat proxy to forward localhost:8080 to frontend:8080.
# This makes the frontend accessible via localhost, which browsers treat as a
# secure context, enabling crypto.subtle without Chrome flag workarounds.
#
# See: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

set -e

# Start socat proxy in background if FRONTEND_HOST is set
if [ -n "$FRONTEND_HOST" ]; then
    echo "[Entrypoint] Starting localhost proxy: localhost:8080 -> $FRONTEND_HOST:8080"
    socat TCP-LISTEN:8080,fork,reuseaddr TCP:$FRONTEND_HOST:8080 &
    
    # Wait for proxy to be ready
    sleep 1
    echo "[Entrypoint] Localhost proxy started"
fi

# Execute the main command (npx playwright test)
exec "$@"
