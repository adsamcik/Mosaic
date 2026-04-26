//! Cryptographic boundary crate for the Mosaic Rust client core.

#![forbid(unsafe_code)]

/// Crypto crate errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MosaicCryptoError {
    /// The FFI spike probe operation requires an explicit context label.
    EmptyContext,
}

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

/// Deterministic test-only derivation used by the FFI spike.
///
/// This is not production cryptography. Production KDF/encryption work lands in
/// the crypto-core phase with audited primitives and golden vectors.
pub fn test_only_derive_probe_key(
    input: &[u8],
    context: &[u8],
) -> Result<[u8; 32], MosaicCryptoError> {
    if context.is_empty() {
        return Err(MosaicCryptoError::EmptyContext);
    }

    let mut state = [
        0x6d6f_7361_6963_2d31_u64,
        0x6666_692d_7370_696b_u64,
        0x6465_7269_7665_2d31_u64,
        0x636f_6e74_6578_7421_u64,
    ];

    mix_bytes(&mut state, context);
    mix_byte(&mut state, 0xff);
    mix_bytes(&mut state, input);

    let mut output = [0_u8; 32];
    for (index, value) in state.iter().enumerate() {
        output[index * 8..(index + 1) * 8].copy_from_slice(&value.to_le_bytes());
    }
    Ok(output)
}

fn mix_bytes(state: &mut [u64; 4], bytes: &[u8]) {
    for byte in bytes {
        mix_byte(state, *byte);
    }
}

fn mix_byte(state: &mut [u64; 4], byte: u8) {
    state[0] ^= u64::from(byte);
    state[0] = state[0].wrapping_mul(0x1000_0000_01b3);
    state[1] ^= state[0].rotate_left(13);
    state[2] = state[2].wrapping_add(state[1] ^ 0x9e37_79b9_7f4a_7c15);
    state[3] ^= state[2].rotate_right(17);
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_domain_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
