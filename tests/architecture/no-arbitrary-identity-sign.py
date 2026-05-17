#!/usr/bin/env python3
"""Architecture guard: no-arbitrary-identity-sign (v1.0.1 f14-1).

Shared logic for both the .sh and .ps1 wrappers. See
tests/architecture/no-arbitrary-identity-sign.sh for the full threat model.

Run from the repository root (the wrappers chdir for us).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

FFI_SOURCES = [
    Path("crates/mosaic-wasm/src/lib.rs"),
    Path("crates/mosaic-uniffi/src/lib.rs"),
    Path("crates/mosaic-client/src/lib.rs"),
]

# Allowlist: exact function NAMES that are permitted to (transitively) reach
# the identity Ed25519 signing key with a caller-supplied byte buffer. Each
# entry MUST carry an explicit domain-separation rationale.
ALLOWED_FN: dict[str, str] = {
    "sign_manifest_with_identity": (
        'DOMAIN-PREFIXED: v1.0.1 f14-1 prepends MANIFEST_SIGN_CONTEXT '
        '(b"Mosaic_Manifest_v1") internally in mosaic_crypto so signatures '
        'from this oracle cannot be substituted for BUNDLE_SIGN_CONTEXT or '
        'any other domain-prefixed identity-signed payload.'
    ),
    "sign_manifest_with_identity_js": (
        'DOMAIN-PREFIXED: thin JS wrapper around sign_manifest_with_identity; '
        'same MANIFEST_SIGN_CONTEXT prefix applies.'
    ),
}

PUB_FN_RE = re.compile(
    r"^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]*sign[A-Za-z0-9_]*identity[A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)


def main() -> int:
    violations: list[str] = []

    for path in FFI_SOURCES:
        if not path.exists():
            violations.append(f"missing FFI source: {path}")
            continue
        text = path.read_text(encoding="utf-8")
        for match in PUB_FN_RE.finditer(text):
            fn_name = match.group(1)
            if fn_name in ALLOWED_FN:
                continue
            line_no = text.count("\n", 0, match.start()) + 1
            violations.append(
                f"{path}:{line_no}: public FFI export `{fn_name}` matches the "
                f"identity-signing shape but is not in the allowlist. If this "
                f"is a new domain-separated signing path, add it to "
                f"ALLOWED_FN in tests/architecture/no-arbitrary-identity-sign.py "
                f"with an explicit rationale (see v1.0.1 f14-1)."
            )

    # Cross-check: allowlisted entries MUST actually be exported somewhere.
    combined = "\n".join(p.read_text(encoding="utf-8") for p in FFI_SOURCES if p.exists())
    for fn_name in ALLOWED_FN:
        if not re.search(rf"\bpub\s+(?:async\s+)?fn\s+{re.escape(fn_name)}\s*\(", combined):
            violations.append(
                f"allowlist drift: `{fn_name}` is in ALLOWED_FN but no longer "
                f"exported from any FFI source. Remove it from the allowlist."
            )

    # Invariant 1: MANIFEST_SIGN_CONTEXT constant locked.
    lib_rs = Path("crates/mosaic-crypto/src/lib.rs").read_text(encoding="utf-8")
    if 'MANIFEST_SIGN_CONTEXT: &[u8] = b"Mosaic_Manifest_v1"' not in lib_rs:
        violations.append(
            "crates/mosaic-crypto/src/lib.rs: MANIFEST_SIGN_CONTEXT constant "
            "is missing or has the wrong value. v1.0.1 f14-1 locks it to "
            'b"Mosaic_Manifest_v1" so cross-platform signatures remain '
            "verifiable. Changing this value is a protocol-breaking change."
        )

    # Invariant 2: sign/verify both apply MANIFEST_SIGN_CONTEXT.
    sign_fn = re.search(
        r"pub fn sign_manifest_with_identity\([^{]*\{.*?\n\}",
        lib_rs,
        re.DOTALL,
    )
    if not sign_fn or "MANIFEST_SIGN_CONTEXT" not in sign_fn.group(0):
        violations.append(
            "crates/mosaic-crypto/src/lib.rs: sign_manifest_with_identity no "
            "longer references MANIFEST_SIGN_CONTEXT. The domain prefix MUST "
            "be applied inside the signing function (v1.0.1 f14-1) so every "
            "FFI caller gets it automatically."
        )
    verify_fn = re.search(
        r"pub fn verify_manifest_identity_signature\([^{]*\{.*?\n\}",
        lib_rs,
        re.DOTALL,
    )
    if not verify_fn or "MANIFEST_SIGN_CONTEXT" not in verify_fn.group(0):
        violations.append(
            "crates/mosaic-crypto/src/lib.rs: verify_manifest_identity_signature "
            "no longer references MANIFEST_SIGN_CONTEXT. Sign and verify MUST "
            "stay symmetric (v1.0.1 f14-1)."
        )

    # Invariant 3: bundle path must NOT route through sign_manifest_with_identity.
    sharing_rs = Path("crates/mosaic-crypto/src/sharing.rs").read_text(encoding="utf-8")
    # Strip Rust line comments before pattern-matching so allowlisted bypass
    # rationales in `//` comments don't false-positive the guard.
    line_comment_re = re.compile(r"//[^\n]*")
    for label in ("seal_and_sign_bundle", "verify_and_open_bundle"):
        m = re.search(
            rf"pub fn {label}\b[^{{]*\{{(?P<body>.*?)\n\}}",
            sharing_rs,
            re.DOTALL,
        )
        if not m:
            violations.append(
                f"crates/mosaic-crypto/src/sharing.rs: could not locate "
                f"`{label}` for arch-guard analysis. The guard must be "
                f"updated if the function was renamed."
            )
            continue
        body = line_comment_re.sub("", m.group("body"))
        if (
            "sign_manifest_with_identity" in body
            or "verify_manifest_identity_signature" in body
        ):
            violations.append(
                f"crates/mosaic-crypto/src/sharing.rs: `{label}` references "
                f"the prefix-adding manifest signing function. v1.0.1 f14-1 "
                f"REQUIRES the bundle path to bypass that function and "
                f"sign/verify Ed25519 directly over `BUNDLE_SIGN_CONTEXT || "
                f"sealed`, otherwise an FFI caller can forge bundle "
                f"signatures by passing `BUNDLE_SIGN_CONTEXT || "
                f"<crafted-sealed>` to sign_manifest_with_identity."
            )

    if violations:
        print("no-arbitrary-identity-sign: FAIL", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nGuard rationale: prevents identity Ed25519 signing-oracle "
            "regressions (v1.0.1 f14-1). See header comment in "
            "tests/architecture/no-arbitrary-identity-sign.sh for the threat "
            "model.",
            file=sys.stderr,
        )
        return 1

    print("no-arbitrary-identity-sign: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
