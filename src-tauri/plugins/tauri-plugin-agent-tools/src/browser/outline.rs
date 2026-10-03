//! The model-facing view of a page: a compact outline of what is visible and
//! what can be acted on, each actionable element carrying a short ref (`e12`).
//!
//! The page-side script (`page_helper.js`) reads the DOM and assigns refs; this
//! module turns its answer into text and holds the caps, so a page of any size
//! costs the model a bounded number of characters.

use serde::Deserialize;
use serde_json::Value;

/// Hard cap on the outline's characters (before the untrusted-content fence).
pub const MAX_OUTLINE_CHARS: usize = 6_000;
/// Longest URL or title echoed back.
const MAX_HEADER_FIELD: usize = 300;

/// The page-side helper, evaluated in the page. Idempotent: a second
/// evaluation returns the helper already installed (and its refs).
pub const HELPER_JS: &str = include_str!("page_helper.js");

/// A JS expression that calls `method` on the page helper with JSON `args`.
pub fn call_expression(method: &str, args: &[Value]) -> String {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    format!("({HELPER_JS}).{method}({})", args.join(","))
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Scroll {
    #[serde(default)]
    pub x: i64,
    #[serde(default)]
    pub y: i64,
    #[serde(default)]
    pub w: i64,
    #[serde(default)]
    pub h: i64,
    #[serde(default)]
    pub vw: i64,
    #[serde(default)]
    pub vh: i64,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Node {
    #[serde(default, rename = "ref")]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub level: Option<u8>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub depth: usize,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Snapshot {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub scroll: Scroll,
    #[serde(default)]
    pub nodes: Vec<Node>,
    /// Elements the page-side walk dropped at its own limit.
    #[serde(default)]
    pub truncated: usize,
}

/// Collapse whitespace, drop control characters and swap double quotes, so a
/// name can sit between quotes on one line.
fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_control() || c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(if c == '"' { '\'' } else { c });
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
    t.push('…');
    t
}

fn line(n: &Node) -> String {
    let indent = "  ".repeat(n.depth.min(4));
    let name = clip(&one_line(&n.name), 120);
    match n.role.as_str() {
        "text" => format!("{indent}- text: {name}"),
        "heading" => format!("{indent}- heading[{}] \"{name}\"", n.level.unwrap_or(0)),
        _ => {
            let mut s = format!("{indent}- {}", n.role);
            if !name.is_empty() {
                s.push_str(&format!(" \"{name}\""));
            }
            if let Some(r) = &n.r#ref {
                s.push_str(&format!(" [{r}]"));
            }
            if let Some(v) = n.value.as_deref().filter(|v| !v.is_empty()) {
                s.push_str(&format!(" value=\"{}\"", clip(&one_line(v), 80)));
            }
            for st in &n.states {
                s.push(' ');
                s.push_str(st);
            }
            if let Some(h) = n.href.as_deref().filter(|h| !h.is_empty()) {
                s.push_str(&format!(" -> {}", clip(&one_line(h), 80)));
            }
            if !n.options.is_empty() {
                let opts: Vec<String> = n.options.iter().map(|o| clip(&one_line(o), 30)).collect();
                s.push_str(&format!(" options: {}", opts.join(" | ")));
            }
            s
        }
    }
}

/// The text the model reads. At most [`MAX_OUTLINE_CHARS`] characters (plus a
/// one-line truncation note), whatever the page held.
pub fn format(snap: &Snapshot) -> String {
    format_with_cap(snap, MAX_OUTLINE_CHARS)
}

pub fn format_with_cap(snap: &Snapshot, cap: usize) -> String {
    let s = &snap.scroll;
    let mut out = format!(
        "url: {}\ntitle: {}\nview: scrolled {}px of {}px tall, viewport {}x{}\n",
        clip(&one_line(&snap.url), MAX_HEADER_FIELD),
        clip(&one_line(&snap.title), MAX_HEADER_FIELD),
        s.y,
        s.h,
        s.vw,
        s.vh
    );
    let mut used = out.chars().count();
    let mut shown = 0usize;
    for n in &snap.nodes {
        let l = line(n);
        let cost = l.chars().count() + 1;
        if used + cost > cap {
            break;
        }
        out.push_str(&l);
        out.push('\n');
        used += cost;
        shown += 1;
    }
    let hidden = snap.nodes.len() - shown + snap.truncated;
    if hidden > 0 {
        out.push_str(&format!(
            "[outline cut: {hidden} more elements not shown. Scroll and snapshot again, or snapshot with a ref to see one part.]\n"
        ));
    } else if snap.nodes.is_empty() {
        out.push_str("[nothing visible on this page yet. It may still be loading: wait, then snapshot again.]\n");
    }
    out
}

/// Whether `s` has the shape of a ref this tool hands out.
pub fn is_ref(s: &str) -> bool {
    s.strip_prefix('e')
        .is_some_and(|d| !d.is_empty() && d.len() <= 7 && d.bytes().all(|b| b.is_ascii_digit()))
}

