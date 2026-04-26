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
