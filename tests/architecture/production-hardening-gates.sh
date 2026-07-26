#!/usr/bin/env bash
# Fail closed if production deployment/security boundaries regress.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


compose = read("docker-compose.yml")
program = read("apps/backend/Mosaic.Backend/Program.cs")
auth = read("apps/backend/Mosaic.Backend/Infrastructure/AuthConfigurationResolver.cs")
auth_tests = read("apps/backend/Mosaic.Backend.Tests/Infrastructure/AuthConfigurationResolverTests.cs")
sidecar_options = read("apps/backend/Mosaic.Backend/SidecarSignaling/SidecarSignalingOptions.cs")
appsettings = read("apps/backend/Mosaic.Backend/appsettings.json")
safe_path = read("apps/backend/Mosaic.Backend/Middleware/SafeRequestPath.cs")
health = read("apps/backend/Mosaic.Backend/Controllers/HealthController.cs")
metrics = read("apps/backend/Mosaic.Backend/Services/MosaicMetrics.cs")
db_worker = read("apps/web/src/workers/db.worker.ts")
copy_sql = read("apps/web/scripts/copy-sql-wasm.cjs")
wasm_source = read("crates/mosaic-wasm/src/lib.rs")
wasm_types = read("apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts")
wasm_js = read("apps/web/src/generated/mosaic-wasm/mosaic_wasm.js")
worker_types = read("apps/web/src/workers/types.ts")
rust_crypto_core = read("apps/web/src/workers/rust-crypto-core.ts")
crypto_worker = read("apps/web/src/workers/crypto.worker.ts")
authelia = read("docs/AUTHELIA.md")
docker_guide = read("docs/DOCKER.md")
deployment_guide = read("docs/DEPLOYMENT.md")
architecture_guide = read("docs/ARCHITECTURE.md")
features_guide = read("docs/FEATURES.md")
proxyauth_test_compose = read("docker-compose.test.proxyauth.yml")
local_nginx = read("apps/web/nginx.conf")
proxyauth_test_nginx = read("apps/web/nginx.proxyauth.conf")
proxyauth_deployment_nginx = read("apps/web/nginx.proxyauth-deployment.conf")

required_compose = (
    "name: mosaic",
    "postgres:17-alpine@sha256:",
    'RUN_MIGRATIONS: "false"',
    "Audit__LogPath: /app/data/audit/audit-.log",
    "audit_data:/app/data/audit",
    "POSTGRES_PIDS_LIMIT",
    "BACKEND_PIDS_LIMIT",
    "FRONTEND_PIDS_LIMIT",
    "POSTGRES_MEMORY_LIMIT",
    "BACKEND_MEMORY_LIMIT",
    "FRONTEND_MEMORY_LIMIT",
    "POSTGRES_CPU_LIMIT",
    "BACKEND_CPU_LIMIT",
    "FRONTEND_CPU_LIMIT",
    "name: mosaic_postgres_data",
    "name: mosaic_blob_data",
    "name: mosaic_audit_data",
)
for token in required_compose:
    if token not in compose:
        raise SystemExit(f"production-hardening-gates: compose guarantee missing: {token}")

if compose.count("    read_only: true\n") != 2:
    raise SystemExit("production-hardening-gates: backend and frontend must have read-only roots")
if compose.count("      - ALL\n") != 2:
    raise SystemExit("production-hardening-gates: backend and frontend must drop all capabilities")
if compose.count("      - no-new-privileges:true\n") != 3:
    raise SystemExit("production-hardening-gates: every production service needs no-new-privileges")
if not re.search(r"image:\s+postgres:[^\s]+@sha256:[0-9a-f]{64}$", compose, re.MULTILINE):
    raise SystemExit("production-hardening-gates: PostgreSQL image needs a full immutable digest")

for line_number, line in enumerate(authelia.splitlines(), start=1):
    if re.match(r"^\s*image:\s*", line) and "@sha256" not in line:
        raise SystemExit(
            f"production-hardening-gates: AUTHELIA.md has an unpinned image at line {line_number}"
        )
for unsafe in ('RUN_MIGRATIONS: "true"', "0.0.0.0/0", "::/0", "$http_referer"):
    if unsafe in authelia:
        raise SystemExit(f"production-hardening-gates: AUTHELIA.md contains unsafe deployment token: {unsafe}")

