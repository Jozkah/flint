//! Golden-output checks for the protocol converters: a refactor of a
//! converter must leave its output byte-for-byte (value-for-value) the same.
//!
//! Each case's output lives in `golden/<name>.json` next to this file.
//! `GOLDEN_WRITE=1 cargo test ... golden` rewrites them from the current code;
//! that is only ever done on a commit whose behaviour is the reference.

use std::path::PathBuf;

use serde_json::Value;

fn path_for(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/core/server/golden")
        .join(format!("{name}.json"))
}

/// Compare `actual` with the stored golden output `name`.
pub(crate) fn check(name: &str, actual: &Value) {
    let path = path_for(name);
    if std::env::var("GOLDEN_WRITE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut text = serde_json::to_string_pretty(actual).unwrap();
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden file {} missing ({e}); run with GOLDEN_WRITE=1", path.display()));
    let expected: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        actual,
        &expected,
        "golden output `{name}` changed:\n{}",
        serde_json::to_string_pretty(actual).unwrap()
    );
}
