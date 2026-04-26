//! Cryptographic boundary crate for the Mosaic Rust client core.

#![forbid(unsafe_code)]

/// Returns the crate name for smoke tests and FFI wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-crypto"
}

/// Returns the domain protocol version this crypto crate is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_domain::PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_domain_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
