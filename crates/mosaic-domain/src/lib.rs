//! Shared domain constants and types for the Mosaic Rust client core.

#![forbid(unsafe_code)]

/// Current pre-release Mosaic protocol version used by Rust client-core fixtures.
pub const PROTOCOL_VERSION: &str = "mosaic-v1";

/// Returns the crate name for smoke tests and FFI wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-domain"
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_protocol_version() {
        assert_eq!(super::PROTOCOL_VERSION, "mosaic-v1");
    }
}
