//! What a tool call actually touches, and how a rule names it.
//!
//! Permission rules used to match tool *names* and nothing else, so the only
//! thing anyone could express was "bash is allowed" or "bash is denied" —
//! `bash(git push*)` was inexpressible, and a rule could not distinguish
//! reading `src/main.rs` from reading `~/.ssh/id_rsa`. This module gives every
//! call a normalized [`Resource`] and gives rules a way to name one.
//!
//! Two properties matter more than expressiveness:
//!
//! * **Normalize before matching.** `./src/../src/a.rs`, `src/a.rs` and an
//!   absolute path to the same file are one resource. A rule writer should not
//!   have to enumerate spellings, and an attacker should not be able to pick
//!   one the rule missed.
//! * **Fail closed.** A call whose resource cannot be determined is
//!   [`Resource::Unknown`], which no allow rule matches and every deny rule
//!   does. Malformed input is refused, never waved through.

use std::fmt;
use std::path::{Component, Path, PathBuf};

use glob::Pattern;

/// A git subcommand that can destroy work that was never committed, or rewrite
/// history that other people have.
///
/// Recognised structurally from the parsed argv rather than by searching the
/// command string, so `echo "git push --force"` is not a force push and
/// `git   push  --force` still is. See [`GitOp::classify`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitOp {
    /// `reset --hard`, `reset --merge`, `reset --keep`: discards the tree.
    ResetHard,
    /// `clean` other than a dry run: deletes untracked files, including
    /// ignored ones with `-x`.
    Clean,
    /// `push --force`, `push -f`, `push +ref:ref`.
    ForcePush,
    /// `checkout --force`, `checkout .`, `restore` without `--staged`.
    DiscardWorktree,
    /// `branch -D`/`--delete`, `push --delete`, `update-ref -d`.
    DeleteBranch,
    /// `rebase`, `filter-branch`, `commit --amend`, `reflog delete`,
    /// `gc --prune`: rewrites or drops history.
    RewriteHistory,
    /// Any other git invocation. Not destructive on its own.
    Other,
}

impl GitOp {
    /// Whether this operation can lose work or rewrite shared history.
    pub fn is_destructive(self) -> bool {
        !matches!(self, GitOp::Other)
    }

    /// Classify a git invocation from its argv, *excluding* the `git` program
    /// itself. `argv` is expected already split into words.
    ///
    /// Deliberately structural. A substring search for "reset --hard" matches
    /// a commit message that mentions it and misses `reset --hard` written with
    /// two spaces; both are wrong in the direction that matters.
    pub fn classify(argv: &[String]) -> Self {
        let idx = subcommand_index(argv);
        let Some(sub) = argv.get(idx).map(String::as_str) else {
            return GitOp::Other;
        };
        let rest: Vec<&str> = argv[idx + 1..].iter().map(String::as_str).collect();
        let has = |flags: &[&str]| rest.iter().any(|a| flags.contains(a));

        match sub {
            "reset" if has(&["--hard", "--merge", "--keep"]) => GitOp::ResetHard,
            // Anything but a dry run: `--force` is the long spelling of `-f`,
            // and `-c clean.requireForce=false` makes a bare `clean` delete
            // with no force flag at all (Jozkah/jan#45).
            "clean"
                if !(has(&["--dry-run"]) || rest.iter().any(|a| is_short_flag_with(a, &['n']))) =>
            {
                GitOp::Clean
            }
            "push" if has(&["--delete"]) => GitOp::DeleteBranch,
            "push"
                if has(&["--force", "-f", "--force-with-lease", "--force-if-includes"])
                    // `git push origin +main` is a force push spelled with a
                    // refspec rather than a flag.
                    || rest.iter().any(|a| a.starts_with('+') && a.len() > 1) =>
            {
                GitOp::ForcePush
            }
            "checkout" if has(&["--force", "-f"]) => GitOp::DiscardWorktree,
            // `git checkout .` and `git checkout -- path` overwrite the tree.
            "checkout" if rest.iter().any(|a| *a == "." || *a == "--") => GitOp::DiscardWorktree,
            "restore" if !has(&["--staged"]) && !rest.is_empty() => GitOp::DiscardWorktree,
            "branch"
                if rest.iter().any(|a| is_short_flag_with(a, &['D'])) || has(&["--delete"]) =>
            {
                GitOp::DeleteBranch
            }
            "update-ref" if rest.iter().any(|a| is_short_flag_with(a, &['d'])) => {
                GitOp::DeleteBranch
            }
            "rebase" | "filter-branch" | "filter-repo" => GitOp::RewriteHistory,
            "commit" if has(&["--amend"]) => GitOp::RewriteHistory,
            "reflog"
                if rest
                    .first()
                    .is_some_and(|a| *a == "delete" || *a == "expire") =>
            {
                GitOp::RewriteHistory
            }
            "gc" if rest.iter().any(|a| a.starts_with("--prune")) => GitOp::RewriteHistory,
            "stash" if rest.first().is_some_and(|a| *a == "drop" || *a == "clear") => {
                GitOp::ResetHard
            }
            _ => GitOp::Other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            GitOp::ResetHard => "reset-hard",
            GitOp::Clean => "clean",
            GitOp::ForcePush => "force-push",
            GitOp::DiscardWorktree => "discard-worktree",
            GitOp::DeleteBranch => "delete-branch",
            GitOp::RewriteHistory => "rewrite-history",
            GitOp::Other => "other",
        }
    }
}

