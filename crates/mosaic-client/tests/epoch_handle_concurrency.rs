//! Concurrency and correctness coverage for the epoch-handle AEAD path.
//!
//! These tests lock in the property that `encrypt_shard_with_epoch_handle`
//! and `decrypt_shard_with_epoch_handle` do not hold the global epoch registry
//! mutex while running the AEAD. Holding the registry lock during AEAD would
//! serialize every other epoch-handle operation across the client core (an
//! availability problem on shards up to 100 MiB).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, create_epoch_key_handle,
    decrypt_shard_with_epoch_handle, encrypt_shard_with_epoch_handle, open_secret_handle,
};

const ACCOUNT_KEY: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

#[test]
fn epoch_handle_aead_round_trip_after_lock_release_refactor() {
    // After the M1 fix, the AEAD runs against a freshly constructed `SecretKey`
    // built from a `Zeroizing<Vec<u8>>` clone of the tier key bytes. This test
    // proves that round-tripping still works and that no envelope corruption
    // is introduced by the lock-release refactor.
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch = create_epoch_key_handle(account, 19);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let plaintext: Vec<u8> = (0..512).map(|i| (i % 251) as u8).collect();
    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, &plaintext, 7, 3);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);
    assert!(!encrypted.envelope_bytes.is_empty());

    let decrypted = decrypt_shard_with_epoch_handle(epoch.handle, &encrypted.envelope_bytes);
    assert_eq!(decrypted.code, ClientErrorCode::Ok);
    assert_eq!(decrypted.plaintext, plaintext);

    close_epoch_key_handle(epoch.handle).expect("epoch handle should close");
    close_account_key_handle(account).expect("account handle should close");
}

#[test]
fn parallel_encrypts_on_same_epoch_handle_do_not_deadlock_and_all_succeed() {
    // N threads concurrently encrypting and decrypting on the same epoch
    // handle must all succeed. With the M1 fix the registry mutex is released
    // before the AEAD runs; this test is a smoke check that the new flow
    // has no aliasing or freeing bug under load.
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch = create_epoch_key_handle(account, 23);
    assert_eq!(epoch.code, ClientErrorCode::Ok);
    let handle = epoch.handle;

    let plaintext: Vec<u8> = (0..1024).map(|i| (i as u8).wrapping_mul(7)).collect();
    let plaintext = Arc::new(plaintext);

    let mut handles = Vec::with_capacity(8);
    for thread_index in 0..8u32 {
        let plaintext = Arc::clone(&plaintext);
        handles.push(thread::spawn(move || {
            for iteration in 0..16u32 {
                let shard_index = thread_index * 16 + iteration;
                let encrypted =
                    encrypt_shard_with_epoch_handle(handle, plaintext.as_slice(), shard_index, 1);
                assert_eq!(
                    encrypted.code,
                    ClientErrorCode::Ok,
                    "thread {thread_index} iter {iteration} encrypt failed"
                );
                let decrypted = decrypt_shard_with_epoch_handle(handle, &encrypted.envelope_bytes);
                assert_eq!(
                    decrypted.code,
                    ClientErrorCode::Ok,
                    "thread {thread_index} iter {iteration} decrypt failed"
                );
                assert_eq!(decrypted.plaintext, *plaintext);
            }
        }));
    }
    for h in handles {
        h.join().expect("worker thread should not panic");
    }

    close_epoch_key_handle(handle).expect("epoch handle should close");
    close_account_key_handle(account).expect("account handle should close");
}

#[test]
fn registry_observer_is_not_blocked_while_aead_threads_run() {
    // While many threads are mid-AEAD on a handle, observing the registry
    // (here via opening another epoch handle on the same account) must not
    // deadlock and must complete promptly. Under the M1 fix the lock is
    // released *during* each AEAD too, so this asserts "no deadlock under
    // load" rather than throughput.
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch = create_epoch_key_handle(account, 31);
    assert_eq!(epoch.code, ClientErrorCode::Ok);
    let handle = epoch.handle;

    let stop = Arc::new(AtomicBool::new(false));
    let plaintext: Vec<u8> = vec![0x42; 4096];
    let plaintext = Arc::new(plaintext);

    let mut workers = Vec::new();
    for _ in 0..4 {
        let stop = Arc::clone(&stop);
        let plaintext = Arc::clone(&plaintext);
        workers.push(thread::spawn(move || {
            let mut shard_index = 0u32;
            while !stop.load(Ordering::Relaxed) {
                let encrypted =
                    encrypt_shard_with_epoch_handle(handle, plaintext.as_slice(), shard_index, 1);
                assert_eq!(encrypted.code, ClientErrorCode::Ok);
                let decrypted = decrypt_shard_with_epoch_handle(handle, &encrypted.envelope_bytes);
                assert_eq!(decrypted.code, ClientErrorCode::Ok);
                shard_index = shard_index.wrapping_add(1);
            }
        }));
    }

    for new_epoch_id in 100u32..132u32 {
        let other = create_epoch_key_handle(account, new_epoch_id);
        assert_eq!(other.code, ClientErrorCode::Ok, "create should succeed");
        close_epoch_key_handle(other.handle).expect("other epoch handle should close");
    }

    stop.store(true, Ordering::Relaxed);
    for w in workers {
        w.join().expect("worker thread should not panic");
    }

    close_epoch_key_handle(handle).expect("epoch handle should close");
    close_account_key_handle(account).expect("account handle should close");
}
