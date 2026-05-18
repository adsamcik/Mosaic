#!/usr/bin/env bash
# Exports the backend OpenAPI document to docs/openapi.json.
# Used locally and by the CI drift gate (.github/workflows/tests.yml).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
target="$repo_root/docs/openapi.json"
export ASPNETCORE_ENVIRONMENT=Development
export ConnectionStrings__Default="Data Source=:memory:"
dotnet run --project "$repo_root/apps/backend/Mosaic.Backend" -- --export-openapi "$target"
echo "OpenAPI exported to $target"