/// Where the subcommand sits in a git argv, past git's own global options, so
/// `git -C /tmp push --force` is still a force push. Options that take a value
/// consume the next word.
fn subcommand_index(argv: &[String]) -> usize {
    let mut idx = 0;
    while idx < argv.len() {
        let word = argv[idx].as_str();
        if word == "-C" || word == "-c" || word == "--git-dir" || word == "--work-tree" {
            idx += 2;
            continue;
        }
        if word.starts_with('-') {
            idx += 1;
            continue;
        }
        break;
    }
    idx
}

/// Whether `word` is a clustered short flag (`-fdx`) containing any of `wanted`.
///
/// `-f` and `-fd` both mean force; matching the whole word would miss the
/// second, and matching a bare substring would find the `d` in `--dry-run`.
fn is_short_flag_with(word: &str, wanted: &[char]) -> bool {
    let Some(rest) = word.strip_prefix('-') else {
        return false;
    };
    if rest.starts_with('-') || rest.is_empty() {
        return false;
    }
    rest.chars().any(|c| wanted.contains(&c))
}

/// What a call touches, normalized so one thing has one spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resource {
    /// A filesystem path, lexically normalized and absolute where a root was
    /// available to resolve it against.
    Path(PathBuf),
    /// A shell command: the program plus its arguments, as parsed.
    Command {
        program: String,
        argv: Vec<String>,
        git: GitOp,
    },
    /// A tool provided by an MCP server.
    McpTool { server: String, tool: String },
    /// An outbound network destination.
    Net { host: String, port: Option<u16> },
    /// A process the agent controls, scoped to the run that owns it.
    Process { run_id: String, pid: Option<u32> },
    /// The resource could not be determined. Matched by deny rules, by no
    /// allow rule, and reported rather than silently treated as harmless.
    Unknown { tool: String, why: String },
}