for guide_name, guide in (
    ("AUTHELIA.md", authelia),
    ("DOCKER.md", docker_guide),
    ("DEPLOYMENT.md", deployment_guide),
    ("ARCHITECTURE.md", architecture_guide),
    ("FEATURES.md", features_guide),
):
    for unsafe in (
        "172.16.0.0/12",
        "10.0.0.0/8",
        "192.168.0.0/16",
        "header_up Remote-User",
        "proxy_set_header Remote-User $http_x_forwarded",
        "copy_headers Remote-User Remote-",
        "trustForwardHeader=true",
        "/api/v1/authz/",
    ):
        if unsafe in guide:
            raise SystemExit(
                f"production-hardening-gates: {guide_name} contains unsafe ProxyAuth guidance: {unsafe}"
            )

for stale_claim in (
    "ProxyAuth (Production)",
    "| `Auth__ProxyAuthEnabled` | `true` |",
    "| `Auth__TrustedProxies__0` | Docker networks |",
):
    if stale_claim in architecture_guide:
        raise SystemExit(
            f"production-hardening-gates: ARCHITECTURE.md overstates ProxyAuth readiness: {stale_claim}"
        )
for token in (
    "ProxyAuth (deployment-specific candidate)",
    "| `Auth__ProxyAuthEnabled` | `false` |",
    "exact-commit external boundary evidence",
):
    if token not in architecture_guide:
        raise SystemExit(
            f"production-hardening-gates: ARCHITECTURE.md candidate state missing: {token}"
        )

if "Proxy Authentication (Production)" in features_guide:
    raise SystemExit("production-hardening-gates: FEATURES.md overstates ProxyAuth readiness")
for token in (
    "Proxy Authentication (deployment-specific candidate)",
    "does not constitute real",
    "Auth__TrustedProxies__0=172.30.0.4/32",
):
    if token not in features_guide:
        raise SystemExit(
            f"production-hardening-gates: FEATURES.md candidate boundary missing: {token}"
        )

authelia_log_format = re.search(r"log_format main (?P<body>.*?);", authelia, re.DOTALL)
if authelia_log_format is None or re.search(r"\$request(?!_)", authelia_log_format.group("body")):
    raise SystemExit("production-hardening-gates: AUTHELIA.md must log only a redacted request URI")

required_authelia = (
    "${MOSAIC_BACKEND_IMAGE:?set an immutable repository@sha256 digest}",
    "${MOSAIC_FRONTEND_IMAGE:?set an immutable repository@sha256 digest}",
    'RUN_MIGRATIONS: "false"',
    "Audit__LogPath: /app/data/audit/audit-.log",
    "audit_data:/app/data/audit",
    "read_only: true",
    "cap_drop:",
    "pids_limit:",
    "mem_limit:",
    "cpus:",
    "nginx.proxyauth-deployment.conf:/etc/nginx/nginx.conf:ro",
    "docker compose run --rm --no-deps backend --migrate-only",
    "$loggable_uri",
    "~*^/api/v1/s/",
    "request_header -Remote-*",
    "copy_headers Remote-User",
    "ipv4_address: 172.31.0.5",
    'Auth__TrustedProxies__0: "172.30.0.4/32"',
    "AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE",
    "AUTHELIA_SESSION_SECRET_FILE",
    "AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE",
    "algorithm: argon2",
    "variant: argon2id",
    "uri /api/authz/forward-auth",
    'AllowedHosts: "${DOMAIN:?DOMAIN must be set};localhost"',
    "Real ProxyAuth boundary evidence approved for this exact commit (currently missing)",
)
for token in required_authelia:
    if token not in authelia:
        raise SystemExit(f"production-hardening-gates: AUTHELIA.md guarantee missing: {token}")
if not re.search(r'Auth__TrustedProxies__\d+:\s*"(?:[0-9]{1,3}\.){3}[0-9]{1,3}/32"', authelia):
    raise SystemExit("production-hardening-gates: AUTHELIA.md must trust only an exact frontend /32")

candidate_compose_match = re.search(
    r"### Step 1: Create docker-compose\.yml\s+```yaml\s+(?P<body>.*?)```",
    authelia,
    re.DOTALL,
)
if candidate_compose_match is None:
    raise SystemExit("production-hardening-gates: candidate ProxyAuth Compose block missing")
