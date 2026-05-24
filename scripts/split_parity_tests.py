#!/usr/bin/env python3
"""One-shot splitter for cross_platform_parity.rs.

Splits the 3200-line monolithic integration test file into:
  - tests/common/mod.rs (shared helpers, constants, imports)
  - tests/cross_platform_parity_*.rs (one per test domain)

The script is idempotent only against the original file: if run again
after the original has been removed, it exits with an error.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "crates" / "mosaic-parity-tests" / "tests" / "cross_platform_parity.rs"
TESTS_DIR = SRC.parent
COMMON_DIR = TESTS_DIR / "common"

# Inclusive 1-based line where the test region begins (first #[test])
TEST_REGION_START = 76
# Inclusive 1-based line where the helper region begins (after the last test's })
HELPER_REGION_START = 2026  # `fn encoded_manifest_shards` starts here

# Mapping: list of (start_line, end_line_inclusive, file_suffix) covering tests.
# Computed by reading the file and finding #[test] boundaries; pre-derived
# here so that the script remains a deterministic specification.
DOMAIN_RANGES = [
    # key_derivation (12 tests, split by line range, skipping the share_link test)
    ("key_derivation", [(76, 203), (235, 445)]),
    # share_links (4 tests)
    ("share_links", [(204, 234), (446, 582)]),
    # signing (4 tests)
    ("signing", [(583, 750)]),
    # encryption (8 tests)
    ("encryption", [(751, 1183)]),
    # hashing (8 tests including the 3 existing proptest fns)
    ("hashing", [(1184, 1453)]),
    # state_reducers (5 tests)
    ("state_reducers", [(1454, 1701)]),
    # envelope (7 tests: streaming + sealed bundle + sidecar + mime)
    ("envelope", [(1702, 2024)]),
]


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source file not found: {SRC}")

    raw = SRC.read_text(encoding="utf-8")
    # `include_bytes!` paths in the original file are relative to the source
    # file's directory. After moving helpers into `tests/common/mod.rs`, every
    # such path needs one additional `../` segment to climb out of `common/`.
    raw = _rewrite_include_bytes_text(raw)
    lines = raw.splitlines(keepends=False)
    n = len(lines)

    # Sanity: assert first #[test] is at TEST_REGION_START
    if not lines[TEST_REGION_START - 1].startswith("#[test]"):
        raise SystemExit(
            f"expected #[test] at line {TEST_REGION_START}, got: {lines[TEST_REGION_START - 1]!r}"
        )
    if not lines[HELPER_REGION_START - 1].startswith("fn encoded_manifest_shards"):
        raise SystemExit(
            f"expected helper start at line {HELPER_REGION_START}, got: "
            f"{lines[HELPER_REGION_START - 1]!r}"
        )

    # ---- Build common/mod.rs ----
    header = lines[0:TEST_REGION_START - 1]   # L1..L75 (inclusive 1-based) -> 0..74
    helpers = lines[HELPER_REGION_START - 1:]  # L2026..end -> 2025..

    common_body = make_common(header, helpers)
    COMMON_DIR.mkdir(parents=True, exist_ok=True)
    (COMMON_DIR / "mod.rs").write_text(common_body, encoding="utf-8")

    # ---- Build per-domain test files ----
    file_header_template = (
        "// SPDX-License-Identifier: MIT\n"
        "// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files\n"
        "// split. Each split file exercises one domain of cross-facade parity tests.\n"
        "// See `tests/common/mod.rs` for shared imports, constants, and helpers.\n"
        "#![allow(clippy::expect_used)]\n"
        "\n"
        "mod common;\n"
        "use common::*;\n"
        "\n"
    )
    for suffix, ranges in DOMAIN_RANGES:
        body_parts: list[str] = []
        for (start, end) in ranges:
            chunk = "\n".join(lines[start - 1:end])
            body_parts.append(chunk)
        body = "\n\n".join(body_parts).rstrip() + "\n"
        out_path = TESTS_DIR / f"cross_platform_parity_{suffix}.rs"
        out_path.write_text(file_header_template + body, encoding="utf-8")
        print(f"wrote {out_path.relative_to(ROOT)} ({out_path.stat().st_size} bytes)")

    # ---- Remove original ----
    SRC.unlink()
    print(f"removed {SRC.relative_to(ROOT)}")
    print(f"wrote {(COMMON_DIR / 'mod.rs').relative_to(ROOT)} "
          f"({(COMMON_DIR / 'mod.rs').stat().st_size} bytes)")


def make_common(header: list[str], helpers: list[str]) -> str:
    """Combine header + helpers, adding `pub` visibility so split files can use them."""
    combined = list(header) + [""] + list(helpers)

    # Track struct ranges to add `pub` to fields and impl ranges for methods.
    struct_starts: list[tuple[int, str]] = []
    impl_starts: list[int] = []
    item_top_level_re = re.compile(r"^(fn |const |struct |enum |unsafe fn )")
    for idx, line in enumerate(combined):
        if line.startswith("use "):
            combined[idx] = "pub " + line
            continue
        m = item_top_level_re.match(line)
        if m:
            combined[idx] = "pub " + line
            if line.startswith("struct "):
                struct_starts.append((idx, line))
        elif line.startswith("impl ") or line.startswith("impl<"):
            impl_starts.append(idx)

    # Make impl-block methods `pub` so split test files can call them.
    for start_idx in impl_starts:
        i = start_idx + 1
        while i < len(combined):
            cur = combined[i]
            if cur.startswith("}"):
                break
            stripped = cur.lstrip()
            if stripped.startswith("fn "):
                indent = len(cur) - len(stripped)
                combined[i] = (" " * indent) + "pub " + stripped
            i += 1

    # For each struct, find its closing `}` at column 0 and add `pub` to fields.
    for start_idx, _line in struct_starts:
        # struct line might be `pub struct Name<'a> {`
        # find closing `}` at column 0
        i = start_idx + 1
        while i < len(combined):
            cur = combined[i]
            if cur.startswith("}"):
                break
            # field lines look like `    name: type,` — add pub before the name
            stripped = cur.lstrip()
            if stripped and not stripped.startswith("//") and not stripped.startswith("#["):
                indent = len(cur) - len(stripped)
                # Only add pub if it looks like an identifier: typed field
                # (matches `ident: ...` or `ident<...>: ...`)
                if re.match(r"[a-zA-Z_][a-zA-Z0-9_]*\s*:", stripped):
                    combined[i] = (" " * indent) + "pub " + stripped
            i += 1

    # Module header: keep the existing allow attributes from L1-3 but add doc.
    # The first three lines of `header` already include the allow lint.
    # Prepend a small module-level doc comment.
    doc = (
        "//! Shared fixtures, constants, and helper functions for the cross-platform\n"
        "//! parity integration tests. Lives under `tests/common/` so Cargo does NOT\n"
        "//! treat it as a standalone test binary; each split `tests/cross_platform_parity_*.rs`\n"
        "//! file pulls these in via `mod common;` + `use common::*;`.\n"
        "//!\n"
        "//! Items are marked `pub` so that they remain accessible from every split\n"
        "//! test binary that includes this module.\n"
        "#![allow(dead_code, unused_imports)]\n"
        "\n"
    )

    return doc + "\n".join(combined).rstrip() + "\n"


_INCLUDE_RE = re.compile(
    r'(include_bytes!\s*\(\s*")([^"]+)("\s*\))',
    re.DOTALL,
)


def _rewrite_include_bytes_text(text: str) -> str:
    """Add one extra `../` to every relative path embedded in `include_bytes!`.

    Handles paths broken across lines (`include_bytes!(\\n    "..."\\n)`).
    """
    def repl(m: re.Match[str]) -> str:
        prefix, path, suffix = m.group(1), m.group(2), m.group(3)
        if path.startswith("../"):
            path = "../" + path
        return f"{prefix}{path}{suffix}"
    return _INCLUDE_RE.sub(repl, text)


if __name__ == "__main__":
    main()
