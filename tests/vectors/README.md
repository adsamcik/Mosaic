# Golden Vector Fixtures

Golden vectors are the coordination mechanism for Mosaic's Rust client-core rework. They define byte-level expected behavior for canonical encoding, key derivation, envelope encryption/parsing, manifest signing, FFI error mapping, and upload/sync state-machine transitions.

The fixture format is defined in [golden-vector.schema.json](golden-vector.schema.json). The schema is intentionally operation-agnostic so the same runner can validate native Rust, WASM worker, Android UniFFI, and temporary TypeScript reference implementations.

## Fixture rules

- Every fixture has a stable `schemaVersion` and `operation`.
- Operation names use dot-separated lowercase namespaces, for example `envelope.encrypt.v1`.
- Binary values are encoded as lowercase hex or base64url without padding, declared by field name.
- Expected failures use stable Mosaic error codes, not platform exception messages.
- Security-sensitive transcripts must identify their domain labels.
- Server-bound outputs include a leakage classification.
- Forbidden plaintext fields are listed in `forbiddenServerOutputs`; runners must fail if those names appear in server-bound outputs, expected outputs, serialized request fields, or captured logs.
- Vectors must be generated from deterministic test inputs only. Production randomness is never replaced by deterministic randomness outside test configuration.
- Media fixture files must be generated, public-domain, or test-licensed.

## Initial runner targets

1. Native Rust vector runner in `mosaic-crypto`/`mosaic-domain`.
2. WASM worker vector runner through `mosaic-wasm`.
3. Android instrumentation or JVM vector runner through `mosaic-uniffi`.
4. Temporary TypeScript reference runner until cross-client interoperability passes.

The example fixture in `examples/golden-vector-format-example.json` validates the shape of the fixture format and is not a cryptographic correctness vector.

## Regenerating and verifying the corpus

The 22 `tests/vectors/*.json` fixtures are **canonical reference vectors authored
by hand** against the TypeScript / libsodium reference implementation. They are
**not** auto-generated from a script — there is no general regeneration path
that recomputes their expected outputs, because the JSON files themselves
*define* the cross-client byte-level contract.

A small subset of the corpus is, however, programmatically derived:

| Artefact | Generator |
|----------|-----------|
| `crates/mosaic-crypto/tests/sharing_vector.rs.inc` | `scripts/dump-bundle-vector.mjs` (run via `libs/crypto/`) |

To verify the committed corpus is byte-identical with the canonical references,
run the deterministic regenerator script. It regenerates the auto-generated
artefacts, runs the Rust cross-client parity tests (`mosaic-vectors`,
`mosaic-uniffi`, `mosaic-parity-tests`), and asserts no drift via
`git diff --exit-code`:

```bash
# Linux / macOS
./scripts/regenerate-test-vectors.sh

# Windows
.\scripts\regenerate-test-vectors.ps1

# Or directly
node scripts/regenerate-test-vectors.mjs
```

CI invokes this script with `--check` to enforce bit-identity on every push.

### Authoring a new fixture

Adding a new `tests/vectors/<name>.json` corpus entry is a manual workflow:

1. Pick deterministic inputs (fixed seeds, fixed plaintexts, fixed nonces).
2. Compute the expected outputs against the canonical reference
   (libsodium / TS or the protocol's designated `rust_canonical` source).
3. Author the JSON fixture and add a consumer in `crates/mosaic-vectors`,
   `crates/mosaic-uniffi/tests/cross_client_vectors.rs`, the web cross-client
   tests, and the Android `CrossClientVectorTest` driver.
4. Run `./scripts/regenerate-test-vectors.sh` to confirm every client
   reproduces the captured bytes.

