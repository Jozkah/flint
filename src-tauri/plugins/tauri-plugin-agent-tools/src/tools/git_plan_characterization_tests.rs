//! Characterization of `git_plan` (Q1-023): every call in the corpus is
//! classified exactly as it was before the function was split into steps.
//! The expected text was produced by the unsplit function; regenerate it only
//! for an intended behaviour change, with `UPDATE_GIT_PLAN_GOLDEN=1`.

use super::plan;

const CORPUS: &[&[&str]] = &[
    &[],
    &["--no-pager"],
    &["--no-pager", "status"],
    &["-C", "/x", "status"],
    &["-C/x", "log"],
    &["-c", "core.pager=less", "log"],
    &["status"],
    &["log", "--oneline", "-5"],
    &["diff"],
    &["diff", "--cached"],
    &["diff", "--output=/tmp/x"],
    &["diff", "--textconv"],
    &["diff-tree", "HEAD"],
    &["range-diff", "a...b"],
    &["show", "HEAD"],
    &["blame", "src/a.rs"],
    &["grep", "foo"],
    &["merge-tree", "--write-tree", "a", "b"],
    &["merge-tree", "a", "b"],
    &["merge-tree", "--write-tree", "-x", "b"],
    &["ls-remote", "origin"],
    &["ls-remote", "--upload-pack", "x", "origin"],
    &["ls-remote", "ext::sh -c x"],
    &["branch"],
    &["branch", "-a"],
    &["branch", "feature"],
    &["branch", "-d", "feature"],
    &["branch", "-D", "feature"],
    &["branch", "-d", "-f", "feature"],
    &["branch", "-m", "old", "new"],
    &["branch", "--contains", "abc"],
    &["tag"],
    &["tag", "-l"],
    &["tag", "v1"],
    &["tag", "-a", "v1", "-m", "msg"],
    &["tag", "-f", "v1"],
    &["tag", "-d", "v1"],
    &["tag", "-F", "/etc/passwd", "v1"],
    &["remote"],
    &["remote", "-v"],
    &["remote", "show", "origin"],
    &["remote", "get-url", "origin"],
    &["remote", "add", "up", "https://github.com/a/b.git"],
    &["remote", "add", "up", "ext::sh -c x"],
    &["remote", "set-url", "origin", "file:///tmp/x"],
    &["remote", "remove", "up"],
    &["remote", "frobnicate"],
    &["stash"],
    &["stash", "list"],
    &["stash", "show"],
    &["stash", "drop"],
    &["stash", "clear"],
    &["stash", "pop"],
    &["config", "--get", "user.name"],
    &["config", "user.name"],
    &["config", "get", "user.name"],
    &["config", "--list"],
    &["config", "user.name", "x"],
    &["config", "--global", "user.name"],
    &["worktree", "list"],
    &["worktree", "add", "../wt"],
    &["worktree", "remove", "--force", "../wt"],
    &["worktree", "remove", "../wt"],
    &["worktree", "frob"],
    &["worktree"],
    &["reflog"],
    &["reflog", "expire"],
    &["reflog", "delete", "HEAD@{1}"],
    &["reset", "HEAD~1"],
    &["reset", "--hard", "HEAD~1"],
    &["reset", "--keep"],
    &["clean", "-n"],
    &["clean", "-fdn"],
    &["clean", "-fd"],
    &["checkout", "main"],
    &["checkout", "-b", "feature"],
    &["checkout", "-B", "feature"],
    &["checkout", "--", "."],
    &["checkout", "-f", "main"],
    &["switch", "main"],
    &["switch", "-c", "feature"],
    &["switch", "-C", "feature"],
    &["switch", "--discard-changes", "main"],
    &["restore", "a.txt"],
    &["restore", "--staged", "a.txt"],
    &["restore", "--staged", "--worktree", "a.txt"],
    &["rm", "a.txt"],
    &["rm", "-f", "a.txt"],
    &["commit", "-m", "msg"],
    &["commit", "-F", "msg.txt"],
    &["commit", "-F", "../../etc/x"],
    &["merge", "feature"],
    &["merge", "-Xours", "feature"],
    &["am", "patch.mbox"],
    &["apply", "x.patch"],
    &["add", "."],
    &["mv", "a", "b"],
    &["rebase", "main"],
    &["cherry-pick", "abc"],
    &["revert", "abc"],
    &["init"],
    &["init", "newrepo"],
    &["sparse-checkout", "list"],
    &["update-index", "--skip-worktree", "a"],
    &["clone", "https://github.com/a/b.git"],
    &["clone", "-b", "dev", "https://github.com/a/b.git", "dest"],
    &["clone"],
    &["clone", "ext::sh -c x"],
    &["clone", "--upload-pack=x", "https://github.com/a/b.git"],
    &["fetch"],
    &["fetch", "origin"],
    &["fetch", "origin", "main"],
    &["fetch", "--all"],
    &["pull", "origin", "main"],
    &["pull", "-s", "ours", "origin"],
    &["push"],
    &["push", "origin", "main"],
    &["push", "--force", "origin", "main"],
    &["push", "origin", "+main"],
    &["push", "origin", ":old"],
    &["push", "--delete", "origin", "old"],
    &["push", "--repo", "https://github.com/a/b.git"],
    &["push", "--repo=https://github.com/a/b.git", "main"],
    &["push", "--receive-pack=x", "origin"],
    &["push", "--mirror", "origin"],
    &["gc"],
    &["filter-branch"],
    &["submodule", "update"],
];

fn render() -> String {
    let mut out = String::new();
    for args in CORPUS {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        out.push_str(&format!("{args:?}\n  => {:?}\n", plan("git", &args)));
    }
    out
}

#[test]
fn git_plan_classifies_the_corpus_as_before() {
    let golden = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/tools/git_plan_characterization.golden");
    let now = render();
    if std::env::var_os("UPDATE_GIT_PLAN_GOLDEN").is_some() {
        std::fs::write(&golden, &now).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&golden).unwrap().replace("\r\n", "\n");
    for (i, (a, b)) in want.lines().zip(now.lines()).enumerate() {
        assert_eq!(a, b, "line {} differs", i + 1);
    }
    assert_eq!(want.lines().count(), now.lines().count());
}