impl Resource {
    /// The rule namespace this resource lives in: `path`, `command`, `mcp`,
    /// `net`, `process` or `unknown`.
    pub fn kind(&self) -> &'static str {
        match self {
            Resource::Path(_) => "path",
            Resource::Command { .. } => "command",
            Resource::McpTool { .. } => "mcp",
            Resource::Net { .. } => "net",
            Resource::Process { .. } => "process",
            Resource::Unknown { .. } => "unknown",
        }
    }

    /// The text a rule pattern is matched against.
    pub fn match_text(&self) -> String {
        match self {
            Resource::Path(p) => p.to_string_lossy().into_owned(),
            Resource::Command { program, argv, .. } => {
                if argv.is_empty() {
                    program.clone()
                } else {
                    format!("{program} {}", argv.join(" "))
                }
            }
            Resource::McpTool { server, tool } => format!("{server}/{tool}"),
            Resource::Net { host, port } => match port {
                Some(p) => format!("{host}:{p}"),
                None => host.clone(),
            },
            Resource::Process { run_id, pid } => match pid {
                Some(p) => format!("{run_id}/{p}"),
                None => run_id.clone(),
            },
            Resource::Unknown { tool, .. } => tool.clone(),
        }
    }

    /// Whether this resource is a destructive git operation, and which.
    pub fn destructive_git(&self) -> Option<GitOp> {
        match self {
            Resource::Command { git, .. } if git.is_destructive() => Some(*git),
            _ => None,
        }
    }

    /// For a destructive git command, the same subcommand with nothing that
    /// made it destructive: `git push --force origin main` becomes `git push`.
    ///
    /// The AH-046 guard asks whether an allow rule *names* the operation, and a
    /// rule that also covers this harmless twin does not -- `bash(git *)` and
    /// `bash(git:*)` cover every git command, so they say nothing about force
    /// pushes in particular (Jozkah/jan#47).
    pub fn harmless_git_twin(&self) -> Option<Resource> {
        let Resource::Command { program, argv, git } = self else {
            return None;
        };
        if !git.is_destructive() {
            return None;
        }
        let end = (subcommand_index(argv) + 1).min(argv.len());
        Some(Resource::Command {
            program: program.clone(),
            argv: argv[..end].to_vec(),
            git: GitOp::Other,
        })
    }

    /// A path resource from `raw`, resolved against `root` when relative and
    /// lexically normalized. No filesystem access, so it works for paths that
    /// do not exist yet (a write target) and cannot be raced.
    pub fn path(raw: &str, root: Option<&Path>) -> Resource {
        let candidate = Path::new(raw);
        let joined = match (candidate.is_absolute(), root) {
            (false, Some(root)) => root.join(candidate),
            _ => candidate.to_path_buf(),
        };
        Resource::Path(normalize(&joined))
    }

    /// A command resource from a shell command line.
    ///
    /// Parsing is word-based with quote awareness; it is not a shell. Anything
    /// it cannot parse becomes [`Resource::Unknown`] so the gate fails closed
    /// rather than matching a rule against a half-understood command.
    pub fn command(line: &str) -> Resource {
        let Some(words) = split_words(line) else {
            return Resource::Unknown {
                tool: "bash".into(),
                why: "unbalanced quotes in command".into(),
            };
        };
        let Some((program, argv)) = words.split_first() else {
            return Resource::Unknown {
                tool: "bash".into(),
                why: "empty command".into(),
            };
        };
        // `/usr/bin/git` and `git` are the same program for rule purposes.
        let mut program_name = Path::new(program)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| program.clone());
        let argv = argv.to_vec();
        // Every spelling the shell resolves to the git binary is git: `GIT` on
        // a case-insensitive filesystem, `git.exe` or a full Windows path, and
        // `\git` with its escape. Comparing the raw file name with "git" let
        // those through as an unrelated program, past the AH-046 guard and
        // every `git:` rule (Jozkah/jan#209).
        let git = if is_git_program(program) {
            program_name = "git".to_string();
            GitOp::classify(&argv)
        } else {
            GitOp::Other
        };
        Resource::Command {
            program: program_name,
            argv,
            git,
        }
    }

    /// A network resource from a URL. Host is lowercased and a default port is
    /// dropped, so `HTTPS://Example.com:443/x` and `https://example.com/x` are
    /// the same destination.
    pub fn net(url: &str) -> Resource {
        let trimmed = url.trim();
        let (scheme, rest) = match trimmed.split_once("://") {
            Some((s, r)) => (s.to_ascii_lowercase(), r),
            None => (String::new(), trimmed),
        };
        let authority = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .rsplit('@')
            .next()
            .unwrap_or("");
        if authority.is_empty() {
            return Resource::Unknown {
                tool: "web_fetch".into(),
                why: format!("no host in url {url:?}"),
            };
        }
        // IPv6 literals keep their brackets; a port follows the closing one.
        let (host, port) = if let Some(end) = authority.rfind(']') {
            let (h, tail) = authority.split_at(end + 1);
            (h, tail.strip_prefix(':'))
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (authority, None),
            }
        };
        let port = port.and_then(|p| p.parse::<u16>().ok());
        let default_port = match scheme.as_str() {
            "https" | "wss" => Some(443),
            "http" | "ws" => Some(80),
            _ => None,
        };
        Resource::Net {
            host: host.to_ascii_lowercase(),
            port: if port == default_port { None } else { port },
        }
    }

    /// Every resource a built-in call touches.
    ///
    /// A call can touch more than one — `edit` names a source and a
    /// destination — and every one of them has to satisfy the rules, so this
    /// returns all of them rather than a representative.
    pub fn for_builtin(
        tool_name: &str,
        path_args: &[&str],
        capability_is_net: bool,
        args: &serde_json::Value,
        root: Option<&Path>,
    ) -> Vec<Resource> {
        let mut out = Vec::new();

        for key in path_args {
            match args.get(key) {
                Some(serde_json::Value::String(raw)) if !raw.trim().is_empty() => {
                    out.push(Resource::path(raw, root));
                }
                Some(_) => out.push(Resource::Unknown {
                    tool: tool_name.to_string(),
                    why: format!("argument {key:?} is not a path string"),
                }),
                // An optional path argument that was not supplied is not a
                // resource, and not a malformation either.
                None => {}
            }
        }

        // An argument that is *present but unreadable* is a resource we cannot
        // vouch for, and fails closed. An argument that is simply absent is a
        // schema matter for the handler to report -- the gate decides
        // authority, not shape, and treating a missing field as a refusal
        // turned legitimate calls (a `bash` job poll, a `web_search` query)
        // into denials.
        if tool_name == "bash" {
            match args.get("command") {
                Some(serde_json::Value::String(line)) if !line.trim().is_empty() => {
                    // One resource per command the line runs, not one for the
                    // line (Jozkah/jan#227): deny, ask and the destructive-git
                    // guard see each, and a resource-qualified allow must cover
                    // every one.
                    // A line that cannot be read as a whole (unbalanced quotes)
                    // stays one `Unknown`, which fails closed.
                    let whole = Resource::command(line);
                    let commands = crate::tools::cmdscan::simple_commands(line);
                    if commands.is_empty() || matches!(whole, Resource::Unknown { .. }) {
                        out.push(whole);
                    } else {
                        out.extend(commands.iter().map(|c| Resource::command(c)));
                    }
                }
                Some(_) => out.push(Resource::Unknown {
                    tool: tool_name.to_string(),
                    why: "bash `command` is not a non-empty string".into(),
                }),
                // `bash` also polls a previously started job by id, which runs
                // no new command. That is the process the run already owns.
                None => {
                    if let Some(job) = args.get("job_id").and_then(|v| v.as_str()) {
                        out.push(Resource::Process {
                            run_id: job.to_string(),
                            pid: None,
                        });
                    }
                }
            }
        }

        if capability_is_net {
            match args.get("url") {
                Some(serde_json::Value::String(url)) if !url.trim().is_empty() => {
                    out.push(Resource::net(url))
                }
                Some(_) => out.push(Resource::Unknown {
                    tool: tool_name.to_string(),
                    why: "`url` is not a non-empty string".into(),
                }),
                None => {}
            }
        }

        out
    }
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind(), self.match_text())
    }
}

