//! A change as a patch someone else can read and apply. AH-168.
//!
//! Text files become a unified diff in the form `git apply` reads: a
//! `diff --git` header, `new file` and `deleted file` markers, three lines of
//! context and the "no newline at end of file" note. A file that is not text
//! -- not UTF-8, or holding a NUL byte -- cannot be carried faithfully in a
//! text diff, so it is listed apart and its new content is shipped whole next
//! to the patch.

use similar::TextDiff;

use crate::proposal::FileInput;

/// A file the patch cannot carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WholeFile {
    pub path: String,
    /// `None` when the change deletes it.
    pub content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatchText {
    pub patch: String,
    pub whole: Vec<WholeFile>,
}

fn as_text(bytes: Option<&[u8]>) -> Option<Option<&str>> {
    match bytes {
        None => Some(None),
        Some(b) if b.contains(&0) => None,
        Some(b) => std::str::from_utf8(b).ok().map(Some),
    }
}

/// The unified patch for these changes, in path order.
pub fn unified_patch(inputs: &[FileInput]) -> PatchText {
    let mut sorted: Vec<&FileInput> = inputs.iter().filter(|i| i.base != i.proposed).collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut out = PatchText::default();
    for input in sorted {
        let (Some(base), Some(new)) = (as_text(input.base.as_deref()), as_text(input.proposed.as_deref()))
        else {
            out.whole.push(WholeFile {
                path: input.path.clone(),
                content: input.proposed.clone(),
            });
            continue;
        };
        let path = &input.path;
        out.patch.push_str(&format!("diff --git a/{path} b/{path}\n"));
        let (old_name, new_name) = match (base, new) {
            (None, _) => {
                out.patch.push_str("new file mode 100644\n");
                ("/dev/null".to_string(), format!("b/{path}"))
            }
            (_, None) => {
                out.patch.push_str("deleted file mode 100644\n");
                (format!("a/{path}"), "/dev/null".to_string())
            }
            _ => (format!("a/{path}"), format!("b/{path}")),
        };
        let (a, b) = (base.unwrap_or(""), new.unwrap_or(""));
        let diff = TextDiff::from_lines(a, b);
        let body = diff
            .unified_diff()
            .context_radius(3)
            .missing_newline_hint(true)
            .header(&old_name, &new_name)
            .to_string();
        out.patch.push_str(&body);
        if !body.is_empty() && !body.ends_with('\n') {
            out.patch.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, base: Option<&str>, new: Option<&str>) -> FileInput {
        FileInput {
            path: path.into(),
            base: base.map(|s| s.as_bytes().to_vec()),
            proposed: new.map(|s| s.as_bytes().to_vec()),
        }
    }

    #[test]
    fn text_changes_become_one_git_style_patch() {
        let p = unified_patch(&[
            input("b.txt", Some("one\ntwo\n"), Some("one\nTWO\n")),
            input("a.txt", None, Some("new\n")),
            input("gone.txt", Some("bye\n"), None),
            input("same.txt", Some("x\n"), Some("x\n")),
        ]);
        assert!(p.whole.is_empty());
        let a = p.patch.find("diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt").unwrap();
        let b = p.patch.find("diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt").unwrap();
        assert!(a < b, "files are in path order");
        assert!(p.patch.contains("-two\n+TWO\n"));
        assert!(p.patch.contains("deleted file mode 100644\n--- a/gone.txt\n+++ /dev/null"));
        assert!(!p.patch.contains("same.txt"), "an unchanged file is not in the patch");
    }

    #[test]
    fn a_missing_final_newline_is_marked() {
        let p = unified_patch(&[input("n.txt", Some("a\n"), Some("a\nb"))]);
        assert!(p.patch.contains("\\ No newline at end of file"), "{}", p.patch);
    }

    #[test]
    fn a_file_that_is_not_text_ships_whole() {
        let p = unified_patch(&[FileInput {
            path: "img.png".into(),
            base: Some(vec![0x89, 0x50, 0x00]),
            proposed: Some(vec![0x89, 0x50, 0x01, 0x00]),
        }]);
        assert!(p.patch.is_empty());
        assert_eq!(p.whole, vec![WholeFile { path: "img.png".into(), content: Some(vec![0x89, 0x50, 0x01, 0x00]) }]);
    }
}
