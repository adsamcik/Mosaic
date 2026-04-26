//! Gated media processing boundary crate for Mosaic.

#![forbid(unsafe_code)]

/// Returns the crate name for smoke tests and media prototype diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-media"
}

/// Returns the domain protocol version this media crate is compiled against.
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