candidate_compose = candidate_compose_match.group("body")
for token in (
    "database:",
    "app:",
    "edge:",
    "auth:",
    "public:",
    "internal: true",
    "ipv4_address: 172.30.0.4",
    "ipv4_address: 172.31.0.4",
    "ipv4_address: 172.31.0.5",
    "ipv4_address: 172.31.0.6",
    "gw_priority: 1",
):
    if token not in candidate_compose:
        raise SystemExit(f"production-hardening-gates: candidate ProxyAuth topology missing: {token}")
if candidate_compose.count("    ports:\n") != 1:
    raise SystemExit("production-hardening-gates: only Caddy may publish candidate host ports")
caddy_service = candidate_compose.split("\n  caddy:\n", 1)
if len(caddy_service) != 2 or '      - "80:80"' not in caddy_service[1] or '      - "443:443"' not in caddy_service[1]:
    raise SystemExit("production-hardening-gates: Caddy must be the candidate's sole 80/443 publisher")
if candidate_compose.count("    internal: true\n") != 4:
    raise SystemExit(
        "production-hardening-gates: database, app, edge, and auth networks must be internal"
    )
if candidate_compose.count("      public:\n") != 1:
    raise SystemExit("production-hardening-gates: only Caddy may attach to the public network")
if "./nginx.proxyauth.conf:/etc/nginx/nginx.conf:ro" in candidate_compose:
    raise SystemExit("production-hardening-gates: test-only ProxyAuth config mounted by candidate")

candidate_caddy_match = re.search(
    r"### Step 3: Create Caddyfile\s+```caddyfile\s+(?P<body>.*?)```",
    authelia,
    re.DOTALL,
)
if candidate_caddy_match is None:
    raise SystemExit("production-hardening-gates: candidate Caddyfile block missing")
candidate_caddy = candidate_caddy_match.group("body")
for header_pattern in ("Remote-*", "X-Auth-Request-*", "X-Forwarded-*", "Forwarded"):
    if candidate_caddy.count(f"request_header -{header_pattern}") < 3:
        raise SystemExit(
            "production-hardening-gates: Caddy must delete "
            f"{header_pattern} on portal, public, and protected routes"
        )
copy_lines = [
    line.strip()
    for line in candidate_caddy.splitlines()
    if line.strip().startswith("copy_headers ")
]
if copy_lines != ["copy_headers Remote-User"]:
    raise SystemExit("production-hardening-gates: Caddy may copy only Authelia Remote-User")
public_route = candidate_caddy.split("handle @public", 1)
protected_route = candidate_caddy.split("# All other routes require authentication", 1)
if (
    len(public_route) != 2
    or public_route[1].split("# All other routes require authentication", 1)[0].find(
        "request_header -Remote-*"
    ) < 0
    or len(protected_route) != 2
    or protected_route[1].find("request_header -Remote-*")
    > protected_route[1].find("forward_auth ")
):
    raise SystemExit("production-hardening-gates: Caddy identity deletion must precede public forwarding and auth")
if (
    "@public path /s /s/* /api/v1/s /api/v1/s/* /assets /assets/* "
    "/index.html /manifest.webmanifest /sql-wasm.wasm /sw.js /icon.svg /robots.txt"
    not in candidate_caddy
    or "path_regexp" in candidate_caddy
):
    raise SystemExit("production-hardening-gates: Caddy anonymous share/static matcher missing")
for resource in (
    r"'^/s(?:/.*)?$'",
    r"'^/api/v1/s(?:/.*)?$'",
    r"'^/assets(?:/.*)?$'",
    r"'^/sql-wasm\.wasm$'",
    r"'^/sw\.js$'",
):
    if resource not in authelia:
        raise SystemExit(f"production-hardening-gates: exact Authelia bypass missing: {resource}")
if r".*\.(js|css|wasm" in authelia:
    raise SystemExit("production-hardening-gates: broad extension-based Authelia bypass is forbidden")

