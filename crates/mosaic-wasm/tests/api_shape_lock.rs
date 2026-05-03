use std::{env, fs, path::PathBuf};

const GOLDEN: &str = include_str!("golden/mosaic_wasm.d.ts");

/// Locks the actual wasm-bindgen export surface by comparing the generated
/// TypeScript declaration file against a reviewed golden.
///
/// CI regenerates `apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts` with
/// `scripts/build-rust-wasm.sh` before this test runs. Locally, run
/// `scripts/build-rust-wasm.ps1` first. A malicious export such as
/// `#[wasm_bindgen] pub fn _api_shape_lock_negative_test_should_be_caught() -> Vec<u8> { vec![] }`
/// adds a declaration to the generated `.d.ts`, causing this golden diff to
/// fail until a reviewer explicitly accepts the new surface.
///
/// Update intentionally with:
/// `UPDATE_GOLDEN=1 cargo test -p mosaic-wasm --test api_shape_lock --locked`
#[test]
fn generated_wasm_typescript_declarations_match_golden() {
    let generated_path = project_root()
        .join("apps")
        .join("web")
        .join("src")
        .join("generated")
        .join("mosaic-wasm")
        .join("mosaic_wasm.d.ts");
    let generated = fs::read_to_string(&generated_path).unwrap_or_else(|error| {
        panic!(
            "failed to read generated wasm-bindgen declarations at {}: {error}. \
             Run scripts/build-rust-wasm.ps1 before this test.",
            generated_path.display()
        )
    });
    let generated = normalize_newlines(&generated);

    if env::var_os("UPDATE_GOLDEN").is_some() {
        let path = golden_path("mosaic_wasm.d.ts");
        let Some(parent) = path.parent() else {
            panic!("golden file has no parent: {}", path.display());
        };
        if let Err(error) = fs::create_dir_all(parent) {
            panic!(
                "failed to create golden directory {}: {error}",
                parent.display()
            );
        }
        if let Err(error) = fs::write(&path, &generated) {
            panic!(
                "failed to write WASM API-shape golden {}: {error}",
                path.display()
            );
        }
        return;
    }

    assert_eq!(
        normalize_newlines(GOLDEN),
        generated,
        "WASM API-shape drift detected. Regenerate wasm-bindgen output, review \
         the declaration diff for raw-secret exports, then update only with: \
         UPDATE_GOLDEN=1 cargo test -p mosaic-wasm --test api_shape_lock --locked"
    );
}

#[test]
fn generated_wasm_typescript_declarations_do_not_export_raw_epoch_keys() {
    let generated_path = project_root()
        .join("apps")
        .join("web")
        .join("src")
        .join("generated")
        .join("mosaic-wasm")
        .join("mosaic_wasm.d.ts");
    let generated = fs::read_to_string(&generated_path).unwrap_or_else(|error| {
        panic!(
            "failed to read generated wasm-bindgen declarations at {}: {error}. \
             Run scripts/build-rust-wasm.ps1 before this test.",
            generated_path.display()
        )
    });

    for forbidden_export in ["getTierKeyFromEpoch", "deriveContentKeyFromEpoch"] {
        assert!(
            !generated.contains(forbidden_export),
            "raw epoch-key export must not be present in generated WASM declarations: {forbidden_export}"
        );
    }
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

fn project_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(crates_dir) = manifest_dir.parent() else {
        panic!(
            "crate manifest dir has no parent: {}",
            manifest_dir.display()
        );
    };
    let Some(project_root) = crates_dir.parent() else {
        panic!("crates dir has no parent: {}", crates_dir.display());
    };
    project_root.to_path_buf()
}

fn golden_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join(file_name)
}
