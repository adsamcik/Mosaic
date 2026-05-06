use mosaic_client::{
    ClientErrorCode, ProgressEvent, close_identity_handle, close_secret_handle,
    create_identity_handle, ffi_spike_probe_key, identity_encryption_pubkey,
    identity_handle_is_open, identity_signing_pubkey, open_identity_handle, open_secret_handle,
    parse_shard_header_for_ffi, run_progress_probe, secret_handle_is_open,
    sign_manifest_with_identity,
};
use mosaic_crypto::{
    IdentitySignature, IdentitySigningPublicKey, verify_manifest_identity_signature,
};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};

const NONCE: [u8; 24] = [
    0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
    0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1,
];
const ACCOUNT_KEY: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const MAX_PROGRESS_EVENTS: u32 = 10_000;

#[test]
fn parse_shard_header_maps_domain_errors_to_stable_codes() {
    let mut bytes = ShardEnvelopeHeader::new(1, 2, NONCE, ShardTier::Thumbnail).to_bytes();
    bytes[38] = 9;

    let result = parse_shard_header_for_ffi(&bytes);

    assert_eq!(result.code, ClientErrorCode::NonZeroReservedByte);
    assert_eq!(result.epoch_id, 0);
    assert_eq!(result.nonce, Vec::<u8>::new());

    let mut invalid_magic = ShardEnvelopeHeader::new(1, 2, NONCE, ShardTier::Thumbnail).to_bytes();
    invalid_magic[0] ^= 1;
    let result = parse_shard_header_for_ffi(&invalid_magic);
    assert_eq!(result.code, ClientErrorCode::InvalidMagic);
    assert_eq!(result.epoch_id, 0);
    assert_eq!(result.nonce, Vec::<u8>::new());

    let mut unsupported_version =
        ShardEnvelopeHeader::new(1, 2, NONCE, ShardTier::Thumbnail).to_bytes();
    unsupported_version[4] = 2;
    let result = parse_shard_header_for_ffi(&unsupported_version);
    assert_eq!(result.code, ClientErrorCode::UnknownEnvelopeVersion);
    assert_eq!(result.epoch_id, 0);
    assert_eq!(result.nonce, Vec::<u8>::new());
}

#[test]
fn parse_shard_header_returns_public_header_fields_only() {
    let bytes = ShardEnvelopeHeader::new(5, 9, NONCE, ShardTier::Original).to_bytes();

    let result = parse_shard_header_for_ffi(&bytes);

    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.epoch_id, 5);
    assert_eq!(result.shard_index, 9);
    assert_eq!(result.tier, 3);
    assert_eq!(result.nonce, NONCE.to_vec());
}

