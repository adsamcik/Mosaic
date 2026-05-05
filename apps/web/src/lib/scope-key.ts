/**
 * Tray scope key derivation (TS counterpart to `crates/mosaic-client/src/download/scope.rs`).
 *
 * Partitions the download tray so jobs created under one identity (auth user,
 * share-link visitor, legacy migration) are not visible to another identity
 * sharing the same browser/storage.
 *
 * Format: `<prefix>:<32-hex-chars>` where prefix is `auth`/`visitor`/`legacy`.
 *
 * Derivation MUST stay byte-for-byte identical to the Rust side:
 *   - BLAKE2b-128 (16-byte output) via libsodium `crypto_generichash`.
 *   - Auth:    H(accountId || domainTag)
 *   - Visitor: H(linkId || 0x00 || (grantToken ?? "") || domainTag)
 *   - Legacy:  prefixed with the literal lower-case hex of the 16-byte job id.
 *
 * # ZK-safety
 *
 * Only the `<prefix>:` portion is safe to log. The 32-hex tail is a
 * pseudonymous handle for storage partitioning; treat it as opaque.
 */

import sodium from 'libsodium-wrappers-sumo';

/**
 * Domain-separation tag burnt into every scope-key derivation. Bumping the
 * `vN` suffix invalidates every persisted scope key in the field. Must match
 * `DOMAIN_TAG` in `crates/mosaic-client/src/download/scope.rs`.
 */
const DOMAIN_TAG = 'mosaic-tray-scope-v1';

const SCOPE_KEY_BYTES = 16;

/** Resolves once libsodium is ready; safe to call repeatedly. */
export async function ensureScopeKeySodiumReady(): Promise<void> {
  await sodium.ready;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Derive an authenticated-user scope key from a non-secret account identifier.
 *
 * **Precondition:** caller has awaited {@link ensureScopeKeySodiumReady}.
 */
export function deriveAuthScopeKey(accountId: string): string {
  const enc = new TextEncoder();
  const input = concatBytes([enc.encode(accountId), enc.encode(DOMAIN_TAG)]);
  const digest = sodium.crypto_generichash(SCOPE_KEY_BYTES, input);
  return `auth:${toHex(digest)}`;
}

/**
 * Derive a share-link visitor scope key from `linkId` and an optional
 * per-grant token. `grantToken` of `null`/`undefined` and `""` collapse to the
 * same per-link scope, matching `derive_visitor_scope` in Rust.
 *
 * **Precondition:** caller has awaited {@link ensureScopeKeySodiumReady}.
 */
export function deriveVisitorScopeKey(
  linkId: string,
  grantToken: string | null | undefined,
): string {
  const enc = new TextEncoder();
  const input = concatBytes([
    enc.encode(linkId),
    new Uint8Array([0x00]),
    enc.encode(grantToken ?? ''),
    enc.encode(DOMAIN_TAG),
  ]);
  const digest = sodium.crypto_generichash(SCOPE_KEY_BYTES, input);
  return `visitor:${toHex(digest)}`;
}

/**
 * Synthesize a stable per-job legacy scope (matches `legacy_scope_for` in
 * Rust). `jobIdHex` is the 32-hex rendering of the 16-byte job id.
 */
export function legacyScopeKey(jobIdHex: string): string {
  return `legacy:${jobIdHex}`;
}

/** Return the prefix portion of a scope key (`auth`/`visitor`/`legacy`/`""`). */
export function scopeKeyPrefix(scopeKey: string): string {
  const colon = scopeKey.indexOf(':');
  return colon < 0 ? '' : scopeKey.slice(0, colon);
}