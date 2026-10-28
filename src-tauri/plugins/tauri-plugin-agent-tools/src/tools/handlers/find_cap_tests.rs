use super::*;

/// Jozkah/jan#250: a file too large to load whole is refused by `read`
/// and skipped (with a note) by `grep`, which still searches the rest.
#[tokio::test]
async fn huge_files_are_not_loaded_whole() {
    let root = std::env::temp_dir().join(format!("jan_huge_read_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let huge = std::fs::File::create(root.join("model.gguf")).unwrap();
    huge.set_len(READ_MAX_BYTES + 1).unwrap(); // sparse: no real 32 MiB write
    drop(huge);
    std::fs::write(root.join("notes.txt"), "needle\n").unwrap();

    let (out, _) = read(&serde_json::json!({"path": "model.gguf"}), &root, None, &[]).await;
    assert!(
        out.starts_with("ERROR") && out.contains("too large"),
        "{out}"
    );
    assert!(
        out.contains("allow_large"),
        "the refusal names the way out: {out}"
    );
    assert!(!out.contains("  "), "refusal text is single-spaced: {out}");
    assert!(
        out.contains("true to read up to 256 MiB, or use bash"),
        "{out}"
    );

    // `allow_large` reads past the normal limit, still windowed by `limit`.
    let (out, _) = read(
        &serde_json::json!({"path": "model.gguf", "allow_large": true, "limit": 1}),
        &root,
        None,
        &[],
    )
    .await;
    assert!(!out.contains("too large"), "{out}");
    assert!(!out.starts_with("ERROR: model.gguf"), "{out}");

    let out = grep(
        &serde_json::json!({"pattern": "needle", "path": "."}),
        &root,
        None,
        false,
        &[],
        &[],
    )
    .await;
    assert!(out.contains("notes.txt"), "{out}");
    assert!(out.contains("Skipped 1 file(s) over"), "{out}");
    let _ = std::fs::remove_dir_all(&root);
}

/// `allow_large` has a hard ceiling, and still refuses what is not text.
#[tokio::test]
async fn allow_large_has_a_ceiling_and_keeps_the_binary_refusal() {
    let root = std::env::temp_dir().join(format!("jan_allow_large_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let huge = std::fs::File::create(root.join("huge.bin")).unwrap();
    huge.set_len(READ_MAX_BYTES_ALLOW_LARGE + 1).unwrap();
    drop(huge);
    std::fs::write(root.join("blob.bin"), [0xffu8, 0xfe, 0x00, 0x80]).unwrap();
    let args = |p: &str| serde_json::json!({"path": p, "allow_large": true});

    let (out, _) = read(&args("huge.bin"), &root, None, &[]).await;
    assert!(
        out.starts_with("ERROR") && out.contains("allow_large ceiling"),
        "{out}"
    );
    let (out, _) = read(&args("blob.bin"), &root, None, &[]).await;
    assert!(out.contains("Binary file"), "{out}");
    let _ = std::fs::remove_dir_all(&root);
}

/// Jozkah/jan#251: however many files match, the result stays within the
/// byte cap every sibling tool applies, and says it was cut.
#[tokio::test]
async fn find_output_is_capped() {
    let root = std::env::temp_dir().join(format!("jan_find_cap_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let deep = root.join("a".repeat(60)).join("b".repeat(60));
    std::fs::create_dir_all(&deep).unwrap();
    for i in 0..1500 {
        std::fs::write(deep.join(format!("{}_{i}.txt", "c".repeat(40))), b"").unwrap();
    }
    let out = find(
        &serde_json::json!({"pattern": "**/*.txt", "limit": 1_000_000}),
        &root,
        None,
        false,
        &[],
        &[],
    )
    .await;
    assert!(out.len() <= MAX_BYTES + 64, "{} bytes", out.len());
    assert!(out.contains("[truncated: 64KB limit]"));
    let _ = std::fs::remove_dir_all(&root);
}
