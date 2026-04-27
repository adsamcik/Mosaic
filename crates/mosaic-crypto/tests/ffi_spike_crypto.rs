use mosaic_crypto::{MosaicCryptoError, test_only_derive_probe_key};

#[test]
fn test_only_probe_key_is_deterministic_and_context_bound() {
    let first = match test_only_derive_probe_key(b"sample input", b"mosaic.test.context") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive: {error:?}"),
    };
    let second = match test_only_derive_probe_key(b"sample input", b"mosaic.test.context") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive deterministically: {error:?}"),
    };
    let other_context = match test_only_derive_probe_key(b"sample input", b"mosaic.other.context") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive for another context: {error:?}"),
    };

    assert_eq!(first.len(), 32);
    assert_eq!(first, second);
    assert_ne!(first, other_context);
}

#[test]
fn test_only_probe_key_rejects_empty_context() {
    assert_eq!(
        test_only_derive_probe_key(b"sample input", b""),
        Err(MosaicCryptoError::EmptyContext)
    );
}

#[test]
fn test_only_probe_key_separates_similar_contexts_and_inputs() {
    let base = match test_only_derive_probe_key(b"sample input", b"ctx") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive: {error:?}"),
    };
    let extended_context = match test_only_derive_probe_key(b"sample input", b"ctx2") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive with extended context: {error:?}"),
    };
    let split_context = match test_only_derive_probe_key(b"sample input", b"ct") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive with split-like context: {error:?}"),
    };
    let extended_input = match test_only_derive_probe_key(b"sample input!", b"ctx") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive with extended input: {error:?}"),
    };
    let empty_input = match test_only_derive_probe_key(b"", b"ctx") {
        Ok(value) => value,
        Err(error) => panic!("test probe should derive with empty input: {error:?}"),
    };

    assert_ne!(base, extended_context);
    assert_ne!(base, split_context);
    assert_ne!(base, extended_input);
    assert_ne!(base, empty_input);
}
