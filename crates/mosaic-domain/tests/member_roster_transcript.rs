//! Member roster transcript tests (batch C2a — A2's sibling).
//!
//! Locks the canonical byte layout produced by
//! [`canonical_member_roster_transcript_bytes`] and verifies the
//! sort-order, domain-separation, role-byte-stability, and
//! field-binding properties that the cross-client roster signature
//! relies on.
//!
//! Closes audit `threat-model C-3 (server-controlled member roles)` at
//! the domain-transcript layer. The matching signing/verify path
//! reuses `mosaic-crypto::{sign_manifest_transcript,
//! verify_manifest_transcript}` on the per-epoch Ed25519 manifest
//! signing keypair (no new crypto primitive).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use mosaic_domain::{
    MANIFEST_SIGN_CONTEXT, MEMBER_ROLE_EDITOR_BYTE, MEMBER_ROLE_OWNER_BYTE,
    MEMBER_ROLE_VIEWER_BYTE, MEMBER_ROSTER_SIGN_CONTEXT, MEMBER_ROSTER_TRANSCRIPT_VERSION,
    MemberRole, MemberRosterEntry, MemberRosterError, MemberRosterTranscript,
    TOMBSTONE_SIGN_CONTEXT, canonical_member_roster_transcript_bytes,
};

const ALBUM_A: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
const MEMBER_X: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const MEMBER_Y: [u8; 16] = [
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];
const MEMBER_Z: [u8; 16] = [
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
];

#[test]
fn member_role_byte_values_are_canonical() {
    // These bytes are part of the signed roster surface — they MUST NOT
    // change between protocol versions.
    assert_eq!(MEMBER_ROLE_OWNER_BYTE, 1);
    assert_eq!(MEMBER_ROLE_EDITOR_BYTE, 2);
    assert_eq!(MEMBER_ROLE_VIEWER_BYTE, 3);
    assert_eq!(MemberRole::Owner.to_byte(), 1);
    assert_eq!(MemberRole::Editor.to_byte(), 2);
    assert_eq!(MemberRole::Viewer.to_byte(), 3);
}

#[test]
fn member_role_try_from_byte_round_trips_known_values() {
    for role in [MemberRole::Owner, MemberRole::Editor, MemberRole::Viewer] {
        assert_eq!(MemberRole::try_from_byte(role.to_byte()), Ok(role));
    }
}

#[test]
fn member_role_try_from_byte_rejects_unknown_bytes() {
    for unknown in [0, 4, 5, 0xff] {
        assert_eq!(
            MemberRole::try_from_byte(unknown),
            Err(MemberRosterError::InvalidRoleByte { byte: unknown }),
        );
    }
}

#[test]
fn empty_roster_has_stable_55_byte_layout() {
    let transcript = MemberRosterTranscript::new(ALBUM_A, 1_u32, 0_i64, Vec::new())
        .expect("empty roster is allowed");
    let bytes = canonical_member_roster_transcript_bytes(&transcript).expect("canonical bytes");

    // 22 (context) + 1 (version) + 16 (album) + 4 (epoch) + 8 (roster_version) + 4 (count) = 55
    assert_eq!(bytes.len(), 55);

    assert_eq!(
        &bytes[..MEMBER_ROSTER_SIGN_CONTEXT.len()],
        MEMBER_ROSTER_SIGN_CONTEXT
    );
    assert_eq!(MEMBER_ROSTER_SIGN_CONTEXT, b"Mosaic_MemberRoster_v1");
    assert_eq!(
        bytes[MEMBER_ROSTER_SIGN_CONTEXT.len()],
        MEMBER_ROSTER_TRANSCRIPT_VERSION
    );
    assert_eq!(MEMBER_ROSTER_TRANSCRIPT_VERSION, 1);

    let mut cursor = MEMBER_ROSTER_SIGN_CONTEXT.len() + 1;
    assert_eq!(&bytes[cursor..cursor + 16], &ALBUM_A);
    cursor += 16;
    assert_eq!(&bytes[cursor..cursor + 4], &1_u32.to_le_bytes());
    cursor += 4;
    assert_eq!(&bytes[cursor..cursor + 8], &0_i64.to_le_bytes());
    cursor += 8;
    assert_eq!(&bytes[cursor..cursor + 4], &0_u32.to_le_bytes());
    cursor += 4;
    assert_eq!(cursor, bytes.len(), "no trailing bytes for empty roster");
}

