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
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
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
