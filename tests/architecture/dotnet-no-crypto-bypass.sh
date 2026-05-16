#!/usr/bin/env bash
# .NET backend crypto-boundary guard.
#
# Production backend authentication/signature verification must route through
# RustCoreHost (wasmtime-hosted Rust core), not through managed Ed25519/NSec or
# other direct signature primitives.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

root = Path("apps/backend/Mosaic.Backend")
if not root.exists():
    raise SystemExit("Missing production backend tree: apps/backend/Mosaic.Backend")

package_pattern = re.compile(r'<PackageReference\s+Include="(?:NSec\.Cryptography|BouncyCastle[^"]*|Sodium\.Core|Chaos\.NaCl)"', re.I)
source_patterns = {
    "managed-nsec": re.compile(r"\bNSec\.Cryptography\b|^\s*using\s+NSec\.Cryptography\s*;", re.M),
    "managed-ed25519": re.compile(r"\bSignatureAlgorithm\s*\.\s*Ed25519\b|\bPublicKey\s*\.\s*Import\b|\bKey\s*\.\s*Import\b"),
    "managed-signature-api": re.compile(r"\b(ECDsa|DSA|RSA)\s*\.\s*Create\b|\bIncrementalHash\s*\.\s*CreateHMAC\b"),
}

negative_fixtures = {
    "nsec-package": (package_pattern, '<PackageReference Include="NSec.Cryptography" Version="25.4.0" />'),
    "nsec-using": (source_patterns["managed-nsec"], "using NSec.Cryptography;"),
    "ed25519-verify": (source_patterns["managed-ed25519"], "var algorithm = SignatureAlgorithm.Ed25519;"),
    "ecdsa-bypass": (source_patterns["managed-signature-api"], "using var key = ECDsa.Create();"),
}

for name, (pattern, source) in negative_fixtures.items():
    if not pattern.search(source):
        raise SystemExit(f"dotnet-no-crypto-bypass negative fixture '{name}' was not caught")

violations: list[str] = []

for csproj in root.rglob("*.csproj"):
    text = csproj.read_text(encoding="utf-8")
    for match in package_pattern.finditer(text):
        line_no = text[:match.start()].count("\n") + 1
        violations.append(f"{csproj.as_posix()}:{line_no}: forbidden managed crypto package reference")

for cs_file in root.rglob("*.cs"):
    rel = cs_file.as_posix()
    text = cs_file.read_text(encoding="utf-8")
    for label, pattern in source_patterns.items():
        for match in pattern.finditer(text):
            line_no = text[:match.start()].count("\n") + 1
            line = text.splitlines()[line_no - 1].strip()
            violations.append(f"{rel}:{line_no}: forbidden {label} crypto bypass; use RustCoreHost -> {line}")

if violations:
    print("dotnet-no-crypto-bypass guard FAILED:")
    for violation in sorted(set(violations)):
        print(f"  {violation}")
    print()
    print("Production backend signature/auth verification must be hosted by RustCoreHost.")
    raise SystemExit(1)

print("dotnet-no-crypto-bypass guard: OK (production .NET crypto routes through RustCoreHost)")
PY