/// Lexical path normalization: no `.`, no `..`, no repeated separators.
///
/// Deliberately not `canonicalize`: that touches the filesystem, fails for a
/// path that does not exist yet, and follows symlinks, which would let a link
/// planted inside the project decide what a rule matches.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never pop past the root: `/..` is `/`, not the parent of it.
                if out
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)))
                {
                    out.pop();
                } else if out.as_os_str().is_empty() {
                    out.push("..");
                }
            }
            Component::Normal(name) => out.push(win32_name(name)),
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// The name Windows really opens for a path component (Jozkah/jan#223):
/// `CreateFileW` drops trailing dots and spaces, and `name::$DATA` (any
/// `:stream` suffix) is a stream of `name`. A rule or the secret-file guard
/// must see `.npmrc.` and `.env::$DATA` as the files they open. Elsewhere those
/// spellings are different files, so the name is kept as written.
fn win32_name(name: &std::ffi::OsStr) -> std::ffi::OsString {
    if !cfg!(windows) {
        return name.to_os_string();
    }
    let text = name.to_string_lossy();
    let file = text.split(':').next().unwrap_or(&text);
    let folded = file.trim_end_matches(['.', ' ']);
    if folded.is_empty() {
        name.to_os_string()
    } else {
        folded.into()
    }
}

/// Whether the first word of a command names the git binary, in any spelling
/// a shell would still resolve to it.
///
/// Both separators are path separators here, whatever the host: a Windows path
/// reaches a POSIX build through Git Bash, and `Path::file_name` would keep the
/// whole of it. Leading backslashes are escapes (`\git` runs git), casing is
/// folded (NTFS and default APFS open `GIT` as `git`), and the extensions
/// `PATHEXT` would append are dropped.
fn is_git_program(program: &str) -> bool {
    let name = program
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem = [".exe", ".cmd", ".bat", ".com"]
        .iter()
        .find_map(|ext| name.strip_suffix(ext))
        .unwrap_or(&name);
    stem == "git"
}

/// Split a command line into words, honouring single and double quotes.
///
/// Returns `None` when the quotes do not balance, which the caller turns into
/// [`Resource::Unknown`].
fn split_words(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;

    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(current);
    }
    Some(words)
}

/// A permission rule that can name a resource as well as a tool.
///
/// Grammar: `tool` or `tool(pattern)`. The bare form keeps every existing
/// name-only rule working unchanged; the parenthesised form matches the call's
/// resource, so `bash(git push*)` and `read(**/.ssh/**)` become expressible.
#[derive(Debug, Clone)]
pub struct ResourceRule {
    /// Who the rule is about. `Any` for the unqualified rules that predate
    /// subjects, which means "whoever is acting, if they can be identified".
    subject: crate::subject::SubjectPattern,
    tool: Pattern,
    /// `None` matches the tool whatever it touches.
    resource: Option<Pattern>,
    source: String,
}

impl ResourceRule {
    /// Parse a rule. An unparseable pattern yields `None`; the caller drops it
    /// rather than compiling a rule that would match unpredictably.
    ///
    /// Grammar: `[subject/]tool[(pattern)]`, so all three forms coexist:
    /// `bash`, `bash(git:force-push)`, `agent:reviewer/bash(git:push)`. The
    /// subject is split off before any `(`, so a `/` inside a resource pattern
    /// is left alone -- `read(**/.ssh/**)` has no subject.
    pub fn parse(rule: &str) -> Option<Self> {
        use crate::subject::{Subject, SubjectPattern};

        let rule = rule.trim();
        let head_end = rule.find('(').unwrap_or(rule.len());
        let (subject, rest) = match rule[..head_end].find('/') {
            Some(slash) => (
                SubjectPattern::parse(&rule[..slash]),
                rule[slash + 1..].trim(),
            ),
            None => (SubjectPattern::Any, rule),
        };
        // A qualifier naming no recognisable subject is a typo, and a rule
        // nobody matches is worse than no rule: drop it rather than silently
        // widening it to everyone.
        if matches!(subject, SubjectPattern::Exactly(Subject::Unknown)) {
            return None;
        }

        let (tool, resource) = match rest.strip_suffix(')').and_then(|r| r.split_once('(')) {
            Some((tool, inner)) => (tool.trim(), Some(inner.trim())),
            None => (rest, None),
        };
        if tool.is_empty() {
            return None;
        }
        Some(Self {
            subject,
            tool: Pattern::new(tool).ok()?,
            resource: match resource {
                Some(pattern) => Some(Pattern::new(pattern).ok()?),
                None => None,
            },
            source: rule.to_string(),
        })
    }

