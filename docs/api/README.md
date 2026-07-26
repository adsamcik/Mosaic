# API contract

The authoritative HTTP contract is [`../openapi.json`](../openapi.json).
It is generated from the backend and checked for drift in CI.

This directory contains supplemental API guidance only. There is intentionally
no hand-maintained OpenAPI YAML copy because duplicate schemas had diverged from
the runtime routes and header requirements.

Regenerate the contract with `scripts/export-openapi.ps1` from the repository root.
