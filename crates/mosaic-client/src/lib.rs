//! Client orchestration boundary crate for Mosaic upload and sync state machines.

#![forbid(unsafe_code)]

/// Returns the crate name for smoke tests and FFI wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-client"
}

/// Returns the domain protocol version this client crate is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_crypto::protocol_version()
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_crypto_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