for guide_name, guide in (("DOCKER.md", docker_guide), ("DEPLOYMENT.md", deployment_guide)):
    for token in (
        "nginx.proxyauth-deployment.conf",
        "nginx.proxyauth.conf",
        "172.30.0.4/32",
        "candidate",
    ):
        if token not in guide:
            raise SystemExit(
                f"production-hardening-gates: {guide_name} missing ProxyAuth candidate warning: {token}"
            )

if "TEST-ONLY ProxyAuth configuration" not in proxyauth_test_nginx:
    raise SystemExit("production-hardening-gates: header-injection Nginx config must remain explicit test-only")
if "proxy_set_header Remote-User $http_remote_user;" not in proxyauth_test_nginx:
    raise SystemExit("production-hardening-gates: ProxyAuth E2E simulation no longer injects Remote-User")
if (
    "./apps/web/nginx.proxyauth.conf:/etc/nginx/nginx.conf:ro"
    not in proxyauth_test_compose
    or "./apps/web/nginx.proxyauth-deployment.conf:/etc/nginx/nginx.conf:ro"
    in proxyauth_test_compose
):
    raise SystemExit("production-hardening-gates: E2E must mount only the explicit test-only Nginx config")

for token in (
    "CANDIDATE-ONLY ProxyAuth deployment configuration",
    "allow 172.31.0.5;",
    "deny all;",
    "location = /health",
    "proxy_set_header Remote-User $http_remote_user;",
    'proxy_set_header Remote-Groups "";',
    'proxy_set_header Remote-Email "";',
    'proxy_set_header Remote-Name "";',
):
    if token not in proxyauth_deployment_nginx:
        raise SystemExit(f"production-hardening-gates: deployment ProxyAuth Nginx control missing: {token}")
server_prefix = proxyauth_deployment_nginx.split("# Security headers", 1)[0]
if "allow 127.0.0.1;" in server_prefix or "allow ::1;" in server_prefix:
    raise SystemExit("production-hardening-gates: loopback may bypass only the exact health location")
health_location = re.search(
    r"location = /health\s*\{(?P<body>.*?)^\s*\}",
    proxyauth_deployment_nginx,
    re.DOTALL | re.MULTILINE,
)
if health_location is None or any(
    token not in health_location.group("body")
    for token in ("allow 127.0.0.1;", "allow ::1;", "allow 172.31.0.5;", "deny all;")
):
    raise SystemExit("production-hardening-gates: exact frontend health allow-list missing")
allowed_peers = set(
    re.findall(r"^\s*allow\s+([^;]+);", proxyauth_deployment_nginx, re.MULTILINE)
)
if allowed_peers != {"127.0.0.1", "::1", "172.31.0.5"}:
    raise SystemExit(
        "production-hardening-gates: deployment ProxyAuth Nginx allow-list is not exact: "
        + ", ".join(sorted(allowed_peers))
    )
for config_name, config in (
    ("default", local_nginx),
    ("ProxyAuth test", proxyauth_test_nginx),
    ("ProxyAuth deployment", proxyauth_deployment_nginx),
):
    for header in ("Remote-Groups", "Remote-Email", "Remote-Name"):
        if f'proxy_set_header {header} "";' not in config:
            raise SystemExit(
                f"production-hardening-gates: {config_name} Nginx must clear unused {header}"
            )
    if "location ^~ /api/" not in config:
        raise SystemExit(
            f"production-hardening-gates: {config_name} Nginx must keep API routes ahead of asset regexes"
        )
if "proxy_set_header X-Forwarded-Proto https;" not in proxyauth_deployment_nginx:
    raise SystemExit("production-hardening-gates: candidate Nginx must preserve the outer HTTPS scheme")
if (
    "proxy_set_header X-Forwarded-For $http_x_forwarded_for;"
    not in proxyauth_deployment_nginx
    or "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    in proxyauth_deployment_nginx
):
    raise SystemExit(
        "production-hardening-gates: candidate Nginx must pass Caddy's sanitized "
        "single-hop client address without appending Caddy"
    )

for token in (
    "System.Net.IPNetwork.TryParse",
    "configured.Network.PrefixLength == 0",
    "environment.IsProduction()",
    "throw new InvalidOperationException",
):
    if token not in auth:
        raise SystemExit(f"production-hardening-gates: parsed broad-CIDR guard missing: {token}")
