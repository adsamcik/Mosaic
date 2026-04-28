use std::{fs, path::PathBuf};

#[test]
fn late_v1_protocol_freeze_spec_covers_contract_domains() {
    let spec_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/specs/SPEC-LateV1ProtocolFreeze.md");
    let spec = fs::read_to_string(&spec_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", spec_path.display()));
    let normalized_spec = spec.to_ascii_lowercase();

    for required in [
        "backend api json",
        "opaque blob formats",
        "rust ffi dtos",
        "android foundation contracts",
        "web wasm adapter boundary",
        "test vectors",
        "zero-knowledge invariants",
        "release-blocker criteria",
        "bands 5/6",
        "android upload",
    ] {
        assert!(
            normalized_spec.contains(required),
            "late-v1 protocol freeze spec must reference {required}"
        );
    }
}
