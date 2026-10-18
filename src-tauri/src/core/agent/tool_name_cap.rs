//! Provider-safe length for an advertised tool name.
//!
//! OpenAI-compatible providers require `function.name` to match
//! `^[a-zA-Z0-9_-]{1,64}$`. A plain truncation at 64 makes two long names that
//! share a prefix the same name, and (once a server prefix is added) makes a
//! `_2` collision suffix vanish with the cut. A name that has to be shortened
//! therefore keeps its first 55 characters and ends in a short, stable hash of
//! the *whole* name, so two different long names stay different and the same
//! name is cut the same way in every process.

/// The longest `function.name` the strictest provider accepts.
pub(crate) const MAX_FUNCTION_NAME: usize = 64;

/// Characters kept before the `_<hash>` tail: 55 + `_` + 8 hex = 64.
const KEPT: usize = MAX_FUNCTION_NAME - 9;

/// 32-bit FNV-1a over the bytes. Fixed constants, no per-process seed, so the
/// result is identical on every run and platform (unlike `DefaultHasher`).
fn stable_hash(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// `name` itself when it fits, otherwise its first 55 characters, `_`, and
/// eight hex digits hashing the full name. Expects an already provider-valid
/// (ASCII) name; every byte is then one character.
pub(crate) fn cap_function_name(name: &str) -> String {
    if name.len() <= MAX_FUNCTION_NAME {
        return name.to_string();
    }
    let kept: String = name.chars().take(KEPT).collect();
    format!("{kept}_{:08x}", stable_hash(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_name_is_unchanged() {
        assert_eq!(cap_function_name("read_file"), "read_file");
        let exact = "a".repeat(64);
        assert_eq!(cap_function_name(&exact), exact);
    }

    #[test]
    fn a_long_name_is_cut_to_exactly_64_with_a_hash_tail() {
        let long = format!("server_{}", "x".repeat(100));
        let capped = cap_function_name(&long);
        assert_eq!(capped.len(), 64);
        assert!(capped.starts_with("server_xxxx"));
        let tail = &capped[55..];
        assert!(tail.starts_with('_') && tail[1..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_cut_is_deterministic_and_keeps_long_names_with_one_prefix_apart() {
        let a = format!("{}_alpha", "p".repeat(70));
        let b = format!("{}_bravo", "p".repeat(70));
        assert_eq!(cap_function_name(&a), cap_function_name(&a));
        assert_ne!(cap_function_name(&a), cap_function_name(&b));
        // Pinned so a change of hash is a deliberate, visible decision: the
        // advertised name is part of the cached request prefix.
        assert_eq!(stable_hash("hello"), 0x4f9f_2cab);
    }

    use serde_json::json;

    fn listing(server: &str, names: &[&str]) -> (String, Vec<(String, serde_json::Value)>) {
        let tools = names
            .iter()
            .map(|n| (n.to_string(), json!({"type": "function", "function": {"name": n}})))
            .collect();
        (server.to_string(), tools)
    }

    fn advertised(arr: &[serde_json::Value]) -> Vec<String> {
        arr.iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn same_name_on_two_servers_is_prefixed_with_the_server() {
        let (arr, to_server, call_names) = crate::core::agent::upstream::assemble_tool_array(vec![
            listing("alpha", &["search", "only_a"]),
            listing("beta", &["search"]),
        ]);
        let names = advertised(&arr);
        assert_eq!(names, vec!["only_a", "alpha_search", "beta_search"]);
        assert_eq!(to_server["alpha_search"], "alpha");
        assert_eq!(to_server["beta_search"], "beta");
        assert_eq!(call_names["alpha_search"], "search");
        assert!(!call_names.contains_key("only_a"));
    }

    #[test]
    fn a_unique_over_long_name_is_capped_and_still_dispatches_to_the_original() {
        let long = format!("do_{}", "z".repeat(90));
        let (arr, to_server, call_names) = crate::core::agent::upstream::assemble_tool_array(vec![
            listing("alpha", &[long.as_str(), "short"]),
        ]);
        let names = advertised(&arr);
        assert!(names.iter().all(|n| n.len() <= 64), "{names:?}");
        let capped = names.iter().find(|n| n.starts_with("do_zzz")).unwrap();
        assert_eq!(to_server[capped], "alpha");
        assert_eq!(call_names[capped], long);
        assert!(names.contains(&"short".to_string()));
    }

    #[test]
    fn long_names_sharing_a_prefix_stay_distinct_and_stable() {
        let a = format!("{}_one", "q".repeat(80));
        let b = format!("{}_two", "q".repeat(80));
        let run = || {
            let (arr, _, _) = crate::core::agent::upstream::assemble_tool_array(vec![
                listing("s", &[a.as_str(), b.as_str()]),
            ]);
            advertised(&arr)
        };
        let first = run();
        assert_eq!(first, run());
        assert_eq!(first.len(), 2);
        assert_ne!(first[0], first[1]);
        assert!(first.iter().all(|n| n.len() <= 64));
    }

    #[test]
    fn a_collision_between_servers_with_long_names_terminates_and_is_unique() {
        let long = "t".repeat(80);
        let (arr, to_server, _) = crate::core::agent::upstream::assemble_tool_array(vec![
            listing("one", &[long.as_str()]),
            listing("two", &[long.as_str()]),
            listing("one", &[]),
        ]);
        let names = advertised(&arr);
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), 2, "{names:?}");
        assert!(names.iter().all(|n| n.len() <= 64));
        assert_eq!(to_server.len(), 2);
    }
}
