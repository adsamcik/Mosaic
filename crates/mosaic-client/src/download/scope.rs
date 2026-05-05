//! Tray scope key derivation for download jobs.
//!
//! A *scope key* partitions the download tray so that jobs created under
//! one identity (authenticated user, share-link visitor, legacy migration)
//! are not visible to another identity sharing the same browser/storage.
//!
//! Keys are stable, deterministic, and domain-separated via BLAKE2b-128
//! over non-secret inputs. The format is `<prefix>:<32-hex-chars>` where
//! the prefix is one of `auth`, `visitor`, or `legacy`.
//!
//! # ZK-safety
//!
//! Only the *prefix* (`auth`/`visitor`/`legacy`) is safe to emit in logs
//! or telemetry. The 32-hex tail is derived from non-secret inputs but
//! functions as a pseudonymous handle for storage partitioning; callers
//! MUST treat it as opaque and MUST NOT log it.

use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};

use crate::download::snapshot::JobId;

/// Domain-separation tag burnt into every scope-key derivation. Bumping the
/// `vN` suffix here invalidates every persisted scope key in the field.
const DOMAIN_TAG: &[u8] = b"mosaic-tray-scope-v1";

/// Error returned by scope-key derivation. Only surfaces if the underlying
/// BLAKE2b implementation rejects the (statically valid) 16-byte output
/// length, which should not happen on supported targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeError {
    DigestUnavailable,
}

/// Derive the authenticated-user scope key for the given non-secret account
/// identifier (a UUID string in current usage).
pub fn derive_auth_scope(account_id: &str) -> Result<String, ScopeError> {
    let mut hasher = Blake2bVar::new(16).map_err(|_| ScopeError::DigestUnavailable)?;
    hasher.update(account_id.as_bytes());
    hasher.update(DOMAIN_TAG);
    let mut out = [0_u8; 16];
    hasher
        .finalize_variable(&mut out)
        .map_err(|_| ScopeError::DigestUnavailable)?;
    Ok(format!("auth:{}", to_hex(&out)))
}

/// Derive the share-link visitor scope key. `grant_token` of `None` and
/// `Some("")` collapse to the same per-link scope (a stable handle even
/// for ungated links).
pub fn derive_visitor_scope(
    link_id: &str,
    grant_token: Option<&str>,
) -> Result<String, ScopeError> {
    let mut hasher = Blake2bVar::new(16).map_err(|_| ScopeError::DigestUnavailable)?;
    hasher.update(link_id.as_bytes());
    hasher.update(&[0_u8]);
    hasher.update(grant_token.unwrap_or("").as_bytes());
    hasher.update(DOMAIN_TAG);
    let mut out = [0_u8; 16];
    hasher
        .finalize_variable(&mut out)
        .map_err(|_| ScopeError::DigestUnavailable)?;
    Ok(format!("visitor:{}", to_hex(&out)))
}

/// Synthesize a stable per-job legacy scope for snapshots persisted before
/// the v2 schema bump. The tail is the job id rendered as lower-case hex.
#[must_use]
pub fn legacy_scope_for(job_id: &JobId) -> String {
    format!("legacy:{}", to_hex(job_id.as_bytes()))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(scope: &str) -> (&str, &str) {
        let mut parts = scope.splitn(2, ':');
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
    }

    #[test]
    fn auth_scope_is_deterministic() {
        let a = derive_auth_scope("11111111-2222-3333-4444-555555555555").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_auth_scope("11111111-2222-3333-4444-555555555555").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_eq!(a, b);
    }

    #[test]
    fn auth_scope_has_prefix_and_hex_tail() {
        let scope = derive_auth_scope("11111111-2222-3333-4444-555555555555").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let (prefix, tail) = split(&scope);
        assert_eq!(prefix, "auth");
        assert_eq!(tail.len(), 32);
        assert!(tail.chars().all(|character| character.is_ascii_digit()
            || ('a'..='f').contains(&character)));
    }

    #[test]
    fn auth_scopes_for_different_accounts_differ() {
        let a = derive_auth_scope("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_auth_scope("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_ne!(a, b);
    }

    #[test]
    fn visitor_scope_is_deterministic_and_prefixed() {
        let a = derive_visitor_scope("link-1", Some("grant-x")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_visitor_scope("link-1", Some("grant-x")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_eq!(a, b);
        let (prefix, tail) = split(&a);
        assert_eq!(prefix, "visitor");
        assert_eq!(tail.len(), 32);
    }

    #[test]
    fn visitor_scope_none_and_empty_grant_collapse() {
        let none = derive_visitor_scope("link-1", None).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let empty = derive_visitor_scope("link-1", Some("")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_eq!(none, empty);
    }

    #[test]
    fn visitor_scopes_for_different_links_differ() {
        let a = derive_visitor_scope("link-a", None).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_visitor_scope("link-b", None).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_ne!(a, b);
    }

    #[test]
    fn visitor_scopes_for_different_grants_differ() {
        let a = derive_visitor_scope("link-1", Some("grant-a")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_visitor_scope("link-1", Some("grant-b")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_ne!(a, b);
    }

    #[test]
    fn auth_and_visitor_scopes_with_same_input_differ() {
        let a = derive_auth_scope("link-1").unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let v = derive_visitor_scope("link-1", None).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_ne!(a, v);
        assert_ne!(split(&a).1, split(&v).1);
    }

    #[test]
    fn legacy_scope_renders_full_job_id() {
        let job_id = JobId::from_bytes([0x12; 16]);
        let scope = legacy_scope_for(&job_id);
        assert_eq!(scope, format!("legacy:{}", "12".repeat(16)));
    }

    #[test]
    fn visitor_grant_does_not_alias_link_id_concat() {
        let a = derive_visitor_scope("ab", Some("c")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        let b = derive_visitor_scope("a", Some("bc")).unwrap_or_else(|_| panic!("scope derivation should succeed"));
        assert_ne!(a, b);
    }
}

