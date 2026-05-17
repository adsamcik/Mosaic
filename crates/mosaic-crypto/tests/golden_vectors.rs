use mosaic_crypto::{
    IdentitySignature, IdentitySigningPublicKey, golden_vectors, verify_manifest_identity_signature,
};

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
fn identity_public_golden_vector_matches_rfc8032_seed() {
    let vector = match golden_vectors::identity_public_vector() {
        Ok(value) => value,
        Err(error) => panic!("identity public vector should derive: {error:?}"),
    };

    assert_eq!(golden_vectors::IDENTITY_MESSAGE, b"");
    assert_eq!(
        hex(vector.signing_pubkey()),
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    );
    assert_eq!(
        hex(vector.encryption_pubkey()),
        "d85e07ec22b0ad881537c2f44d662d1a143cf830c57aca4305d85c7a90f6b62e"
    );
    assert_eq!(
        hex(vector.signature()),
        "59ffadf809f7cc8ea13d573825d7e96d2f81e63a2d4962e13be1eb1e8f00f088802dd138edbcd556515271044ce6d92ddeaaf167c90b1b2dc1fd84193b95a10c"
    );

    let public_key = match IdentitySigningPublicKey::from_bytes(vector.signing_pubkey()) {
        Ok(value) => value,
        Err(error) => panic!("identity public vector should decode: {error:?}"),
    };
    let signature = match IdentitySignature::from_bytes(vector.signature()) {
        Ok(value) => value,
        Err(error) => panic!("identity signature vector should decode: {error:?}"),
    };
    assert!(verify_manifest_identity_signature(
        golden_vectors::IDENTITY_MESSAGE,
        &signature,
        &public_key,
    ));
}
