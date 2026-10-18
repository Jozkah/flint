//! What a CUDA compute capability means for llama.cpp's launch settings.
//!
//! Pure functions, so the decisions are unit-tested without a GPU (none of this
//! has been run on real RTX 20xx hardware). The same thresholds are mirrored in
//! `extensions/llamacpp-extension/src/kvCache.ts`, which applies them when the
//! router preset is written.

/// `"7.5"` -> `(7, 5)`. Anything else (empty, `"unknown"`, `"7"`) is `None`.
pub fn parse_compute_capability(raw: &str) -> Option<(u32, u32)> {
    let (major, minor) = raw.trim().split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Marketing architecture name for a capability, `None` below Maxwell or
/// above what this table knows.
pub fn architecture_name(cc: (u32, u32)) -> Option<&'static str> {
    match cc {
        (5, _) => Some("maxwell"),
        (6, 0..=2) => Some("pascal"),
        (7, 0) => Some("volta"),
        (7, 5) => Some("turing"),
        (8, 0 | 6 | 7) => Some("ampere"),
        (8, 9) => Some("ada"),
        (9, 0) => Some("hopper"),
        (10, _) | (12, _) => Some("blackwell"),
        _ => None,
    }
}

/// Flash attention in llama.cpp's CUDA backend needs Pascal (6.x) at the very
/// least; Turing (7.5) runs it on the tensor-core (mma) kernels.
pub fn flash_attn_supported(cc: (u32, u32)) -> bool {
    cc.0 >= 6
}

/// bf16 arithmetic needs Ampere (8.0). On Turing and older a bf16 KV cache
/// falls back to slow paths or fails, so f16 is the right half-precision type.
pub fn bf16_supported(cc: (u32, u32)) -> bool {
    cc.0 >= 8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvml_formatted_capabilities() {
        assert_eq!(parse_compute_capability("7.5"), Some((7, 5)));
        assert_eq!(parse_compute_capability(" 8.9 "), Some((8, 9)));
        assert_eq!(parse_compute_capability(""), None);
        assert_eq!(parse_compute_capability("7"), None);
        assert_eq!(parse_compute_capability("a.b"), None);
    }

    #[test]
    fn turing_is_named_and_gets_flash_attention_but_not_bf16() {
        let turing = parse_compute_capability("7.5").unwrap();
        assert_eq!(architecture_name(turing), Some("turing"));
        assert!(flash_attn_supported(turing));
        assert!(!bf16_supported(turing));
    }

    #[test]
    fn maxwell_gets_neither_flash_attention_nor_bf16() {
        let maxwell = parse_compute_capability("5.2").unwrap();
        assert_eq!(architecture_name(maxwell), Some("maxwell"));
        assert!(!flash_attn_supported(maxwell));
        assert!(!bf16_supported(maxwell));
    }

    #[test]
    fn ampere_and_newer_support_both() {
        for raw in ["8.0", "8.6", "8.9", "9.0", "12.0"] {
            let cc = parse_compute_capability(raw).unwrap();
            assert!(flash_attn_supported(cc) && bf16_supported(cc), "{raw}");
        }
    }

    #[test]
    fn unknown_capabilities_have_no_name() {
        assert_eq!(architecture_name((7, 2)), None);
        assert_eq!(architecture_name((99, 0)), None);
    }
}
