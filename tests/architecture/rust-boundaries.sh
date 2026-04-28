#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import json
import subprocess

metadata = json.loads(subprocess.check_output([
    "cargo",
    "metadata",
    "--format-version=1",
    "--no-deps",
], text=True))

packages = {
    package["name"]: package
    for package in metadata["packages"]
    if package["name"].startswith("mosaic-")
}

expected = [
    "mosaic-domain",
    "mosaic-crypto",
    "mosaic-client",
    "mosaic-media",
    "mosaic-wasm",
    "mosaic-uniffi",
]

missing = [name for name in expected if name not in packages]
if missing:
    raise SystemExit(f"Missing Rust workspace packages: {', '.join(missing)}")

allowed = {
    "mosaic-domain": set(),
    "mosaic-crypto": {"mosaic-domain"},
    "mosaic-client": {"mosaic-domain", "mosaic-crypto"},
    "mosaic-media": {"mosaic-domain"},
    "mosaic-wasm": {"mosaic-domain", "mosaic-crypto", "mosaic-client"},
    "mosaic-uniffi": {"mosaic-domain", "mosaic-crypto", "mosaic-client", "mosaic-media"},
}

for package_name in expected:
    allowed_deps = allowed[package_name]
    for dependency in packages[package_name]["dependencies"]:
        dep_name = dependency["name"]
        if dep_name.startswith("mosaic-") and dep_name not in allowed_deps:
            raise SystemExit(f"{package_name} must not depend on {dep_name}")

print("Rust architecture boundary checks passed.")
PY
