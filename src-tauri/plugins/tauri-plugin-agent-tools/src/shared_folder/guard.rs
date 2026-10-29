//! Which git commands change the working tree under everyone who shares it.
//!
//! A classification only: whether a hold applies is decided by the caller
//! (another live, non-isolated session must share the folder).

use crate::tools::cmdscan;
use crate::tools::git_tool::split_command_line;

/// A tree-changing git operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeChange {
    /// Short name for logs and tests: `checkout`, `switch`, `reset-hard`...
    pub kind: &'static str,
    /// The directory a `git -C <dir>` pointed at, when one was given.
    pub dir: Option<String>,
}

/// Answers what only the file system knows, so `git checkout notes.txt` (a
/// file restore) is told from `git checkout notes` (a branch).
pub trait Probe {
    /// An existing path that is not also the name of a branch.
    fn is_plain_path(&self, arg: &str) -> bool;
}

/// A probe that knows nothing: every lone `checkout <word>` is a switch.
pub struct NoProbe;

impl Probe for NoProbe {
    fn is_plain_path(&self, _arg: &str) -> bool {
        false
    }
}

/// Global options that take a separate value.
const VALUE_GLOBALS: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--exec-path",
];

/// Names people commonly give `checkout`. Heuristic: `git co` is nearly
/// always that alias.
const CHECKOUT_ALIASES: &[&str] = &["co"];

fn is_broad(spec: &str) -> bool {
    let s = spec.trim();
    matches!(s, "." | "./" | ":/" | ":/." | "*" | "**" | ":/*" | ":(top)" | ":(top)." | ":!")
        || s.starts_with(":(top")
        || s.starts_with(":/*")
}

fn short_cluster_has(arg: &str, c: char) -> bool {
    arg.starts_with('-') && !arg.starts_with("--") && arg.len() > 1 && arg[1..].contains(c)
}

fn flags(args: &[String]) -> impl Iterator<Item = &String> {
    args.iter().take_while(|a| a.as_str() != "--").filter(|a| a.starts_with('-'))
}

fn positionals(args: &[String]) -> Vec<&str> {
    args.iter()
        .take_while(|a| a.as_str() != "--")
        .filter(|a| !a.starts_with('-'))
        .map(String::as_str)
        .collect()
}

fn paths_after_dashdash(args: &[String]) -> Vec<&str> {
    match args.iter().position(|a| a == "--") {
        Some(i) => args[i + 1..].iter().map(String::as_str).collect(),
        None => Vec::new(),
    }
}

fn wants_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "-h" || a == "--help")
}

fn checkout(rest: &[String], probe: &dyn Probe) -> Option<&'static str> {
    if wants_help(rest) {
        return None;
    }
    if flags(rest).any(|f| {
        matches!(
            f.as_str(),
            "-b" | "-B" | "--orphan" | "--detach" | "-d" | "--track" | "-t" | "--guess"
        ) || f.starts_with("--orphan=")
    }) {
        return Some("checkout");
    }
    if flags(rest).any(|f| f == "-p" || f == "--patch") {
        return None;
    }
    let after = paths_after_dashdash(rest);
    if !after.is_empty() {
        return after.iter().any(|p| is_broad(p)).then_some("checkout-paths");
    }
    let pos = positionals(rest);
    match pos.as_slice() {
        [] => None,
        [one] if is_broad(one) => Some("checkout-paths"),
        [one] if probe.is_plain_path(one) => None,
        _ => Some("checkout"),
    }
}

fn switch(rest: &[String]) -> Option<&'static str> {
    if wants_help(rest) {
        return None;
    }
    let creates = flags(rest).any(|f| {
        matches!(f.as_str(), "-c" | "-C" | "--create" | "--force-create" | "-d" | "--detach")
            || f.starts_with("--create=")
            || f.starts_with("--orphan")
    });
    (creates || !positionals(rest).is_empty() || rest.iter().any(|a| a == "-")).then_some("switch")
}

fn restore(rest: &[String]) -> Option<&'static str> {
    if wants_help(rest) {
        return None;
    }
    let staged_only = flags(rest).any(|f| f == "--staged" || short_cluster_has(f, 'S'))
        && !flags(rest).any(|f| f == "--worktree" || short_cluster_has(f, 'W'));
    if staged_only {
        return None;
    }
    let mut specs = positionals(rest);
    specs.extend(paths_after_dashdash(rest));
    specs.iter().any(|s| is_broad(s)).then_some("restore-paths")
}

fn stash(rest: &[String]) -> Option<&'static str> {
    if wants_help(rest) {
        return None;
    }
    match positionals(rest).first().copied() {
        None => Some("stash"),
        Some("push" | "save" | "pop" | "apply" | "branch") => Some("stash"),
        // A pathspec or message given to a bare `stash -- x` is still a push.
        Some("list" | "show" | "drop" | "clear" | "create" | "store") => None,
        Some(_) => Some("stash"),
    }
}