for token in (
    "ValidateForStartup_Throws_WhenProductionTrustsEveryAddress",
    "0.0.0.0/0",
    "::/0",
    "192.0.2.123/0",
    "2001:db8::1234/0",
):
    if token not in auth_tests:
        raise SystemExit(f"production-hardening-gates: broad-CIDR regression coverage missing: {token}")

if "public bool Enabled { get; set; }" not in sidecar_options:
    raise SystemExit("production-hardening-gates: Sidecar enable option missing")
if '"Enabled": false' not in appsettings:
    raise SystemExit("production-hardening-gates: Sidecar must default off")
for token in ("if (sidecarEnabled)", "app.MapSidecarSignaling();", "app.MapSidecarTelemetry();"):
    if token not in program:
        raise SystemExit(f"production-hardening-gates: Sidecar server gate missing: {token}")

for token in ("RouteEndpoint", "RoutePattern.RawText", "{redacted}"):
    if token not in safe_path:
        raise SystemExit(f"production-hardening-gates: safe request-path behavior missing: {token}")

for nginx_path in (
    "apps/web/nginx.conf",
    "apps/web/nginx.proxyauth.conf",
    "apps/web/nginx.proxyauth-deployment.conf",
):
    nginx = read(nginx_path)
    if any(token not in nginx for token in ("~*^/api/v1/s/", "~*^/api/v1/albums/", "~*^/api/v1/tiles/")):
        raise SystemExit(f"production-hardening-gates: versioned redaction missing in {nginx_path}")
    if re.search(r"^\s*~\^/(?:api|s)/", nginx, re.MULTILINE):
        raise SystemExit(
            f"production-hardening-gates: sensitive redaction must be case-insensitive in {nginx_path}"
        )

    map_match = re.search(
        r"map\s+\$uri\s+\$loggable_uri\s*\{(?P<body>.*?)^\s*\}",
        nginx,
        re.DOTALL | re.MULTILINE,
    )
    if map_match is None:
        raise SystemExit(f"production-hardening-gates: loggable URI map missing in {nginx_path}")

    rules = []
    for modifier, pattern, replacement in re.findall(
        r'^\s*(~\*|~)(\S+)\s+"([^"]+)";',
        map_match.group("body"),
        re.MULTILINE,
    ):
        flags = re.IGNORECASE if modifier == "~*" else 0
        rules.append((re.compile(pattern, flags), replacement))

    for canary_path in (
        "/API/V1/S/canary-link/shards/canary-shard",
        "/Api/V1/Albums/canary-album",
        "/API/V1/MANIFESTS/canary-manifest",
        "/Api/V1/Shards/canary-shard",
        "/API/V1/SHARE-LINKS/canary-link",
        "/API/V1/FILES/canary-upload",
        "/api/V1/Tiles/12/2200/1400.png",
        "/API/V1/SHARED/canary-album/photos",
        "/Api/V1/Users/canary-user",
        "/API/V1/USERS/BY-PUBKEY/canary-pubkey",
        "/API/V1/AUTH/SESSIONS/canary-session",
        "/API/V1/ADMIN/USERS/canary-user",
        "/API/V1/ADMIN/ALBUMS/canary-album",
        "/API/V1/SIDECAR/SIGNAL/canary-room",
        "/API/V1/SIDECAR/CLOSE/canary-room",
        "/API/S/canary-link/shards/canary-shard",
        "/Api/Albums/canary-album",
        "/API/MANIFESTS/canary-manifest",
        "/Api/Shards/canary-shard",
        "/API/SHARE-LINKS/canary-link",
        "/S/canary-link",
    ):
        redacted = next(
            (replacement for pattern, replacement in rules if pattern.search(canary_path)),
            canary_path,
        )
        if "canary" in redacted or "<redacted>" not in redacted:
            raise SystemExit(
                f"production-hardening-gates: mixed-case canary leaked in {nginx_path}: "
                f"{canary_path} -> {redacted}"
            )
    if "$http_referer" in nginx:
        raise SystemExit(f"production-hardening-gates: raw Referer can leak identifiers in {nginx_path}")
    for directive in re.findall(r'add_header Content-Security-Policy "([^"]+)"', nginx):
        script_src = directive.split("style-src", 1)[0]
        if "'unsafe-eval'" in script_src:
            raise SystemExit(f"production-hardening-gates: general unsafe-eval remains in {nginx_path}")