    /// Whether this rule is about `authority`.
    ///
    /// Every level of the delegation chain must be permitted, so a subagent is
    /// bound by its parent's rules as well as its own, and an unidentified
    /// subject anywhere denies the whole chain.
    pub fn applies_to(&self, authority: &crate::subject::Authority) -> bool {
        authority.permits(&self.subject)
    }

    /// The subject qualifier, for audit records and the rules UI.
    pub fn subject(&self) -> &crate::subject::SubjectPattern {
        &self.subject
    }

    /// Whether this rule names `tool_name` at all, ignoring resources. Used by
    /// the name-only surfaces (MCP advertisement) that predate resources.
    pub fn matches_name(&self, tool_name: &str) -> bool {
        self.tool.matches(tool_name)
    }

    /// Whether this rule is about this subject.
    ///
    /// The half of AH-007 that was missing. `parse` has understood
    /// `[subject/]tool[(pattern)]` from the start, so `agent(reviewer)/write`
    /// compiled and was accepted -- and then matched every caller, because
    /// nothing ever compared the subject. A rule naming one subagent bound the
    /// main agent and every other subagent identically, which is the opposite
    /// of what someone writing it intends.
    ///
    /// An unqualified rule covers every subject, so existing rule sets keep
    /// their meaning exactly.
    pub fn covers_subject(&self, subject: &crate::subject::Subject) -> bool {
        self.subject.matches(subject)
    }

