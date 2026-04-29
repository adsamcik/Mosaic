# Cross-Client Vector Deviations

This file enumerates every Mosaic crypto operation where the **TypeScript reference** (`libs/crypto`) and the **Rust core** (`crates/mosaic-crypto`) currently produce different bytes for the same inputs. Each deviation is locked into the corpus as a TS-canonical vector so the divergence is regression-tested by the differential runner — closing a deviation requires the Rust side to match the captured TS bytes (or a deliberate flip of `rust_canonical: true` with a downstream client update).

The differential runner skips the Rust-side assertion for these vectors via `#[ignore = "deviation:<id> — ..."]`. Removing the `#[ignore]` is the gate for declaring a deviation closed.

| ID | Vector | TS algorithm | Rust algorithm | Closure plan |
|----|--------|--------------|----------------|--------------|
| `tier-key-wrap` | `tests/vectors/tier_key_wrap.json` | `crypto_secretbox` (XSalsa20-Poly1305) over `nonce \|\| ciphertext` | `XChaCha20-Poly1305` (AEAD trait) over `nonce \|\| ciphertext` | Decide which AEAD wins for v1; align both ends. Most likely path: switch Rust `wrap_key`/`unwrap_key` to the libsodium-compatible XSalsa20 path so existing share links keep resolving, since these wrapped tier keys are persisted server-side. |
| `auth-keypair` | `tests/vectors/auth_keypair.json` | `authSeed = BLAKE2b-256(msg = "Mosaic_AuthKey_v1" \|\| L0)` | `authSeed = HKDF-SHA256(salt = user_salt, info = "mosaic:auth-signing:v1", ikm = L0)` | Pick a single canonical KDF for the auth seed step. The TS form has shipped to users and rotating it invalidates registered auth pubkeys, so the safer cutover is to teach Rust the BLAKE2b form (it stays cleanly separated from the L0 → L1 chain). |
| `account-unlock` | `tests/vectors/account_unlock.json` | L1 = `BLAKE2b(BLAKE2b("Mosaic_AccountKey_v1", account_salt), BLAKE2b("Mosaic_RootKey_v1", L0))`; wrap = `crypto_secretbox` | L1 = `HKDF-SHA256(salt = account_salt, ikm = L0, info = "mosaic:root-key:v1")`; wrap = `XChaCha20-Poly1305` | Same dilemma as `tier-key-wrap`: shipped wrapped account keys live server-side. Rust must adopt the BLAKE2b L1 chain *and* XSalsa20 wrap or migrate user records before flipping. |
| `epoch-tier-keys` | `tests/vectors/epoch_derive.json` | `tierKey = BLAKE2b-256(key = epoch_seed, msg = "mosaic:tier:<tier>:v1")` | `tierKey = HKDF-SHA256(ikm = epoch_seed, info = "mosaic:tier:<tier>:v1")` | Tier keys are derived on demand from a sealed bundle, so a same-version cutover is feasible by switching Rust to BLAKE2b-keyed (or vice-versa) in lockstep with the WASM facade. The corpus locks the TS bytes via SHA-256 discriminators so neither side has to hold the actual key bytes. |

## Operation parity table

| Vector | Algorithm | TS bytes | Rust bytes | Status |
|--------|-----------|----------|------------|--------|
| `link_keys.json` | BLAKE2b-keyed | ✅ | ✅ | byte-exact |
| `link_secret.json` | OS CSPRNG (length-only) | ✅ | ✅ | length-only smoke |
| `tier_key_wrap.json` | wrap/unwrap | ✅ | ❌ | **deviation:tier-key-wrap** |
| `identity.json` | Ed25519 + X25519 | ✅ | ✅ | byte-exact |
| `content_encrypt.json` | XChaCha20-Poly1305 | ✅ | ✅ | byte-exact decrypt |
| `shard_envelope.json` | XChaCha20-Poly1305 (AAD = header) | ✅ | ✅ | byte-exact decrypt per tier |
| `auth_challenge.json` | Ed25519 over framed transcript | ✅ | ✅ | byte-exact transcript + sig |
| `auth_keypair.json` | seed → keypair | ✅ | ❌ | **deviation:auth-keypair** |
| `account_unlock.json` | L1 derivation + wrap | ✅ | ❌ | **deviation:account-unlock** |
| `epoch_derive.json` | tier-key derivation | ✅ | ❌ | **deviation:epoch-tier-keys** |
| `sealed_bundle.json` | Ed25519 verify + crypto_box_seal_open | ✅ | ✅ | byte-exact open |
| `manifest_transcript.json` | canonical transcript framing | n/a (TS lacks builder) | ✅ | Rust-canonical, TS skips with TODO ref Slice 0C |

## Procedure for closing a deviation

1. Decide which side is canonical and update the loser to match the captured bytes.
2. Run `cargo test -p mosaic-vectors --locked` and `npm --prefix libs/crypto run test:run -- cross-client-vectors`. Both sides must pass byte-exact.
3. Remove the `#[ignore = "deviation:<id> ..."]` attribute on the corresponding Rust differential test.
4. Delete the row from this file's deviation table and flip the parity-table entry to ✅.
5. Re-run the WASM and Android cross-client tests; expand them to cover the now-cross-compatible operation.

## Why these stay open after Slice 0B

Slice 0B's job is to **detect** drift, not to land migrations. The four deviations above are wired into the corpus and into the differential runner so they can no longer regress silently — every CI run will list them in the ignored set with their deviation IDs. Closing them belongs to slices 0C / 0D once the protocol direction is decided.
