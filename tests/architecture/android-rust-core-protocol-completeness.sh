#!/usr/bin/env bash
# Android protocol-class Rust core completeness guard.
#
# Scans production Kotlin under apps/android-main/src/main for crypto primitives
# that must route through Rust core/UniFFI helpers. Local-only non-protocol uses
# remain allowlisted explicitly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

root = Path("apps/android-main/src/main")
if not root.exists():
    raise SystemExit("Missing Android main tree: apps/android-main/src/main")

message_digest_allowlist = {
    "apps/android-main/src/main/kotlin/org/mosaic/android/main/media/BitmapTierEncoder.kt",
    "apps/android-main/src/main/kotlin/org/mosaic/android/main/work/AutoImportWorkPolicy.kt",
    "apps/android-main/src/main/kotlin/org/mosaic/android/main/tus/TusUploadSession.kt",
}

secure_random_allowlist = {
    "apps/android-main/src/main/kotlin/org/mosaic/android/main/reducer/UploadJobReducer.kt",
}

rules = [
    (
        "javax-crypto-import",
        re.compile(r"^\s*import\s+javax\.crypto\.", re.M),
        "direct javax.crypto imports must not bypass Rust core/UniFFI",
        None,
    ),
    (
        "java-security-key-import",
        re.compile(r"^\s*import\s+java\.security\.(Signature|KeyPairGenerator|KeyFactory|KeyAgreement)\b", re.M),
        "direct key/signature primitives must not bypass Rust core/UniFFI",
        None,
    ),
    (
        "third-party-crypto-import",
        re.compile(
            r"^\s*import\s+(com\.lambdapioneer\.argon2kt|org\.libsodium|com\.goterl\.lazysodium|org\.bouncycastle|com\.google\.crypto\.tink|org\.conscrypt)\b",
            re.M,
        ),
        "third-party crypto libraries must not bypass Rust core/UniFFI",
        None,
    ),
    (
        "message-digest-sha",
        re.compile(r"\bMessageDigest\.getInstance\s*\("),
        "protocol-class SHA-256 must use Rust core/UniFFI helpers",
        message_digest_allowlist,
    ),
    (
        "secure-random",
        re.compile(r"\bSecureRandom\b"),
        "protocol-class randomness must use Rust core/UniFFI helpers",
        secure_random_allowlist,
    ),
]

negative_fixtures = {
    "javax-crypto-import": ("import javax.crypto.Cipher\n", "javax-crypto-import"),
    "java-security-signature-import": ("import java.security.Signature\n", "java-security-key-import"),
    "java-security-keypair-import": ("import java.security.KeyPairGenerator\n", "java-security-key-import"),
    "third-party-argon2-import": ("import com.lambdapioneer.argon2kt.Argon2Kt\n", "third-party-crypto-import"),
    "third-party-libsodium-import": ("import org.libsodium.jni.Sodium\n", "third-party-crypto-import"),
    "third-party-lazysodium-import": ("import com.goterl.lazysodium.SodiumAndroid\n", "third-party-crypto-import"),
    "third-party-bouncycastle-import": ("import org.bouncycastle.crypto.Digest\n", "third-party-crypto-import"),
    "third-party-tink-import": ("import com.google.crypto.tink.Aead\n", "third-party-crypto-import"),
    "third-party-conscrypt-import": ("import org.conscrypt.Conscrypt\n", "third-party-crypto-import"),
    "message-digest": ('MessageDigest.getInstance("SHA-256")\n', "message-digest-sha"),
    "secure-random": ("private val rng = SecureRandom()\n", "secure-random"),
}


def add_violations(repo_path: str, text: str, violations: list[str], enforce_allowlists: bool) -> None:
    for label, pattern, message, allowlist in rules:
        if enforce_allowlists and allowlist is not None and repo_path in allowlist:
            continue
        for match in pattern.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            line = text.splitlines()[line_no - 1].strip() if text.splitlines() else ""
            violations.append(f"{repo_path}:{line_no}: forbidden {label}: {message} -> {line}")


for fixture_name, (source, expected_label) in negative_fixtures.items():
    fixture_violations: list[str] = []
    add_violations(f"tests/architecture/negative-fixtures/{fixture_name}.kt", source, fixture_violations, False)
    if not any(f"forbidden {expected_label}:" in violation for violation in fixture_violations):
        raise SystemExit(
            f"android-rust-core-protocol-completeness negative fixture '{fixture_name}' was not caught"
        )

violations: list[str] = []
for kt_file in root.rglob("*.kt"):
    repo_path = kt_file.as_posix()
    text = kt_file.read_text(encoding="utf-8")
    add_violations(repo_path, text, violations, True)

if violations:
    print("android-rust-core-protocol-completeness guard FAILED:")
    for violation in sorted(set(violations)):
        print(f"  {violation}")
    print()
    print("Production Android protocol crypto must route through Rust core/UniFFI helpers.")
    raise SystemExit(1)

print(
    "android-rust-core-protocol-completeness guard: OK "
    f"(MessageDigest allowlist={len(message_digest_allowlist)}, SecureRandom allowlist={len(secure_random_allowlist)})"
)
PY