#[test]
fn opaque_secret_handles_can_be_closed_without_revealing_secret_bytes() {
    let secret = b"not returned over ffi";
    let handle = match open_secret_handle(secret) {
        Ok(value) => value,
        Err(error) => panic!("secret handle should open: {error:?}"),
    };

    let is_open = match secret_handle_is_open(handle) {
        Ok(value) => value,
        Err(error) => panic!("handle lookup should succeed: {error:?}"),
    };
    assert!(is_open);

    if let Err(error) = close_secret_handle(handle) {
        panic!("handle should close once: {error:?}");
    }

    let is_open = match secret_handle_is_open(handle) {
        Ok(value) => value,
        Err(error) => panic!("closed handle lookup should succeed: {error:?}"),
    };
    assert!(!is_open);

    let error = match close_secret_handle(handle) {
        Ok(()) => panic!("closing twice should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::SecretHandleNotFound);
}

#[test]
fn progress_probe_reports_steps_and_cancellation() {
    let result = run_progress_probe(4, Some(2));

    assert_eq!(result.code, ClientErrorCode::OperationCancelled);
    assert_eq!(
        result.events,
        vec![
            ProgressEvent {
                completed_steps: 1,
                total_steps: 4,
            },
            ProgressEvent {
                completed_steps: 2,
                total_steps: 4,
            },
        ]
    );
}

#[test]
fn progress_probe_rejects_unbounded_event_requests() {
    let result = run_progress_probe(u32::MAX, None);

    assert_eq!(result.code, ClientErrorCode::InvalidInputLength);
    assert!(result.events.is_empty());
}

#[test]
fn progress_probe_handles_boundary_and_cancellation_edges() {
    let max_result = run_progress_probe(MAX_PROGRESS_EVENTS, None);
    assert_eq!(max_result.code, ClientErrorCode::Ok);
    assert_eq!(max_result.events.len(), MAX_PROGRESS_EVENTS as usize);
    assert_eq!(
        max_result.events.first(),
        Some(&ProgressEvent {
            completed_steps: 1,
            total_steps: MAX_PROGRESS_EVENTS,
        })
    );
    assert_eq!(
        max_result.events.last(),
        Some(&ProgressEvent {
            completed_steps: MAX_PROGRESS_EVENTS,
            total_steps: MAX_PROGRESS_EVENTS,
        })
    );

    let too_many = run_progress_probe(MAX_PROGRESS_EVENTS + 1, None);
    assert_eq!(too_many.code, ClientErrorCode::InvalidInputLength);
    assert!(too_many.events.is_empty());

    let cancel_immediately = run_progress_probe(5, Some(0));
    assert_eq!(cancel_immediately.code, ClientErrorCode::OperationCancelled);
    assert!(cancel_immediately.events.is_empty());

    let cancel_after_total = run_progress_probe(5, Some(10));
    assert_eq!(cancel_after_total.code, ClientErrorCode::Ok);
    assert_eq!(cancel_after_total.events.len(), 5);

    let zero_steps = run_progress_probe(0, None);
    assert_eq!(zero_steps.code, ClientErrorCode::Ok);
    assert!(zero_steps.events.is_empty());
}

#[test]
fn ffi_probe_key_is_available_only_as_an_explicit_spike_operation() {
    let result = ffi_spike_probe_key(b"input", b"context");

    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.bytes.len(), 32);
}

#[test]
fn ffi_probe_key_rejects_empty_context() {
    let result = ffi_spike_probe_key(b"input", b"");

    assert_eq!(result.code, ClientErrorCode::EmptyContext);
    assert!(result.bytes.is_empty());
}

#[test]
fn handle_operations_reject_zero_handle_without_secret_outputs() {
    let secret_is_open = match secret_handle_is_open(0) {
        Ok(value) => value,
        Err(error) => panic!("zero secret handle status should be readable: {error:?}"),
    };
    assert!(!secret_is_open);

    let close_secret_error = match close_secret_handle(0) {
        Ok(()) => panic!("zero secret handle should not close"),
        Err(error) => error,
    };
    assert_eq!(
        close_secret_error.code,
        ClientErrorCode::SecretHandleNotFound
    );

    let identity_is_open = match identity_handle_is_open(0) {
        Ok(value) => value,
        Err(error) => panic!("zero identity handle status should be readable: {error:?}"),
    };
    assert!(!identity_is_open);

    let create_result = create_identity_handle(0);
    assert_eq!(create_result.code, ClientErrorCode::SecretHandleNotFound);
    assert_eq!(create_result.handle, 0);
    assert!(create_result.signing_pubkey.is_empty());
    assert!(create_result.encryption_pubkey.is_empty());
    assert!(create_result.wrapped_seed.is_empty());

    let signing_result = identity_signing_pubkey(0);
    assert_eq!(signing_result.code, ClientErrorCode::IdentityHandleNotFound);
    assert!(signing_result.bytes.is_empty());

    let encryption_result = identity_encryption_pubkey(0);
    assert_eq!(
        encryption_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );
    assert!(encryption_result.bytes.is_empty());

    let signature_result = sign_manifest_with_identity(0, b"transcript");
    assert_eq!(
        signature_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );
    assert!(signature_result.bytes.is_empty());

    let close_identity_error = match close_identity_handle(0) {
        Ok(()) => panic!("zero identity handle should not close"),
        Err(error) => error,
    };
    assert_eq!(
        close_identity_error.code,
        ClientErrorCode::IdentityHandleNotFound
    );
}

#[test]
fn identity_handle_round_trips_wrapped_seed_and_signs_manifest() {
    let account_handle = match open_secret_handle(&ACCOUNT_KEY) {
        Ok(value) => value,
        Err(error) => panic!("account handle should open: {error:?}"),
    };
    let create_result = create_identity_handle(account_handle);

    assert_eq!(create_result.code, ClientErrorCode::Ok);
    assert_ne!(create_result.handle, 0);
    assert_eq!(create_result.signing_pubkey.len(), 32);
    assert_eq!(create_result.encryption_pubkey.len(), 32);
    assert_eq!(create_result.wrapped_seed.len(), 24 + 32 + 16);

    let transcript = b"manifest transcript bytes";
    let signature_result = sign_manifest_with_identity(create_result.handle, transcript);
    assert_eq!(signature_result.code, ClientErrorCode::Ok);
    assert_eq!(signature_result.bytes.len(), 64);

    let public_key = match IdentitySigningPublicKey::from_bytes(&create_result.signing_pubkey) {
        Ok(value) => value,
        Err(error) => panic!("identity public key should decode: {error:?}"),
    };
    let signature = match IdentitySignature::from_bytes(&signature_result.bytes) {
        Ok(value) => value,
        Err(error) => panic!("identity signature should decode: {error:?}"),
    };
    assert!(verify_manifest_identity_signature(
        transcript,
        &signature,
        &public_key
    ));

    if let Err(error) = close_identity_handle(create_result.handle) {
        panic!("identity handle should close: {error:?}");
    }

    let open_result = open_identity_handle(&create_result.wrapped_seed, account_handle);
    assert_eq!(open_result.code, ClientErrorCode::Ok);
    assert_eq!(open_result.signing_pubkey, create_result.signing_pubkey);
    assert_eq!(
        open_result.encryption_pubkey,
        create_result.encryption_pubkey
    );
    assert!(open_result.wrapped_seed.is_empty());

    if let Err(error) = close_identity_handle(open_result.handle) {
        panic!("reopened identity handle should close: {error:?}");
    }
    if let Err(error) = close_secret_handle(account_handle) {
        panic!("account handle should close: {error:?}");
    }
}

#[test]
fn identity_handle_rejects_invalid_account_or_tampered_wrapped_seed() {
    let invalid_account = create_identity_handle(u64::MAX);
    assert_eq!(invalid_account.code, ClientErrorCode::SecretHandleNotFound);
    assert_eq!(invalid_account.handle, 0);
    assert!(invalid_account.signing_pubkey.is_empty());

    let account_handle = match open_secret_handle(&[0x42_u8; 32]) {
        Ok(value) => value,
        Err(error) => panic!("account handle should open: {error:?}"),
    };
    let create_result = create_identity_handle(account_handle);
    assert_eq!(create_result.code, ClientErrorCode::Ok);

    let mut tampered = create_result.wrapped_seed.clone();
    tampered[30] ^= 1;
    let tampered_result = open_identity_handle(&tampered, account_handle);
    assert_eq!(tampered_result.code, ClientErrorCode::AuthenticationFailed);
    assert_eq!(tampered_result.handle, 0);
    assert!(tampered_result.signing_pubkey.is_empty());

    if let Err(error) = close_identity_handle(create_result.handle) {
        panic!("identity handle should close: {error:?}");
    }
    if let Err(error) = close_secret_handle(account_handle) {
        panic!("account handle should close: {error:?}");
    }
}

#[test]
fn closing_account_handle_closes_linked_identity_handles() {
    let account_handle = match open_secret_handle(&[0x33_u8; 32]) {
        Ok(value) => value,
        Err(error) => panic!("account handle should open: {error:?}"),
    };
    let create_result = create_identity_handle(account_handle);
    assert_eq!(create_result.code, ClientErrorCode::Ok);

    let is_open = match identity_handle_is_open(create_result.handle) {
        Ok(value) => value,
        Err(error) => panic!("identity lookup should succeed: {error:?}"),
    };
    assert!(is_open);

    if let Err(error) = close_secret_handle(account_handle) {
        panic!("account handle should close: {error:?}");
    }

    let is_open = match identity_handle_is_open(create_result.handle) {
        Ok(value) => value,
        Err(error) => panic!("closed identity lookup should succeed: {error:?}"),
    };
    assert!(!is_open);

    let signing_result = identity_signing_pubkey(create_result.handle);
    assert_eq!(signing_result.code, ClientErrorCode::IdentityHandleNotFound);

    let signature_result =
        sign_manifest_with_identity(create_result.handle, b"manifest transcript");
    assert_eq!(
        signature_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );

    let encryption_result = identity_encryption_pubkey(create_result.handle);
    assert_eq!(
        encryption_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );
}