/// What to tell the model when a ref no longer names anything.
pub fn stale_message(r: &str) -> String {
    format!(
        "ERROR: ref {r} is not on the current page. The page changed since your last snapshot (or the ref is wrong). Call browser with action \"snapshot\" and use the refs it lists."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snap(v: Value) -> Snapshot {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn refs_have_one_shape() {
        assert!(is_ref("e1") && is_ref("e12") && is_ref("e1234567"));
        assert!(!is_ref("e") && !is_ref("12") && !is_ref("E3") && !is_ref("e1a") && !is_ref("e 3"));
        assert!(!is_ref("e12345678"), "absurdly long refs are not refs");
    }

    #[test]
    fn an_outline_lists_roles_names_refs_and_state() {
        let s = snap(json!({
            "url": "http://127.0.0.1:5000/", "title": "Demo",
            "scroll": {"x":0,"y":0,"w":1280,"h":2000,"vw":1280,"vh":800},
            "nodes": [
                {"role":"heading","name":"Sign in","level":1,"depth":0},
                {"role":"textbox","name":"Email","ref":"e1","value":"a@b.c","states":["required"],"depth":0},
                {"role":"checkbox","name":"Remember me","ref":"e2","states":["checked"],"depth":0},
                {"role":"combobox","name":"Country","ref":"e3","value":"France","options":["France","Italy"],"depth":0},
                {"role":"link","name":"Docs","ref":"e4","href":"/docs","depth":1},
                {"role":"button","name":"Go","ref":"e5","states":["disabled"],"depth":1},
                {"role":"text","name":"Plain words","depth":1}
            ]
        }));
        let t = format(&s);
        assert!(t.starts_with("url: http://127.0.0.1:5000/\ntitle: Demo\n"), "{t}");
        assert!(t.contains("- heading[1] \"Sign in\"\n"), "{t}");
        assert!(t.contains("- textbox \"Email\" [e1] value=\"a@b.c\" required\n"), "{t}");
        assert!(t.contains("- checkbox \"Remember me\" [e2] checked\n"), "{t}");
        assert!(t.contains("- combobox \"Country\" [e3] value=\"France\" options: France | Italy\n"), "{t}");
        assert!(t.contains("  - link \"Docs\" [e4] -> /docs\n"), "{t}");
        assert!(t.contains("  - button \"Go\" [e5] disabled\n"), "{t}");
        assert!(t.contains("  - text: Plain words\n"), "{t}");
        assert!(!t.contains("outline cut"), "{t}");
    }

    #[test]
    fn a_huge_page_is_cut_at_the_cap_with_a_note() {
        let nodes: Vec<Value> = (0..3000)
            .map(|i| json!({"role":"button","name":format!("Button number {i}"),"ref":format!("e{i}"),"depth":0}))
            .collect();
        let s = snap(json!({"url":"http://x/","title":"t","nodes":nodes,"truncated":50}));
        let t = format(&s);
        let body_limit = MAX_OUTLINE_CHARS + 200;
        assert!(t.chars().count() <= body_limit, "{} chars", t.chars().count());
        assert!(t.contains("outline cut:"), "{}", &t[t.len().saturating_sub(200)..]);
        // The count of what was dropped includes the page-side truncation.
        let dropped: usize = t
            .split("outline cut: ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap();
        assert!(dropped > 2000 + 50 - 1000, "{dropped}");
    }

    #[test]
    fn names_stay_on_one_line_and_quotes_cannot_break_out() {
        let s = snap(json!({"nodes":[
            {"role":"button","name":"Say \"hi\"\nthen\tgo\u{7}","ref":"e1","depth":0},
            {"role":"text","name":"x".repeat(1000),"depth":0}
        ]}));
        let t = format(&s);
        assert!(t.contains("- button \"Say 'hi' then go\" [e1]\n"), "{t}");
        let long = t.lines().find(|l| l.starts_with("- text: ")).unwrap();
        assert!(long.chars().count() <= 130, "{}", long.chars().count());
    }

    #[test]
    fn an_empty_page_says_so() {
        let t = format(&snap(json!({"url":"about:blank"})));
        assert!(t.contains("nothing visible"), "{t}");
    }

    #[test]
    fn deep_nesting_is_flattened_to_four_levels() {
        let s = snap(json!({"nodes":[{"role":"text","name":"deep","depth":9}]}));
        assert!(format(&s).contains("\n        - text: deep"), "{}", format(&s));
    }

    #[test]
    fn the_stale_message_tells_the_model_what_to_do() {
        let m = stale_message("e7");
        assert!(m.starts_with("ERROR: ref e7"), "{m}");
        assert!(m.contains("snapshot"), "{m}");
    }

    #[test]
    fn a_call_expression_embeds_the_helper_and_json_args() {
        let e = call_expression("locate", &[json!("e3")]);
        assert!(e.starts_with("(") && e.contains(").locate(\"e3\")"), "{}", &e[e.len() - 30..]);
        assert!(HELPER_JS.contains("Symbol.for('flint.browser.v1')"));
    }
}