fn clean(rest: &[String]) -> Option<&'static str> {
    if wants_help(rest) {
        return None;
    }
    let dry = flags(rest).any(|f| f == "--dry-run" || short_cluster_has(f, 'n'));
    let interactive = flags(rest).any(|f| f == "--interactive" || short_cluster_has(f, 'i'));
    let force = flags(rest).any(|f| f == "--force" || short_cluster_has(f, 'f'));
    (force && !dry && !interactive).then_some("clean")
}

fn bisect(rest: &[String]) -> Option<&'static str> {
    match positionals(rest).first().copied() {
        None | Some("log" | "visualize" | "view" | "help") => None,
        Some(_) => Some("bisect"),
    }
}

/// Classify the arguments after `git` (or after `gh`, with `program` `"gh"`).
pub fn classify_args(program: &str, args: &[String], probe: &dyn Probe) -> Option<TreeChange> {
    if program == "gh" {
        // `gh -R owner/repo pr checkout 1`: the repo value is not a word.
        let mut words = Vec::new();
        let mut skip = false;
        for a in args {
            if std::mem::take(&mut skip) {
                continue;
            }
            if a == "-R" || a == "--repo" {
                skip = true;
            } else if !a.starts_with('-') {
                words.push(a.as_str());
            }
        }
        let mut it = words.into_iter();
        return match (it.next(), it.next()) {
            (Some("pr"), Some("checkout" | "co")) => {
                Some(TreeChange { kind: "pr-checkout", dir: None })
            }
            _ => None,
        };
    }
    // Global options, then the subcommand.
    let mut dir: Option<String> = None;
    let mut aliases: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-C" {
            dir = args.get(i + 1).cloned();
            i += 2;
        } else if a == "-c" {
            if let Some((k, v)) = args.get(i + 1).and_then(|kv| kv.split_once('=')) {
                if let Some(name) = k.strip_prefix("alias.") {
                    aliases.push((name.to_string(), v.to_string()));
                }
            }
            i += 2;
        } else if a == "--work-tree" {
            // The tree that changes is this one, not the current folder.
            dir = args.get(i + 1).cloned();
            i += 2;
        } else if let Some(tree) = a.strip_prefix("--work-tree=") {
            dir = Some(tree.to_string());
            i += 1;
        } else if VALUE_GLOBALS.contains(&a) {
            i += 2;
        } else if a.starts_with("--git-dir=") {
            i += 1;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            break;
        }
    }
    let sub = args.get(i)?.as_str();
    let mut rest: Vec<String> = args[i + 1..].to_vec();
    let mut sub = sub.to_string();
    if let Some((_, target)) = aliases.iter().find(|(name, _)| *name == sub) {
        let mut words = split_command_line(target)?;
        if words.is_empty() || words[0].starts_with('!') {
            return None;
        }
        sub = words.remove(0);
        words.extend(rest);
        rest = words;
    } else if CHECKOUT_ALIASES.contains(&sub.as_str()) {
        sub = "checkout".to_string();
    }
    let kind = match sub.as_str() {
        "checkout" => checkout(&rest, probe),
        "switch" => switch(&rest),
        "reset" => flags(&rest)
            .any(|f| matches!(f.as_str(), "--hard" | "--merge" | "--keep"))
            .then_some("reset-hard"),
        "stash" => stash(&rest),
        "rebase" | "merge" | "cherry-pick" | "revert" | "am" | "pull" => {
            (!wants_help(&rest)
                && !(sub == "pull" && flags(&rest).any(|f| f == "--dry-run")))
            .then(|| match sub.as_str() {
                "rebase" => "rebase",
                "merge" => "merge",
                "cherry-pick" => "cherry-pick",
                "revert" => "revert",
                "am" => "am",
                _ => "pull",
            })
        }
        "clean" => clean(&rest),
        "restore" => restore(&rest),
        "bisect" => bisect(&rest),
        // Plumbing and helpers that rewrite the working tree too. User-defined
        // aliases (other than `-c alias.x=`) are not resolved here.
        "rm" => (!wants_help(&rest)
            && !flags(&rest).any(|f| f == "--cached" || f == "--dry-run" || short_cluster_has(f, 'n'))
            && positionals(&rest).iter().chain(paths_after_dashdash(&rest).iter()).any(|p| is_broad(p)))
        .then_some("rm"),
        "checkout-index" => flags(&rest)
            .any(|f| matches!(f.as_str(), "--all" | "--force") || short_cluster_has(f, 'a') || short_cluster_has(f, 'f'))
            .then_some("checkout-index"),
        "read-tree" => flags(&rest).any(|f| f == "-u" || f == "--reset").then_some("read-tree"),
        "sparse-checkout" => matches!(
            positionals(&rest).first().copied(),
            Some("set" | "add" | "reapply" | "disable" | "init")
        )
        .then_some("sparse-checkout"),
        "submodule" => (positionals(&rest).first().copied() == Some("update")).then_some("submodule-update"),
        _ => None,
    }?;
    Some(TreeChange { kind, dir })
}