    /// Whether an `ask` rule covers this call: as soon as *any* resource
    /// matches, like deny -- asking is the cautious side, so one command in a
    /// chain that the rule names is enough to ask about the whole line.
    pub fn matches_ask(
        &self,
        tool_name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> bool {
        if !self.covers_subject(subject) || !self.tool.matches(tool_name) {
            return false;
        }
        match &self.resource {
            None => true,
            Some(pattern) => resources.iter().any(|r| resource_matches(pattern, r)),
        }
    }

    /// Whether this rule covers this call.
    ///
    /// A resource-qualified rule must match *some* resource of the call to
    /// allow it, and an unknown resource matches no pattern — so a call the
    /// gate could not understand is never allowed by a specific rule. For a
    /// shell line it must match *every* command the line runs: a rule naming
    /// `git status` does not vouch for what is chained after it (Jozkah/jan#227).
    pub fn matches_allow(
        &self,
        tool_name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> bool {
        if !self.covers_subject(subject) || !self.tool.matches(tool_name) {
            return false;
        }
        let Some(pattern) = &self.resource else {
            // A bare tool rule allows the call only if every resource is
            // understood. Failing closed on `Unknown` is the whole point.
            return !resources
                .iter()
                .any(|r| matches!(r, Resource::Unknown { .. }));
        };
        let commands: Vec<&Resource> = resources
            .iter()
            .filter(|r| matches!(r, Resource::Command { .. }))
            .collect();
        if !commands.is_empty() {
            return commands.iter().all(|r| resource_matches(pattern, r));
        }
        resources.iter().any(|r| resource_matches(pattern, r))
    }

    /// Whether this rule denies this call.
    ///
    /// Deny is deliberately the mirror image of allow: a bare tool rule denies
    /// the tool outright, and a resource-qualified rule denies as soon as *any*
    /// resource matches — including an unknown one, which every deny rule
    /// catches.
    pub fn matches_deny(
        &self,
        tool_name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> bool {
        if !self.covers_subject(subject) || !self.tool.matches(tool_name) {
            return false;
        }
        let Some(pattern) = &self.resource else {
            return true;
        };
        resources.iter().any(|r| match r {
            Resource::Unknown { .. } => true,
            other => resource_matches(pattern, other),
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    /// Whether the rule names a resource, `tool(pattern)`, rather than the
    /// whole tool.
    pub fn is_resource_qualified(&self) -> bool {
        self.resource.is_some()
    }

    /// The filesystem-path pattern this rule matches, with any `path:` kind
    /// prefix stripped, or `None` for a bare tool rule or a non-path kind
    /// (`git:`, `command:`, `mcp:`, `net:`, `process:`, `unknown:`). Used to
    /// derive sandbox read roots from a project's allow rules, so an
    /// `allow = ["read(C:/data/**)"]` widens what reads may reach without a
    /// prompt. A bare drive letter like `C:` is not a kind prefix.
    pub fn read_root_pattern(&self) -> Option<&str> {
        let raw = self.resource.as_ref()?.as_str();
        if let Some(rest) = raw.strip_prefix("path:") {
            return Some(rest);
        }
        if let Some((kind, _)) = raw.split_once(':') {
            if ["git", "command", "mcp", "net", "process", "unknown"].contains(&kind) {
                return None;
            }
        }
        Some(raw)
    }
}

/// Match one pattern against one resource.
///
/// A pattern may be written with or without its kind prefix: `path:/etc/**`
/// and `/etc/**` both name a path, and `git:force-push` names a git operation
/// class rather than a command spelling.
fn resource_matches(pattern: &Pattern, resource: &Resource) -> bool {
    let raw = pattern.as_str();
    if let Some(op) = raw.strip_prefix("git:") {
        return match resource {
            Resource::Command { git, .. } => {
                Pattern::new(op).is_ok_and(|p| p.matches(git.as_str()))
            }
            _ => false,
        };
    }
    if let Some((kind, rest)) = raw.split_once(':') {
        if ["path", "command", "mcp", "net", "process", "unknown"].contains(&kind) {
            if resource.kind() != kind {
                return false;
            }
            return matches_resource_text(rest, resource);
        }
    }
    matches_resource_text(raw, resource)
}

/// Match a pattern against a resource's text, in the spellings a person writes.
///
/// A path resource is normalized to an absolute path, because that is the only
/// spelling two rules can agree on. A *rule*, though, is written the way the
/// file is talked about: `secrets/**`, `.env`, `src/**/*.ts`. Matching only the
/// absolute text meant none of those ever fired -- a project could write
/// `deny = ["read(secrets/**)"]`, see it accepted, and have it silently match
/// nothing.
///
/// So a relative pattern is also tried anchored at any directory boundary. The
/// boundary is what keeps it honest: `secrets/**` covers `/proj/secrets/x` and
/// does not cover `/proj/notsecrets/x`.
fn matches_resource_text(pattern: &str, resource: &Resource) -> bool {
    let text = resource.match_text();
    let is_path = matches!(resource, Resource::Path(_));
    // Windows and default macOS volumes open any casing of a path as the same
    // file, so a path rule must match it in any casing too (Jozkah/jan#223).
    let options = glob::MatchOptions {
        case_sensitive: !(is_path && cfg!(any(windows, target_os = "macos"))),
        ..glob::MatchOptions::new()
    };
    if Pattern::new(pattern).is_ok_and(|p| p.matches_with(&text, options)) {
        return true;
    }
    if !is_path {
        return false;
    }
    // Already absolute or already anchored: nothing further to try.
    if pattern.starts_with('/') || pattern.starts_with("**") {
        return false;
    }
    Pattern::new(&format!("**/{pattern}")).is_ok_and(|p| p.matches_with(&text, options))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn argv(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    fn git(line: &str) -> GitOp {
        GitOp::classify(&argv(line))
    }

    // ---- normalization -------------------------------------------------

    #[test]
    fn one_file_has_one_spelling() {
        let root = Path::new("/proj");
        let direct = Resource::path("src/a.rs", Some(root));
        for spelling in [
            "./src/a.rs",
            "src/../src/a.rs",
            "src/./a.rs",
            "/proj/src/a.rs",
        ] {
            assert_eq!(
                Resource::path(spelling, Some(root)),
                direct,
                "{spelling} should normalize to the same resource"
            );
        }
    }

    #[test]
    fn a_rule_written_the_way_people_write_rules_actually_matches() {
        // Resources normalize to absolute paths; rules are written relative to
        // the project. Matching only the absolute text meant a project could
        // write `deny = ["read(secrets/**)"]`, have it accepted, and have it
        // match nothing at all.
        let rule = ResourceRule::parse("read(secrets/**)").unwrap();
        let inside = Resource::path("/proj/secrets/keys.txt", None);
        assert!(rule.matches_deny(
            "read",
            std::slice::from_ref(&inside),
            &crate::subject::Subject::MainAgent
        ));

        // The directory boundary is what keeps it honest.
        let lookalike = Resource::path("/proj/notsecrets/keys.txt", None);
        assert!(!rule.matches_deny(
            "read",
            std::slice::from_ref(&lookalike),
            &crate::subject::Subject::MainAgent
        ));

        // A bare file name matches that file anywhere, which is how people
        // mean it when they write `read(.env)`.
        let dotenv = ResourceRule::parse("read(.env)").unwrap();
        assert!(dotenv.matches_deny(
            "read",
            &[Resource::path("/proj/app/.env", None)],
            &crate::subject::Subject::MainAgent
        ));
        assert!(!dotenv.matches_deny(
            "read",
            &[Resource::path("/proj/app/env.ts", None)],
            &crate::subject::Subject::MainAgent
        ));

        // An absolute rule still means exactly what it says.
        let absolute = ResourceRule::parse("read(/etc/**)").unwrap();
        assert!(absolute.matches_deny(
            "read",
            &[Resource::path("/etc/passwd", None)],
            &crate::subject::Subject::MainAgent
        ));
        assert!(!absolute.matches_deny(
            "read",
            &[Resource::path("/proj/etc/passwd", None)],
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn traversal_cannot_climb_past_the_root() {
        // A rule on /proj/** must not be dodged by walking up and back down.
        let escaped = Resource::path("../../etc/passwd", Some(Path::new("/proj/sub")));
        assert_eq!(escaped, Resource::Path(PathBuf::from("/etc/passwd")));
        assert_eq!(normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn a_url_has_one_spelling() {
        let canonical = Resource::net("https://example.com/path");
        for spelling in [
            "https://Example.COM/path",
            "https://example.com:443/path",
            "https://user:pw@example.com/path?q=1#frag",
        ] {
            assert_eq!(Resource::net(spelling), canonical, "{spelling}");
        }
        // A non-default port is part of the destination.
        assert_ne!(Resource::net("https://example.com:8443/"), canonical);
    }

    #[test]
    fn ipv6_literals_keep_their_brackets() {
        assert_eq!(
            Resource::net("http://[::1]:8080/x"),
            Resource::Net {
                host: "[::1]".into(),
                port: Some(8080)
            }
        );
    }

    // ---- git classification (AH-046) ------------------------------------

    #[test]
    fn destructive_git_is_recognised_structurally() {
        for (line, expected) in [
            ("reset --hard HEAD~1", GitOp::ResetHard),
            ("reset   --hard", GitOp::ResetHard),
            ("clean -fdx", GitOp::Clean),
            ("clean -f", GitOp::Clean),
            ("push --force origin main", GitOp::ForcePush),
            ("push -f", GitOp::ForcePush),
            ("push --force-with-lease", GitOp::ForcePush),
            ("push origin +main:main", GitOp::ForcePush),
            ("push --delete origin topic", GitOp::DeleteBranch),
            ("branch -D topic", GitOp::DeleteBranch),
            ("branch --delete topic", GitOp::DeleteBranch),
            ("checkout --force main", GitOp::DiscardWorktree),
            ("checkout .", GitOp::DiscardWorktree),
            ("restore src/a.rs", GitOp::DiscardWorktree),
            ("rebase -i HEAD~3", GitOp::RewriteHistory),
            ("commit --amend -m x", GitOp::RewriteHistory),
            ("filter-branch --all", GitOp::RewriteHistory),
            ("reflog delete HEAD@{0}", GitOp::RewriteHistory),
            ("gc --prune=now", GitOp::RewriteHistory),
            ("stash drop", GitOp::ResetHard),
            ("update-ref -d refs/heads/x", GitOp::DeleteBranch),
        ] {
            assert_eq!(git(line), expected, "git {line}");
            assert!(git(line).is_destructive(), "git {line} must be destructive");
        }
    }

    #[test]
    fn harmless_git_is_not_flagged() {
        for line in [
            "status",
            "log --oneline",
            "push origin main",
            "checkout -b topic",
            "restore --staged src/a.rs",
            "branch -a",
            "commit -m 'reset --hard is scary'",
            "add .",
            "diff",
        ] {
            assert_eq!(
                git(line),
                GitOp::Other,
                "git {line} must not be destructive"
            );
        }
    }

    #[test]
    fn global_options_do_not_hide_the_subcommand() {
        // The classic bypass: push the subcommand behind git's own flags.
        assert_eq!(git("-C /tmp push --force"), GitOp::ForcePush);
        assert_eq!(git("-c user.name=x reset --hard"), GitOp::ResetHard);
        assert_eq!(git("--git-dir /tmp/.git clean -fd"), GitOp::Clean);
    }

    #[test]
    fn mentioning_a_destructive_command_is_not_running_one() {
        // Substring matching would call all of these destructive.
        let echoed = Resource::command("echo 'git push --force'");
        assert_eq!(echoed.destructive_git(), None);
        let commit = Resource::command("git commit -m \"undo the reset --hard\"");
        assert_eq!(commit.destructive_git(), None);
    }

    #[test]
    fn a_full_path_to_git_is_still_git() {
        assert_eq!(
            Resource::command("/usr/bin/git push --force").destructive_git(),
            Some(GitOp::ForcePush)
        );
    }

    #[test]
    fn every_spelling_the_shell_resolves_to_git_is_git() {
        // Jozkah/jan#209: each of these runs the git binary, so each is git.
        for line in [
            "GIT reset --hard HEAD~1",
            "Git reset --hard",
            "git.exe reset --hard",
            "GIT.EXE reset --hard",
            r#""C:\Program Files\Git\cmd\git.exe" reset --hard"#,
            r"\git reset --hard",
        ] {
            let resource = Resource::command(line);
            assert_eq!(
                resource.destructive_git(),
                Some(GitOp::ResetHard),
                "{line} is a hard reset"
            );
        }
        // ...and a program that only contains the letters is not.
        for line in ["gitk reset --hard", "legit reset --hard", "git-lfs reset --hard"] {
            assert_eq!(Resource::command(line).destructive_git(), None, "{line}");
        }
    }

    #[test]
    fn git_clean_is_destructive_unless_it_is_a_dry_run() {
        // Jozkah/jan#45: the long flag, and a clean with requireForce off.
        for line in [
            "clean --force",
            "clean --force -X",
            "clean -X --force",
            "-c clean.requireForce=false clean",
            "clean",
        ] {
            assert_eq!(git(line), GitOp::Clean, "git {line}");
        }
        for line in ["clean -n", "clean --dry-run", "clean -nd", "clean -fdn"] {
            assert_eq!(git(line), GitOp::Other, "git {line} deletes nothing");
        }
    }

    // ---- failing closed --------------------------------------------------

    #[test]
    fn an_unparseable_command_is_unknown_not_allowed() {
        let unbalanced = Resource::command("echo 'unterminated");
        assert!(matches!(unbalanced, Resource::Unknown { .. }));

        let rule = ResourceRule::parse("bash").unwrap();
        assert!(!rule.matches_allow(
            "bash",
            std::slice::from_ref(&unbalanced),
            &crate::subject::Subject::MainAgent
        ));
        // ...and every deny rule catches it.
        assert!(ResourceRule::parse("bash").unwrap().matches_deny(
            "bash",
            std::slice::from_ref(&unbalanced),
            &crate::subject::Subject::MainAgent
        ));
        assert!(ResourceRule::parse("bash(git:*)").unwrap().matches_deny(
            "bash",
            &[unbalanced],
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn a_non_string_path_argument_is_unknown() {
        let resources = Resource::for_builtin("read", &["path"], false, &json!({"path": 42}), None);
        assert!(matches!(resources[0], Resource::Unknown { .. }));
        assert!(!ResourceRule::parse("read").unwrap().matches_allow(
            "read",
            &resources,
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn a_present_but_unreadable_command_is_unknown() {
        let resources = Resource::for_builtin("bash", &[], false, &json!({"command": 7}), None);
        assert!(matches!(resources[0], Resource::Unknown { .. }));
    }

    #[test]
    fn an_absent_argument_is_the_handlers_business_not_the_gates() {
        // A missing field is a schema error the handler reports. Refusing it
        // here turned a legitimate `bash` job poll into a permission denial.
        let poll = Resource::for_builtin("bash", &[], false, &json!({"job_id": "bash-0"}), None);
        assert_eq!(
            poll,
            vec![Resource::Process {
                run_id: "bash-0".into(),
                pid: None
            }]
        );
        assert!(Resource::for_builtin("web_search", &[], true, &json!({}), None).is_empty());
    }

    // ---- rule matching (AH-034) -----------------------------------------

    #[test]
    fn a_rule_can_finally_name_the_argument() {
        // The gap this work closes: bash(git push*) was inexpressible.
        let rule = ResourceRule::parse("bash(git push*)").unwrap();
        let push = vec![Resource::command("git push --force")];
        let status = vec![Resource::command("git status")];
        assert!(rule.matches_deny("bash", &push, &crate::subject::Subject::MainAgent));
        assert!(!rule.matches_deny("bash", &status, &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn a_rule_can_name_a_git_operation_class() {
        let rule = ResourceRule::parse("bash(git:force-push)").unwrap();
        assert!(rule.matches_deny(
            "bash",
            &[Resource::command("git push --force")],
            &crate::subject::Subject::MainAgent
        ));
        assert!(!rule.matches_deny(
            "bash",
            &[Resource::command("git push")],
            &crate::subject::Subject::MainAgent
        ));
        // The class survives spellings a literal pattern would miss.
        assert!(rule.matches_deny(
            "bash",
            &[Resource::command("git -C /x push -f")],
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn a_rule_can_name_a_path() {
        let rule = ResourceRule::parse("read(**/.ssh/**)").unwrap();
        let key = vec![Resource::path("/home/u/.ssh/id_rsa", None)];
        let src = vec![Resource::path("/home/u/proj/src/a.rs", None)];
        assert!(rule.matches_deny("read", &key, &crate::subject::Subject::MainAgent));
        assert!(!rule.matches_deny("read", &src, &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn a_kind_prefix_stops_a_pattern_matching_the_wrong_kind() {
        let rule = ResourceRule::parse("*(net:example.com)").unwrap();
        assert!(rule.matches_deny(
            "web_fetch",
            &[Resource::net("https://example.com/x")],
            &crate::subject::Subject::MainAgent
        ));
        // A file literally named example.com is not a network destination.
        assert!(!rule.matches_deny(
            "read",
            &[Resource::path("/tmp/example.com", None)],
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn a_bare_tool_rule_still_works_unchanged() {
        let rule = ResourceRule::parse("bash").unwrap();
        assert!(rule.matches_name("bash"));
        assert!(rule.matches_deny(
            "bash",
            &[Resource::command("git status")],
            &crate::subject::Subject::MainAgent
        ));
        assert!(!rule.matches_deny(
            "read",
            &[Resource::command("git status")],
            &crate::subject::Subject::MainAgent
        ));
    }

    #[test]
    fn a_rule_that_will_not_compile_is_dropped_not_guessed() {
        assert!(ResourceRule::parse("[").is_none());
        assert!(ResourceRule::parse("").is_none());
        assert!(ResourceRule::parse("bash([)").is_none());
    }

    #[test]
    fn every_resource_of_a_call_is_considered() {
        // edit names two paths; a deny on either must catch the call.
        let resources = Resource::for_builtin(
            "edit",
            &["path", "destination"],
            false,
            &json!({"path": "/proj/a.rs", "destination": "/etc/hosts"}),
            None,
        );
        assert_eq!(resources.len(), 2);
        assert!(ResourceRule::parse("edit(/etc/**)").unwrap().matches_deny(
            "edit",
            &resources,
            &crate::subject::Subject::MainAgent
        ));
    }
}
