//! Key names the `press` action accepts, and the DevTools key events for them.

use serde_json::{json, Value};

/// One key press: what DevTools needs to dispatch it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySpec {
    pub key: String,
    pub code: String,
    pub vk: i64,
    /// The character it types, if it types one (and no command modifier is held).
    pub text: Option<String>,
    /// DevTools modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
    pub modifiers: i64,
    /// Editing commands for shortcuts a headless browser does not map itself.
    pub commands: Vec<&'static str>,
}

fn named(name: &str) -> Option<(&'static str, &'static str, i64, Option<&'static str>)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => ("Enter", "Enter", 13, Some("\r")),
        "escape" | "esc" => ("Escape", "Escape", 27, None),
        "tab" => ("Tab", "Tab", 9, Some("\t")),
        "backspace" => ("Backspace", "Backspace", 8, None),
        "delete" | "del" => ("Delete", "Delete", 46, None),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, None),
        "home" => ("Home", "Home", 36, None),
        "end" => ("End", "End", 35, None),
        "pageup" => ("PageUp", "PageUp", 33, None),
        "pagedown" => ("PageDown", "PageDown", 34, None),
        "space" | " " => (" ", "Space", 32, Some(" ")),
        _ => return None,
    })
}

/// Parse `Enter`, `a`, `Control+A`, `Shift+Tab`. `None` for anything else.
pub fn parse(spec: &str) -> Option<KeySpec> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    // "+" itself is a key; otherwise the last "+"-separated part is the key.
    let (mods_part, key_part) = if spec == "+" {
        ("", "+")
    } else {
        match spec.rsplit_once('+') {
            Some((m, k)) if !k.is_empty() => (m, k),
            Some(_) => return None,
            None => ("", spec),
        }
    };
    let mut modifiers = 0;
    for m in mods_part.split('+').filter(|m| !m.is_empty()) {
        modifiers |= match m.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "control" | "ctrl" => 2,
            "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => return None,
        };
    }
    let command_held = modifiers & 7 != 0;
    let (key, code, vk, text) = if let Some((k, c, v, t)) = named(key_part) {
        (k.to_string(), c.to_string(), v, t.map(str::to_string))
    } else {
        let mut chars = key_part.chars();
        let c = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        let upper = c.to_ascii_uppercase();
        let (code, vk) = if c.is_ascii_alphabetic() {
            (format!("Key{upper}"), upper as i64)
        } else if c.is_ascii_digit() {
            (format!("Digit{c}"), c as i64)
        } else {
            (String::new(), c as i64)
        };
        let shown = if modifiers & 8 != 0 && c.is_ascii_lowercase() { upper } else { c };
        (shown.to_string(), code, vk, Some(shown.to_string()))
    };
    let commands = if modifiers & 2 != 0 || modifiers & 4 != 0 {
        match key_part.to_ascii_lowercase().as_str() {
            "a" => vec!["selectAll"],
            "c" => vec!["copy"],
            "x" => vec!["cut"],
            "v" => vec!["paste"],
            "z" if modifiers & 8 != 0 => vec!["redo"],
            "z" => vec!["undo"],
            _ => vec![],
        }
    } else {
        vec![]
    };
    Some(KeySpec {
        key,
        code,
        vk,
        text: if command_held { None } else { text },
        modifiers,
        commands,
    })
}

impl KeySpec {
    /// The `Input.dispatchKeyEvent` parameters for the down and up events.
    pub fn events(&self) -> [Value; 2] {
        let mut down = json!({
            "type": if self.text.is_some() { "keyDown" } else { "rawKeyDown" },
            "key": self.key,
            "code": self.code,
            "windowsVirtualKeyCode": self.vk,
            "modifiers": self.modifiers,
        });
        if let Some(t) = &self.text {
            down["text"] = json!(t);
            down["unmodifiedText"] = json!(t);
        }
        if !self.commands.is_empty() {
            down["commands"] = json!(self.commands);
        }
        let up = json!({
            "type": "keyUp",
            "key": self.key,
            "code": self.code,
            "windowsVirtualKeyCode": self.vk,
            "modifiers": self.modifiers,
        });
        [down, up]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_carry_their_codes_and_enter_types_a_return() {
        let k = parse("Enter").unwrap();
        assert_eq!((k.key.as_str(), k.vk, k.text.as_deref()), ("Enter", 13, Some("\r")));
        assert_eq!(parse("esc").unwrap().key, "Escape");
        assert_eq!(parse("ArrowDown").unwrap().vk, 40);
        assert_eq!(parse("Space").unwrap().text.as_deref(), Some(" "));
    }

    #[test]
    fn a_single_character_is_a_key_and_types_itself() {
        let k = parse("a").unwrap();
        assert_eq!((k.code.as_str(), k.vk, k.text.as_deref()), ("KeyA", 65, Some("a")));
        assert_eq!(parse("7").unwrap().code, "Digit7");
    }

    #[test]
    fn modifiers_combine_and_a_shortcut_types_nothing() {
        let k = parse("Control+A").unwrap();
        assert_eq!(k.modifiers, 2);
        assert!(k.text.is_none());
        assert_eq!(k.commands, vec!["selectAll"]);
        assert_eq!(parse("Shift+Tab").unwrap().modifiers, 8);
        assert_eq!(parse("Control+Shift+Z").unwrap().commands, vec!["redo"]);
        assert_eq!(parse("Shift+a").unwrap().text.as_deref(), Some("A"));
    }

    #[test]
    fn nonsense_is_refused() {
        for bad in ["", "  ", "Hyper+A", "Control+", "NotAKey", "ab"] {
            assert!(parse(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn events_are_a_down_and_an_up() {
        let [down, up] = parse("Enter").unwrap().events();
        assert_eq!(down["type"], "keyDown");
        assert_eq!(down["text"], "\r");
        assert_eq!(up["type"], "keyUp");
        assert_eq!(parse("Escape").unwrap().events()[0]["type"], "rawKeyDown");
    }
}
