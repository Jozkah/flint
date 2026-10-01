//! Message versions on the Rust side: a port of `web-app/src/lib/message-branching.ts`.
//!
//! A thread's messages form a tree. `metadata.parentId` links a message to its
//! predecessor (`null` is an explicit root, absent means a legacy unlinked
//! message), and `metadata.activeChildId` on a parent picks which child is
//! shown (absent: the newest by `created_at`). A thread's own
//! `metadata.activeRootId` picks among the roots. Threads that carry none of
//! this are linear and are returned unchanged.
//!
//! Everything here is pure over `serde_json::Value` so the desktop commands,
//! the CLI and the mobile SQLite store share one implementation and it is
//! tested without a database.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

/// `Some(None)` is an explicit root, `Some(Some(id))` a parent, `None` legacy.
fn raw_parent(m: &Value) -> Option<Option<String>> {
    match m.pointer("/metadata/parentId") {
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        _ => None,
    }
}

fn parent_id(m: &Value) -> Option<String> {
    raw_parent(m).flatten()
}

fn active_child_id(m: &Value) -> Option<String> {
    m.pointer("/metadata/activeChildId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn id_of(m: &Value) -> &str {
    m.get("id").and_then(Value::as_str).unwrap_or("")
}

fn created_at(m: &Value) -> i64 {
    m.get("created_at").and_then(Value::as_i64).unwrap_or(0)
}

/// True once any message carries branching metadata.
pub fn has_branching(messages: &[Value]) -> bool {
    messages.iter().any(|m| {
        m.pointer("/metadata/parentId").is_some() || m.pointer("/metadata/activeChildId").is_some()
    })
}

/// Children of `parent` (`None` = the roots), oldest first.
fn children_of<'a>(messages: &'a [Value], parent: Option<&str>) -> Vec<&'a Value> {
    let mut kids: Vec<&Value> = messages
        .iter()
        .filter(|m| match (raw_parent(m), parent) {
            (Some(None), None) => true,
            (Some(Some(p)), Some(want)) => p == want,
            _ => false,
        })
        .collect();
    kids.sort_by_key(|m| created_at(m));
    kids
}

fn pick_active_child<'a>(messages: &'a [Value], parent: &Value) -> Option<&'a Value> {
    let kids = children_of(messages, Some(id_of(parent)));
    let chosen = active_child_id(parent).and_then(|want| kids.iter().find(|c| id_of(c) == want));
    chosen.copied().or_else(|| kids.last().copied())
}

/// The conversation that is shown: from the active root down the active child
/// at each node. A thread with no branching is returned whole.
pub fn active_path(messages: &[Value], active_root_id: Option<&str>) -> Vec<Value> {
    if !has_branching(messages) {
        return messages.to_vec();
    }
    let roots = children_of(messages, None);
    if roots.is_empty() {
        return messages.to_vec();
    }
    let root = active_root_id
        .and_then(|want| roots.iter().find(|r| id_of(r) == want))
        .or_else(|| roots.last())
        .copied();
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut cur = root;
    while let Some(node) = cur {
        if !seen.insert(id_of(node).to_string()) {
            break;
        }
        path.push(node.clone());
        cur = pick_active_child(messages, node);
    }
    path
}

fn set_meta(m: &mut Value, key: &str, value: Value) {
    if !m.get("metadata").map_or(false, Value::is_object) {
        m["metadata"] = json!({});
    }
    m["metadata"][key] = value;
}

/// Take `remove_id` out of the tree without cutting off what hangs below it,
/// as `removeFromTree` does: each child is re-parented to the removed
/// message's parent, and a parent whose `activeChildId` was missing or pointed
/// at the removed message now points at the child that took its place.
///
/// Returns only the surviving messages that changed and need a write. A thread
/// with no branching returns nothing.
pub fn reparent_on_delete(messages: &[Value], remove_id: &str) -> Vec<Value> {
    if !has_branching(messages) {
        return Vec::new();
    }
    let by_id: HashMap<&str, &Value> = messages.iter().map(|m| (id_of(m), m)).collect();
    let mut writes: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let removed_parent = by_id.get(remove_id).and_then(|m| parent_id(m));

    let mut sorted: Vec<&Value> = messages.iter().collect();
    sorted.sort_by_key(|m| created_at(m));
    for child in sorted {
        let cid = id_of(child);
        if cid == remove_id {
            continue;
        }
        let current = writes.get(cid).cloned().unwrap_or_else(|| child.clone());
        if parent_id(&current).as_deref() != Some(remove_id) {
            continue;
        }
        let mut updated = current;
        set_meta(
            &mut updated,
            "parentId",
            removed_parent.clone().map_or(Value::Null, Value::String),
        );
        if !writes.contains_key(cid) {
            order.push(cid.to_string());
        }
        writes.insert(cid.to_string(), updated);

        if let Some(pid) = &removed_parent {
            let Some(parent) = by_id.get(pid.as_str()) else {
                continue;
            };
            let parent_now = writes.get(pid).cloned().unwrap_or_else(|| (*parent).clone());
            let active = active_child_id(&parent_now);
            if active.is_none() || active.as_deref() == Some(remove_id) {
                let mut p = parent_now;
                set_meta(&mut p, "activeChildId", Value::String(cid.to_string()));
                if !writes.contains_key(pid) {
                    order.push(pid.clone());
                }
                writes.insert(pid.clone(), p);
            }
        }
    }
    order.into_iter().filter_map(|id| writes.remove(&id)).collect()
}

