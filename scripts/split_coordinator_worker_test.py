"""
Split coordinator.worker.test.ts into 4 files:
  - coordinator.worker.test.ts                       (core: outer describe minus inner describes)
  - coordinator.worker.visitor-reconstruct.test.ts   (inner describe @ L1140)
  - coordinator.worker.visitor-gc.test.ts            (inner describe @ L1208)
  - coordinator.worker.sidecar.test.ts               (inner describe @ L1247)

All four files share infrastructure via ./coordinator.worker.test-shared.ts.
Imports are trimmed per file to satisfy tsc's noUnusedLocals.
"""
import re
from pathlib import Path
from textwrap import dedent

ROOT = Path(r"C:\Users\adam-\GitHub\Mosaic")
TARGET = ROOT / "apps/web/src/workers/__tests__/coordinator.worker.test.ts"

src = TARGET.read_text(encoding="utf-8")
lines = src.split("\n")
assert len(lines) >= 1446, f"expected 1446+ lines, got {len(lines)}"

# 1-based line ranges of inner describes (inclusive of trailing closing brace line)
INNER = {
    "visitor-reconstruct": (1139, 1205),
    "visitor-gc":          (1207, 1245),
    "sidecar":             (1247, 1445),
}

# Sanity anchors
assert lines[444].startswith("describe('CoordinatorWorker'"), f"L445 = {lines[444]!r}"
assert lines[1139].lstrip().startswith("describe('visitor reconstruct"), f"L1140 = {lines[1139]!r}"
assert lines[1207].lstrip().startswith("describe('visitor GC"), f"L1208 = {lines[1207]!r}"
assert lines[1246].lstrip().startswith("describe('sidecar output mode"), f"L1247 = {lines[1246]!r}"
assert lines[1445] == "});", f"L1446 = {lines[1445]!r}"

VITEST_SYMBOLS = ["afterEach", "beforeEach", "describe", "expect", "it", "vi"]
TYPES_SYMBOLS = ["WorkerCryptoError", "WorkerCryptoErrorCode", "DownloadPhase", "LinkTierHandleId", "StartJobInput"]
SHARED_VALUE_SYMBOLS = [
    "rustMocks", "opfsState", "pipelineMocks", "cryptoPoolMocks", "broadcastState",
    "TestBroadcastChannel",
    "makeComlinkMock", "makeLoggerMock", "makeOpfsStagingMock",
    "albumId", "nowMs",
    "validInput", "snapshotBody", "transition", "encode", "parse", "requiredMapValue",
    "expectUint", "expectBytes", "uuidBytes", "phaseCode", "stateValue",
    "photoStatusValue", "readPhotoBytesWritten", "checksum",
    "readSnapshotPhase", "readSnapshotLastUpdatedAtMs", "eventKind",
    "startPreparingJob", "hex", "testJobIdBytes", "photoSpecs", "persistSnapshotJob",
    "registerCoordinatorHooks",
]
SHARED_TYPE_SYMBOLS = ["CborValue", "CborMapEntry", "TestPhotoStatus", "SnapshotPhotoSpec"]
COORD_VALUE_SYMBOLS = ["CoordinatorWorker"]  # plus `cbor` alias for __coordinatorWorkerTestUtils
COORD_OPFS_NAMESPACE = "opfsStaging"  # always used; conditionally trim
COORD_TYPES_SYMBOLS = ["SourceStrategy"]


def used_in(body: str, symbol: str) -> bool:
    """Return True if `symbol` appears in `body` as a value/type reference (not a property access or in a string literal)."""
    # Strip out single- and double-quoted string contents to avoid matching identifiers inside test names
    stripped = re.sub(r"'(?:[^'\\]|\\.)*'", "''", body)
    stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', stripped)
    # Match word boundary, but NOT preceded by a `.` (which would make it a property access)
    return re.search(rf"(?<![\.\w]){re.escape(symbol)}\b", stripped) is not None


