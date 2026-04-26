use mosaic_crypto::test_only_derive_probe_key;

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