/// The program a command word names: `git`, `/usr/bin/git`, `C:\Git\cmd\git.exe`.
fn program_of(word: &str) -> Option<&'static str> {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    match base {
        "git" => Some("git"),
        "gh" => Some("gh"),
        _ => None,
    }
}

/// Every tree-changing git command in a shell command line. Split with the
/// permission gate's own scanner, so `cd x && git checkout main`, wrappers
/// (`env`, `sudo`, `bash -c`) and substitutions are seen.
pub fn scan_command(command: &str, probe: &dyn Probe) -> Vec<TreeChange> {
    cmdscan::simple_commands(command)
        .iter()
        .filter_map(|simple| {
            let mut words = split_command_line(simple)?;
            while words.first().is_some_and(|w| w == "&" || w == "." || w == "command") {
                words.remove(0);
            }
            let program = program_of(words.first()?)?;
            classify_args(program, &words[1..], probe)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(command: &str) -> Vec<&'static str> {
        scan_command(command, &NoProbe).iter().map(|c| c.kind).collect()
    }

    struct Files(&'static [&'static str]);
    impl Probe for Files {
        fn is_plain_path(&self, arg: &str) -> bool {
            self.0.contains(&arg)
        }
    }

    /// Held: the command changes the tree.
    #[test]
    fn tree_changing_commands_are_held() {
        for (command, kind) in [
            ("git checkout main", "checkout"),
            ("git checkout feat/multi-game-catalog", "checkout"),
            ("git checkout -b new-branch", "checkout"),
            ("git checkout -B new origin/main", "checkout"),
            ("git checkout --detach HEAD~2", "checkout"),
            ("git checkout abc1234", "checkout"),
            ("git checkout .", "checkout-paths"),
            ("git checkout -- .", "checkout-paths"),
            ("git checkout main -- .", "checkout-paths"),
            ("git switch main", "switch"),
            ("git switch -c topic", "switch"),
            ("git switch -", "switch"),
            ("git reset --hard", "reset-hard"),
            ("git reset --hard origin/main", "reset-hard"),
            ("git reset --merge", "reset-hard"),
            ("git stash", "stash"),
            ("git stash push -m wip", "stash"),
            ("git stash -u", "stash"),
            ("git stash pop", "stash"),
            ("git stash apply stash@{1}", "stash"),
            ("git rebase main", "rebase"),
            ("git rebase --abort", "rebase"),
            ("git rebase -i HEAD~3", "rebase"),
            ("git merge feat/x", "merge"),
            ("git merge --no-ff topic", "merge"),
            ("git pull", "pull"),
            ("git pull origin main", "pull"),
            ("git clean -fd", "clean"),
            ("git clean -fdx", "clean"),
            ("git clean --force -d", "clean"),
            ("git restore .", "restore-paths"),
            ("git restore --source=HEAD~1 :/", "restore-paths"),
            ("git cherry-pick abc123", "cherry-pick"),
            ("git revert HEAD", "revert"),
            ("git am patch.mbox", "am"),
            ("git bisect start", "bisect"),
            ("gh pr checkout 123", "pr-checkout"),
            ("gh -R owner/repo pr checkout 123", "pr-checkout"),
            ("git read-tree -u -m HEAD", "read-tree"),
            ("git checkout-index -a -f", "checkout-index"),
            ("git sparse-checkout set src", "sparse-checkout"),
            ("git submodule update --init", "submodule-update"),
            ("git rm -r .", "rm"),
            ("git rm -r -- :/", "rm"),
        ] {
            assert_eq!(hit(command), vec![kind], "{command}");
        }
    }

    #[test]
    fn a_work_tree_option_names_the_folder_that_changes() {
        let got = classify_args("git", &["--work-tree=../other".into(), "checkout".into(), "main".into()], &NoProbe);
        assert_eq!(got.and_then(|t| t.dir).as_deref(), Some("../other"));
        let got = classify_args("git", &["--work-tree".into(), "w".into(), "reset".into(), "--hard".into()], &NoProbe);
        assert_eq!(got.and_then(|t| t.dir).as_deref(), Some("w"));
        // Narrow or index-only forms still pass.
        assert!(hit("git rm --cached .").is_empty());
        assert!(hit("git rm src/a.ts").is_empty());
        assert!(hit("git read-tree HEAD").is_empty());
        assert!(hit("git submodule status").is_empty());
    }

    /// Passed: read-only, or confined to a named file.
    #[test]
    fn harmless_commands_pass() {
        for command in [
            "git status",
            "git log --oneline -5",
            "git diff HEAD",
            "git branch",
            "git branch -a",
            "git branch new-branch",
            "git fetch origin",
            "git add -A",
            "git commit -m 'checkout main'",
            "git push origin main",
            "git checkout -- src/a.ts",
            "git checkout main -- src/a.ts",
            "git checkout",
            "git switch --help",
            "git reset",
            "git reset --soft HEAD~1",
            "git reset --mixed HEAD~1",
            "git reset HEAD file.txt",
            "git stash list",
            "git stash show -p",
            "git stash drop",
            "git clean -n",
            "git clean -fdn",
            "git clean -f -n",
            "git clean",
            "git restore --staged .",
            "git restore src/a.ts",
            "git restore --source=HEAD src/a.ts",
            "git merge-base main HEAD",
            "git pull --dry-run",
            "git bisect log",
            "gh pr view 12",
            "gh pr create --fill",
            "echo git checkout main",
            "ls && cat checkout",
        ] {
            assert_eq!(hit(command), Vec::<&str>::new(), "{command}");
        }
    }

    #[test]
    fn wrappers_quotes_paths_and_chains_are_seen() {
        assert_eq!(hit("cd sub && git checkout main"), vec!["checkout"]);
        assert_eq!(hit("cd sub; git switch dev; git status"), vec!["switch"]);
        assert_eq!(hit("git status | cat && git reset --hard"), vec!["reset-hard"]);
        assert_eq!(hit("env GIT_PAGER=cat git checkout main"), vec!["checkout"]);
        assert_eq!(hit("sudo -u bob git rebase main"), vec!["rebase"]);
        assert_eq!(hit("timeout 60 git pull"), vec!["pull"]);
        assert_eq!(hit("bash -c 'git checkout main'"), vec!["checkout"]);
        assert_eq!(hit("sh -c \"cd x && git reset --hard\""), vec!["reset-hard"]);
        assert_eq!(hit("echo $(git stash)"), vec!["stash"]);
        assert_eq!(hit("command git checkout main"), vec!["checkout"]);
        assert_eq!(hit("\"git\" checkout main"), vec!["checkout"]);
        assert_eq!(hit("'git' switch main"), vec!["switch"]);
        assert_eq!(hit("git.exe checkout main"), vec!["checkout"]);
        assert_eq!(hit("GIT.EXE checkout main"), vec!["checkout"]);
        assert_eq!(hit("/usr/bin/git checkout main"), vec!["checkout"]);
        assert_eq!(hit("C:/Git/cmd/git.exe checkout main"), vec!["checkout"]);
        assert_eq!(hit(r#"& "C:\Program Files\Git\cmd\git.exe" checkout main"#), vec!["checkout"]);
        assert_eq!(hit("& git checkout main"), vec!["checkout"]);
        assert_eq!(hit("{ git reset --hard; }"), vec!["reset-hard"]);
    }

    #[test]
    fn global_options_and_dir() {
        let one = scan_command("git -C ../other checkout main", &NoProbe);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].kind, "checkout");
        assert_eq!(one[0].dir.as_deref(), Some("../other"));
        assert_eq!(hit("git -c core.editor=true rebase main"), vec!["rebase"]);
        assert_eq!(hit("git --no-pager checkout main"), vec!["checkout"]);
        assert_eq!(hit("git --git-dir=.git --work-tree=. checkout main"), vec!["checkout"]);
        assert_eq!(hit("git -C . -c a=b switch dev"), vec!["switch"]);
        assert_eq!(hit("git -C sub status"), Vec::<&str>::new());
    }

    #[test]
    fn aliases_are_expanded() {
        assert_eq!(hit("git co main"), vec!["checkout"]);
        assert_eq!(hit("git -c alias.go=checkout go main"), vec!["checkout"]);
        assert_eq!(hit("git -c 'alias.sw=switch -c' sw topic"), vec!["switch"]);
        assert_eq!(hit("git -c alias.st=status st"), Vec::<&str>::new());
        // A shell alias cannot be seen into.
        assert_eq!(hit("git -c 'alias.x=!echo hi' x"), Vec::<&str>::new());
    }

    #[test]
    fn a_lone_word_is_a_file_when_the_probe_says_so() {
        let probe = Files(&["notes.txt"]);
        let got = |c: &str| scan_command(c, &probe).len();
        assert_eq!(got("git checkout notes.txt"), 0);
        assert_eq!(got("git checkout notes"), 1);
        assert_eq!(got("git checkout ."), 1);
    }

    #[test]
    fn every_change_in_a_line_is_reported() {
        assert_eq!(hit("git stash && git checkout main && git stash pop"), vec!["stash", "checkout", "stash"]);
    }
}