/// `messages` without `remove_id`, its children and their parent repaired.
pub fn remove_message(messages: Vec<Value>, remove_id: &str) -> Vec<Value> {
    let writes: HashMap<String, Value> = reparent_on_delete(&messages, remove_id)
        .into_iter()
        .map(|m| (id_of(&m).to_string(), m))
        .collect();
    messages
        .into_iter()
        .filter(|m| id_of(m) != remove_id)
        .map(|m| writes.get(id_of(&m)).cloned().unwrap_or(m))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, at: i64, parent: Option<Option<&str>>, active: Option<&str>) -> Value {
        let mut meta = serde_json::Map::new();
        match parent {
            Some(None) => {
                meta.insert("parentId".into(), Value::Null);
            }
            Some(Some(p)) => {
                meta.insert("parentId".into(), json!(p));
            }
            None => {}
        }
        if let Some(a) = active {
            meta.insert("activeChildId".into(), json!(a));
        }
        json!({"id": id, "created_at": at, "role": "user", "metadata": meta})
    }

    fn ids(v: &[Value]) -> Vec<&str> {
        v.iter().map(id_of).collect()
    }

    // u1 -> a1 (old), a1b (regenerated, newer) -> u2 under a1b
    fn branched() -> Vec<Value> {
        vec![
            msg("u1", 1, Some(None), None),
            msg("a1", 2, Some(Some("u1")), None),
            msg("a1b", 3, Some(Some("u1")), None),
            msg("u2", 4, Some(Some("a1b")), None),
        ]
    }

    #[test]
    fn a_legacy_linear_thread_is_returned_whole() {
        let m = vec![
            json!({"id": "a", "created_at": 1}),
            json!({"id": "b", "created_at": 2, "metadata": {"usage": 1}}),
        ];
        assert!(!has_branching(&m));
        assert_eq!(active_path(&m, None), m);
        assert!(reparent_on_delete(&m, "a").is_empty());
        assert_eq!(ids(&remove_message(m, "a")), vec!["b"]);
    }

    #[test]
    fn the_newest_version_is_shown_by_default() {
        assert_eq!(ids(&active_path(&branched(), None)), vec!["u1", "a1b", "u2"]);
    }

    #[test]
    fn active_child_id_selects_an_older_version() {
        let mut m = branched();
        m[0] = msg("u1", 1, Some(None), Some("a1"));
        assert_eq!(ids(&active_path(&m, None)), vec!["u1", "a1"]);
    }

    #[test]
    fn a_stale_active_child_falls_back_to_the_newest() {
        let mut m = branched();
        m[0] = msg("u1", 1, Some(None), Some("gone"));
        assert_eq!(ids(&active_path(&m, None)), vec!["u1", "a1b", "u2"]);
    }

    #[test]
    fn the_thread_picks_among_roots() {
        let m = vec![msg("r1", 1, Some(None), None), msg("r2", 2, Some(None), None)];
        assert_eq!(ids(&active_path(&m, Some("r1"))), vec!["r1"]);
        assert_eq!(ids(&active_path(&m, Some("nope"))), vec!["r2"]);
        assert_eq!(ids(&active_path(&m, None)), vec!["r2"]);
    }

    #[test]
    fn a_cycle_does_not_loop() {
        let m = vec![
            msg("x", 1, Some(Some("y")), None),
            msg("y", 2, Some(Some("x")), None),
            msg("r", 3, Some(None), None),
        ];
        assert_eq!(ids(&active_path(&m, None)), vec!["r"]);
    }

    #[test]
    fn deleting_a_middle_message_reparents_its_children() {
        // u1 -> a1b -> u2 : drop a1b, u2 hangs off u1 and u1 points at u2.
        let m = remove_message(branched(), "a1b");
        assert_eq!(ids(&m), vec!["u1", "a1", "u2"]);
        let u2 = m.iter().find(|x| id_of(x) == "u2").unwrap();
        assert_eq!(parent_id(u2).as_deref(), Some("u1"));
        let u1 = m.iter().find(|x| id_of(x) == "u1").unwrap();
        assert_eq!(active_child_id(u1).as_deref(), Some("u2"));
        assert_eq!(ids(&active_path(&m, None)), vec!["u1", "u2"]);
    }

    #[test]
    fn a_parent_keeps_an_active_child_that_is_not_the_removed_one() {
        let mut m = branched();
        m[0] = msg("u1", 1, Some(None), Some("a1"));
        let out = remove_message(m, "a1b");
        let u1 = out.iter().find(|x| id_of(x) == "u1").unwrap();
        assert_eq!(active_child_id(u1).as_deref(), Some("a1"));
    }

    #[test]
    fn deleting_a_root_promotes_its_children_to_roots() {
        let out = remove_message(branched(), "u1");
        let a1 = out.iter().find(|x| id_of(x) == "a1").unwrap();
        assert_eq!(a1.pointer("/metadata/parentId"), Some(&Value::Null));
        assert_eq!(ids(&out), vec!["a1", "a1b", "u2"]);
    }

    #[test]
    fn deleting_a_leaf_changes_nothing_else() {
        assert!(reparent_on_delete(&branched(), "u2").is_empty());
        assert_eq!(ids(&remove_message(branched(), "u2")), vec!["u1", "a1", "a1b"]);
    }

    #[test]
    fn deleting_an_unknown_id_is_harmless() {
        assert_eq!(remove_message(branched(), "zzz"), branched());
    }
}
