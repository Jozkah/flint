//! Two sessions on one folder, through the real tool handlers.

use std::path::Path;

use serde_json::json;

use crate::session_mailbox::Mailbox;
use crate::tools::handlers::execute_text;
use crate::tools::{lookup, ToolContext};

struct Folder {
    _data: tempfile::TempDir,
    repo: tempfile::TempDir,
    store: tempfile::TempDir,
}

impl Folder {
    fn new() -> Self {
        let f = Folder {
            _data: tempfile::tempdir().unwrap(),
            repo: tempfile::tempdir().unwrap(),
            store: tempfile::tempdir().unwrap(),
        };
        std::fs::create_dir_all(f.repo.path().join(".git/refs/heads")).unwrap();
        std::fs::write(f.repo.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(f.repo.path().join("x.txt"), "one\n").unwrap();
        f
    }

    fn data(&self) -> &Path {
        self._data.path()
    }

    fn join(&self, id: &str, name: &str, isolated: bool) {
        Mailbox::open(self.data())
            .register_shared(id, name, self.repo.path().to_str(), None, None, Some(isolated))
            .unwrap();
    }

    fn ctx<'a>(&'a self, id: &'a str) -> ToolContext<'a> {
        ToolContext::new(self.repo.path(), self.store.path(), &[])
            .in_session(Some(id), false)
            .with_mailbox(self.data())
    }
}

async fn call(ctx: &ToolContext<'_>, tool: &str, args: serde_json::Value) -> String {
    execute_text(lookup(tool).unwrap(), &args, ctx).await
}

fn edit_args(old: &str, new: &str) -> serde_json::Value {
    json!({ "path": "x.txt", "edits": [{ "old_string": old, "new_string": new }] })
}

#[tokio::test]
async fn a_claims_b_is_held_b_messages_and_the_retry_goes_through() {
    let f = Folder::new();
    f.join("scn-a", "Alpha", false);
    f.join("scn-b", "Beta", false);
    let (a, b) = (f.ctx("scn-a"), f.ctx("scn-b"));

    // A reads and edits: A holds the claim.
    call(&a, "read", json!({ "path": "x.txt" })).await;
    let out = call(&a, "edit", edit_args("one", "two")).await;
    assert!(out.starts_with("Applied"), "{out}");

    // B reads and tries: held, plain text, naming A.
    call(&b, "read", json!({ "path": "x.txt" })).await;
    let held = call(&b, "edit", edit_args("two", "three")).await;
    assert_eq!(
        held,
        "Not written. x.txt is being edited by Alpha. Message them with send_message, \
         re-read the file, then retry."
    );
    assert_eq!(std::fs::read_to_string(f.repo.path().join("x.txt")).unwrap(), "two\n");

    // B messages A with the existing tool, then retries: it goes through. The
    // retry rule needs the message to be strictly later than the hold (both are
    // millisecond timestamps), so wait before sending, not after: on a fast
    // machine the hold and the message otherwise share a millisecond.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let sent = call(&b, "send_message", json!({ "to": "Alpha", "message": "editing x.txt next" })).await;
    assert!(sent.contains("message_id"), "{sent}");
    let out = call(&b, "edit", edit_args("two", "three")).await;
    assert!(out.starts_with("Applied"), "{out}");
    assert_eq!(std::fs::read_to_string(f.repo.path().join("x.txt")).unwrap(), "three\n");
}

#[tokio::test]
async fn the_hash_check_still_stops_an_edit_over_a_changed_file() {
    let f = Folder::new();
    f.join("scn-c", "Gamma", false);
    let c = f.ctx("scn-c");
    call(&c, "read", json!({ "path": "x.txt" })).await;
    std::fs::write(f.repo.path().join("x.txt"), "changed behind its back\n").unwrap();
    let out = call(&c, "edit", edit_args("one", "two")).await;
    assert!(out.contains("modified since it was read"), "{out}");
}

#[tokio::test]
async fn a_run_end_frees_the_file() {
    let f = Folder::new();
    f.join("scn-d", "Delta", false);
    f.join("scn-e", "Epsilon", false);
    let (d, e) = (f.ctx("scn-d"), f.ctx("scn-e"));
    let mailbox = Mailbox::open(f.data());
    mailbox.set_status("scn-d", true, Some("r")).unwrap();
    call(&d, "read", json!({ "path": "x.txt" })).await;
    call(&d, "edit", edit_args("one", "two")).await;
    call(&e, "read", json!({ "path": "x.txt" })).await;
    assert!(call(&e, "edit", edit_args("two", "three")).await.starts_with("Not written."));
    mailbox.set_status("scn-d", false, Some("r")).unwrap();
    call(&e, "read", json!({ "path": "x.txt" })).await;
    assert!(call(&e, "edit", edit_args("two", "three")).await.starts_with("Applied"));
}

#[tokio::test]
async fn an_isolated_session_edits_freely() {
    let f = Folder::new();
    f.join("scn-f", "Zeta", false);
    f.join("scn-g", "Eta", true);
    let (z, h) = (f.ctx("scn-f"), f.ctx("scn-g"));
    call(&z, "read", json!({ "path": "x.txt" })).await;
    call(&z, "edit", edit_args("one", "two")).await;
    call(&h, "read", json!({ "path": "x.txt" })).await;
    let out = call(&h, "edit", edit_args("two", "three")).await;
    assert!(out.starts_with("Applied"), "{out}");
}

#[tokio::test]
async fn a_call_without_a_mailbox_identity_is_never_held() {
    let f = Folder::new();
    f.join("scn-h", "Theta", false);
    let t = f.ctx("scn-h");
    call(&t, "read", json!({ "path": "x.txt" })).await;
    call(&t, "edit", edit_args("one", "two")).await;
    // The CLI shape: a session id for the stale check, no mailbox.
    let cli = ToolContext::new(f.repo.path(), f.store.path(), &[]).in_session(Some("cli"), false);
    call(&cli, "read", json!({ "path": "x.txt" })).await;
    let out = call(&cli, "edit", edit_args("two", "three")).await;
    assert!(out.starts_with("Applied"), "{out}");
}

#[tokio::test]
async fn bash_git_checkout_is_held_while_another_session_is_in_the_tree() {
    let f = Folder::new();
    f.join("scn-i", "Iota", false);
    f.join("scn-j", "Kappa", false);
    let j = f.ctx("scn-j");
    let out = call(&j, "bash", json!({ "command": "cd . && git checkout feat/multi-game-catalog" })).await;
    assert_eq!(
        out,
        "Not run. Iota is working on main in this folder. Switching changes its files. \
         Start an isolated worktree for this session or message them."
    );
}

#[tokio::test]
async fn a_branch_moved_by_someone_else_is_reported_on_the_next_tool_result() {
    let f = Folder::new();
    f.join("scn-k", "Lambda", false);
    f.join("scn-l", "Mu", false);
    let k = f.ctx("scn-k");
    let (out, _) = crate::tools::handlers::execute_builtin(lookup("ls").unwrap(), &json!({}), &k).await;
    assert!(!out.contains("branch changed"), "{out}");
    std::fs::write(f.repo.path().join(".git/HEAD"), "ref: refs/heads/feat/multi-game-catalog\n").unwrap();
    let (out, _) = crate::tools::handlers::execute_builtin(lookup("ls").unwrap(), &json!({}), &k).await;
    assert!(
        out.contains(
            "The branch changed from main to feat/multi-game-catalog since your last step. \
             Do not commit until it is back (or ask Mu)."
        ),
        "{out}"
    );
    let (out, _) = crate::tools::handlers::execute_builtin(lookup("ls").unwrap(), &json!({}), &k).await;
    assert!(!out.contains("branch changed"), "said once: {out}");
}