#[test]
fn three_member_roster_has_stable_106_byte_layout() {
    // 55 (header) + 3 * 17 (member entries) = 106
    let entries = vec![
        MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        },
        MemberRosterEntry {
            member_id: MEMBER_Y,
            role: MemberRole::Editor,
        },
        MemberRosterEntry {
            member_id: MEMBER_Z,
            role: MemberRole::Viewer,
        },
    ];
    let transcript = MemberRosterTranscript::new(ALBUM_A, 7_u32, 42_i64, entries)
        .expect("three-member roster is allowed");
    let bytes = canonical_member_roster_transcript_bytes(&transcript).expect("canonical bytes");

    assert_eq!(bytes.len(), 55 + 3 * 17);
    assert_eq!(bytes.len(), 106);

    // The three member entries follow the 55-byte header in canonical sort
    // order (ascending by member_id bytes): X (0x10..) < Y (0x20..) < Z (0x30..).
    let mut cursor = 55;
    assert_eq!(&bytes[cursor..cursor + 16], &MEMBER_X);
    cursor += 16;
    assert_eq!(bytes[cursor], MEMBER_ROLE_OWNER_BYTE);
    cursor += 1;
    assert_eq!(&bytes[cursor..cursor + 16], &MEMBER_Y);
    cursor += 16;
    assert_eq!(bytes[cursor], MEMBER_ROLE_EDITOR_BYTE);
    cursor += 1;
    assert_eq!(&bytes[cursor..cursor + 16], &MEMBER_Z);
    cursor += 16;
    assert_eq!(bytes[cursor], MEMBER_ROLE_VIEWER_BYTE);
    cursor += 1;
    assert_eq!(cursor, bytes.len());
}

#[test]
fn roster_canonicalisation_sorts_members_by_id_bytes() {
    // Server cannot reorder entries to swap which member_id's role a
    // signature applies to — the canonical bytes are sort-stable.
    let entries_a = vec![
        MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        },
        MemberRosterEntry {
            member_id: MEMBER_Y,
            role: MemberRole::Editor,
        },
        MemberRosterEntry {
            member_id: MEMBER_Z,
            role: MemberRole::Viewer,
        },
    ];
    let entries_b = vec![
        MemberRosterEntry {
            member_id: MEMBER_Z,
            role: MemberRole::Viewer,
        },
        MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        },
        MemberRosterEntry {
            member_id: MEMBER_Y,
            role: MemberRole::Editor,
        },
    ];
    let a = canonical_member_roster_transcript_bytes(
        &MemberRosterTranscript::new(ALBUM_A, 1, 0, entries_a).expect("a"),
    )
    .expect("bytes a");
    let b = canonical_member_roster_transcript_bytes(
        &MemberRosterTranscript::new(ALBUM_A, 1, 0, entries_b).expect("b"),
    )
    .expect("bytes b");
    assert_eq!(a, b, "canonical bytes must be sort-order-invariant");
}

#[test]
fn roster_canonicalisation_rejects_duplicate_member_ids() {
    let entries = vec![
        MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        },
        MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Editor,
        },
    ];
    let result = MemberRosterTranscript::new(ALBUM_A, 1, 0, entries);
    assert_eq!(
        result,
        Err(MemberRosterError::DuplicateMemberId {
            member_id: MEMBER_X
        }),
    );
}

#[test]
fn roster_context_byte_distinct_from_manifest_and_tombstone_contexts() {
    // Prevents an Ed25519 signature over a manifest or tombstone transcript
    // from ever being accepted as a roster signature, and vice versa.
    assert_eq!(MEMBER_ROSTER_SIGN_CONTEXT, b"Mosaic_MemberRoster_v1");
    assert_ne!(MEMBER_ROSTER_SIGN_CONTEXT, MANIFEST_SIGN_CONTEXT);
    assert_ne!(MEMBER_ROSTER_SIGN_CONTEXT, TOMBSTONE_SIGN_CONTEXT);
    assert!(
        !MEMBER_ROSTER_SIGN_CONTEXT.starts_with(MANIFEST_SIGN_CONTEXT),
        "roster context must not be an extension of manifest context"
    );
    assert!(
        !MANIFEST_SIGN_CONTEXT.starts_with(MEMBER_ROSTER_SIGN_CONTEXT),
        "manifest context must not be an extension of roster context"
    );
    assert!(
        !MEMBER_ROSTER_SIGN_CONTEXT.starts_with(TOMBSTONE_SIGN_CONTEXT),
        "roster context must not be an extension of tombstone context"
    );
    assert!(
        !TOMBSTONE_SIGN_CONTEXT.starts_with(MEMBER_ROSTER_SIGN_CONTEXT),
        "tombstone context must not be an extension of roster context"
    );
}