for token in ("IAuditSinkHealthProbe", 'dependency = "audit-sink"'):
    if token not in health:
        raise SystemExit(f"production-hardening-gates: audit readiness check missing: {token}")
if "mosaic_audit_sink_healthy" not in metrics:
    raise SystemExit("production-hardening-gates: audit sink health metric missing")

if "from 'fts5-sql-bundle'" not in db_worker and 'from "fts5-sql-bundle"' not in db_worker:
    raise SystemExit("production-hardening-gates: DB worker must import the packaged SQL module")
if "new Function" in db_worker:
    raise SystemExit("production-hardening-gates: DB worker reintroduced runtime JavaScript evaluation")
if "const files = ['sql-wasm.wasm']" not in copy_sql or "fs.unlinkSync(obsoleteLoader)" not in copy_sql:
    raise SystemExit("production-hardening-gates: postinstall must copy only WASM and delete the legacy evaluated loader")

# Historical v1 unwrap compatibility stays in Rust, but neither v1 writer may
# be callable from production WASM or any worker facade.
for binding in (
    "#[wasm_bindgen(js_name = createLinkShareHandle)]",
    "#[wasm_bindgen(js_name = wrapLinkTierHandle)]",
):
    if binding in wasm_source:
        raise SystemExit(
            f"production-hardening-gates: legacy v1 link writer is exported from WASM source: {binding}"
        )
for label, text, pattern in (
    ("generated WASM declarations", wasm_types, r"export function createLinkShareHandle\("),
    ("generated WASM output type", wasm_types, r"readonly createLinkShareHandle:"),
    ("generated WASM JavaScript", wasm_js, r"export function createLinkShareHandle\("),
    ("generated WASM declarations", wasm_types, r"export function wrapLinkTierHandle\("),
    ("generated WASM output type", wasm_types, r"readonly wrapLinkTierHandle:"),
    ("generated WASM JavaScript", wasm_js, r"export function wrapLinkTierHandle\("),
    ("worker contract", worker_types, r"(?m)^\s*createLinkShareHandle\s*\("),
    ("Rust facade", rust_crypto_core, r"(?m)^\s*createLinkShareHandle\s*\("),
    ("Comlink worker", crypto_worker, r"(?m)^\s*async\s+createLinkShareHandle\s*\("),
    ("worker contract", worker_types, r"(?m)^\s*wrapLinkTierHandle\s*\("),
    ("Rust facade", rust_crypto_core, r"(?m)^\s*wrapLinkTierHandle\s*\("),
    ("Comlink worker", crypto_worker, r"(?m)^\s*async\s+wrapLinkTierHandle\s*\("),
):
    if re.search(pattern, text):
        raise SystemExit(f"production-hardening-gates: legacy v1 link writer remains in {label}")
for label, text, token in (
    ("WASM source", wasm_source, "#[wasm_bindgen(js_name = createLinkShareHandleV2)]"),
    ("generated WASM declarations", wasm_types, "export function createLinkShareHandleV2("),
    ("worker contract", worker_types, "createLinkShareHandleV2("),
    ("WASM source", wasm_source, "#[wasm_bindgen(js_name = wrapLinkTierHandleV2)]"),
    ("generated WASM declarations", wasm_types, "export function wrapLinkTierHandleV2("),
    ("worker contract", worker_types, "wrapLinkTierHandleV2("),
):
    if token not in text:
        raise SystemExit(f"production-hardening-gates: AAD-bound v2 link writer missing from {label}: {token}")

producer_roots = (Path("apps/web/src/hooks"), Path("apps/web/src/lib"))
legacy_calls = []
for root in producer_roots:
    for path in root.rglob("*.ts"):
        if "__tests__" in path.parts or path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"\.(?:createLinkShareHandle|wrapLinkTierHandle)\s*\(", text):
            legacy_calls.append(str(path))
if legacy_calls:
    raise SystemExit(
        "production-hardening-gates: legacy link writer used by production client: "
        + ", ".join(legacy_calls)
    )

if "--migrate-only" not in program:
    raise SystemExit("production-hardening-gates: explicit one-shot migration mode missing")

print("production-hardening-gates: OK (deployment, auth, privacy, audit, CSP, and protocol boundaries are fail-closed)")
PY