def build_header(body: str) -> str:
    """Build the import / vi.mock / hook-register header for a test file
    that uses only the symbols actually referenced in `body`."""
    vitest_used = [s for s in VITEST_SYMBOLS if used_in(body, s)]
    # vi is always required for vi.mock(...) calls at top of file.
    if "vi" not in vitest_used:
        vitest_used.append("vi")

    types_used = [s for s in TYPES_SYMBOLS if used_in(body, s)]
    shared_vals = [s for s in SHARED_VALUE_SYMBOLS if used_in(body, s)]
    # Mock factories + registration are always needed.
    for must in ("makeComlinkMock", "makeLoggerMock", "makeOpfsStagingMock",
                 "rustMocks", "cryptoPoolMocks", "pipelineMocks",
                 "registerCoordinatorHooks"):
        if must not in shared_vals:
            shared_vals.append(must)
    shared_types = [s for s in SHARED_TYPE_SYMBOLS if used_in(body, s)]

    coord_vals = [s for s in COORD_VALUE_SYMBOLS if used_in(body, s)]
    if "cbor" not in coord_vals and used_in(body, "cbor"):
        coord_vals = coord_vals  # cbor is an alias, handled separately
    needs_opfs_staging = used_in(body, "opfsStaging")
    coord_types = [s for s in COORD_TYPES_SYMBOLS if used_in(body, s)]

    # Split vitest imports into value vs type
    type_keywords_in_types = []
    value_keywords_in_types = []
    for s in types_used:
        # All from ../types are value-exported; the type-only ones use `type` keyword:
        if s in ("DownloadPhase", "LinkTierHandleId", "StartJobInput"):
            type_keywords_in_types.append(f"type {s}")
        else:
            value_keywords_in_types.append(s)

    pieces = []
    pieces.append(f"import {{ {', '.join(vitest_used)} }} from 'vitest';")
    if types_used:
        merged = value_keywords_in_types + type_keywords_in_types
        pieces.append(f"import {{ {', '.join(merged)} }} from '../types';")
    if shared_vals:
        pieces.append("import {")
        for s in shared_vals:
            pieces.append(f"  {s},")
        pieces.append("} from './coordinator.worker.test-shared';")
    if shared_types:
        pieces.append("import type {")
        for s in shared_types:
            pieces.append(f"  {s},")
        pieces.append("} from './coordinator.worker.test-shared';")

    pieces.append("")
    pieces.append("vi.mock('comlink', () => makeComlinkMock());")
    pieces.append("vi.mock('../../lib/logger', () => makeLoggerMock());")
    pieces.append("vi.mock('../rust-crypto-core', () => rustMocks);")
    pieces.append("vi.mock('../crypto-pool', () => cryptoPoolMocks);")
    pieces.append("vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);")
    pieces.append("vi.mock('../../lib/opfs-staging', () => makeOpfsStagingMock());")
    pieces.append("")

    # Coordinator-worker imports (cbor alias is required to wire hooks)
    cbor_used = used_in(body, "cbor")
    coord_import_parts = []
    if "CoordinatorWorker" in coord_vals:
        coord_import_parts.append("CoordinatorWorker")
    coord_import_parts.append("__coordinatorWorkerTestUtils as cbor")
    pieces.append(f"import {{ {', '.join(coord_import_parts)} }} from '../coordinator.worker';")
    if needs_opfs_staging:
        pieces.append("import * as opfsStaging from '../../lib/opfs-staging';")
    if coord_types:
        pieces.append(f"import type {{ {', '.join(coord_types)} }} from '../coordinator/source-strategy';")

    pieces.append("")
    pieces.append("registerCoordinatorHooks(cbor);")
    pieces.append("")

    return "\n".join(pieces)


def extract(start1: int, end1: int) -> str:
    return "\n".join(lines[start1 - 1:end1])


def dedent_block(text: str, spaces: int = 2) -> str:
    prefix = " " * spaces
    return "\n".join(
        ln[spaces:] if ln.startswith(prefix) else ln
        for ln in text.split("\n")
    )


# Build inner-describe files
inner_outputs = {}
for name, (s, e) in INNER.items():
    body = dedent_block(extract(s, e), 2)
    header = build_header(body)
    inner_outputs[name] = header + body + "\n"

# Build core file
core_body = extract(444, 1138) + "\n});\n"
core_output = build_header(core_body) + core_body

out_dir = TARGET.parent
file_map = {
    "coordinator.worker.test.ts": core_output,
    "coordinator.worker.visitor-reconstruct.test.ts": inner_outputs["visitor-reconstruct"],
    "coordinator.worker.visitor-gc.test.ts": inner_outputs["visitor-gc"],
    "coordinator.worker.sidecar.test.ts": inner_outputs["sidecar"],
}

for fname, content in file_map.items():
    path = out_dir / fname
    path.write_text(content, encoding="utf-8")
    print(f"wrote {fname}: {content.count(chr(10))} lines")