#[test]
fn roster_differs_on_field_changes() {
    let base = MemberRosterTranscript::new(
        ALBUM_A,
        5_u32,
        1_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Editor,
        }],
    )
    .expect("base");
    let base_bytes = canonical_member_roster_transcript_bytes(&base).expect("base bytes");

    let bumped_epoch = MemberRosterTranscript::new(
        ALBUM_A,
        6_u32,
        1_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Editor,
        }],
    )
    .expect("epoch");
    assert_ne!(
        base_bytes,
        canonical_member_roster_transcript_bytes(&bumped_epoch).expect("epoch bytes"),
        "epoch_id swap MUST yield distinct bytes (stale-epoch replay)"
    );

    let bumped_version = MemberRosterTranscript::new(
        ALBUM_A,
        5_u32,
        2_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Editor,
        }],
    )
    .expect("version");
    assert_ne!(
        base_bytes,
        canonical_member_roster_transcript_bytes(&bumped_version).expect("version bytes"),
        "roster_version swap MUST yield distinct bytes (stale-roster replay)"
    );

    let role_changed = MemberRosterTranscript::new(
        ALBUM_A,
        5_u32,
        1_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        }],
    )
    .expect("role");
    assert_ne!(
        base_bytes,
        canonical_member_roster_transcript_bytes(&role_changed).expect("role bytes"),
        "role byte change MUST yield distinct bytes (role escalation must change the signature)"
    );

    let member_added = MemberRosterTranscript::new(
        ALBUM_A,
        5_u32,
        1_i64,
        vec![
            MemberRosterEntry {
                member_id: MEMBER_X,
                role: MemberRole::Editor,
            },
            MemberRosterEntry {
                member_id: MEMBER_Y,
                role: MemberRole::Viewer,
            },
        ],
    )
    .expect("added");
    assert_ne!(
        base_bytes,
        canonical_member_roster_transcript_bytes(&member_added).expect("added bytes"),
        "member addition MUST yield distinct bytes (server cannot smuggle members)"
    );

    let other_album = MemberRosterTranscript::new(
        [0xff_u8; 16],
        5_u32,
        1_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Editor,
        }],
    )
    .expect("album");
    assert_ne!(
        base_bytes,
        canonical_member_roster_transcript_bytes(&other_album).expect("album bytes"),
        "album_id swap MUST yield distinct bytes (cross-album roster reuse)"
    );
}

#[test]
fn roster_accessors_return_construction_inputs() {
    let transcript = MemberRosterTranscript::new(
        ALBUM_A,
        13_u32,
        77_i64,
        vec![MemberRosterEntry {
            member_id: MEMBER_X,
            role: MemberRole::Owner,
        }],
    )
    .expect("ctor");
    assert_eq!(transcript.album_id(), &ALBUM_A);
    assert_eq!(transcript.epoch_id(), 13);
    assert_eq!(transcript.roster_version(), 77);
    assert_eq!(transcript.members().len(), 1);
    assert_eq!(transcript.members()[0].role, MemberRole::Owner);
}

#[test]
fn roster_handles_extreme_roster_version_values() {
    let max = MemberRosterTranscript::new(ALBUM_A, u32::MAX, i64::MAX, Vec::new()).expect("max");
    let max_bytes = canonical_member_roster_transcript_bytes(&max).expect("max bytes");
    assert_eq!(max_bytes.len(), 55);

    let min = MemberRosterTranscript::new(ALBUM_A, 0_u32, i64::MIN, Vec::new()).expect("min");
    let min_bytes = canonical_member_roster_transcript_bytes(&min).expect("min bytes");
    assert_eq!(min_bytes.len(), 55);
    assert_ne!(max_bytes, min_bytes);
}
