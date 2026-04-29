//! Drive `mosaic-client` error mapping arms that wrapper bindings see when
//! the underlying `mosaic_crypto` operations return non-default error codes.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, create_epoch_key_handle,
    decrypt_shard_with_epoch_handle, open_secret_handle,
};

const ACCOUNT_KEY: [u8; 32] = [
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
];

#[test]
fn decrypt_shard_with_epoch_handle_rejects_truncated_envelope_after_header() {
    // A 64-byte header (parses) followed by no ciphertext yields the crypto
    // `MissingCiphertext` error that the client surfaces directly. This
    // exercises the `with_epoch` success branch combined with the crypto
    // error mapping for `MissingCiphertext`.
    let account_handle = open_secret_handle(&ACCOUNT_KEY)
        .expect("account handle should open for truncated-envelope");
    let epoch = create_epoch_key_handle(account_handle, 23);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let header_only = mosaic_domain::ShardEnvelopeHeader::new(
        23,
        0,
        [0xab_u8; 24],
        mosaic_domain::ShardTier::Original,
    )
    .to_bytes();
    let result = decrypt_shard_with_epoch_handle(epoch.handle, &header_only);
    assert_eq!(result.code, ClientErrorCode::MissingCiphertext);
    assert!(result.plaintext.is_empty());

    close_epoch_key_handle(epoch.handle).expect("epoch handle should close");
    close_account_key_handle(account_handle).expect("account handle should close");
}
