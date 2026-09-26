//! Programs known to open Windows' null device themselves.
//!
//! On a machine whose `\Device\Null` refuses AppContainers (see
//! [`super::appcontainer::null_device_admits_sandbox`]), a program that opens
//! NUL on its own -- Go's toolchain, git -- fails inside the sandbox whatever
//! the command says. Running it only to watch it fail wastes the call and can
//! half-run a `&&` chain, so a sandboxed `bash` command naming one of them is
//! not run at all: it is answered with the same null-device refusal a failed
//! run would get, which offers the user to run it outside the sandbox.
//!
//! The list is [`DEFAULT_NUL_PROGRAMS`] plus whatever a project adds with
//! `[tools].nul_programs` in its agent.toml.

/// Programs that open NUL themselves on every run.
pub const DEFAULT_NUL_PROGRAMS: &[&str] = &["go", "git"];

/// The first program in `command` that is known to open NUL, as named in
/// the list (lowercase, no directory or extension). Every segment of a chain
/// (`&&`, `||`, `;`, `|`, `&`, a newline) counts, leading `NAME=value`
/// assignments and an `env` prefix are skipped, and a quoted path such as
/// `"C:\Go\bin\go.exe"` is reduced to its program name.
pub fn opens_null_device(command: &str, extra: &[String]) -> Option<String> {
    segments(command).into_iter().find_map(|segment| {
        let program = program_of(&segment)?;
        let listed = DEFAULT_NUL_PROGRAMS.iter().any(|p| *p == program)
            || extra.iter().any(|p| normalize(p) == program);
        listed.then_some(program)
    })
}

/// What the model gets instead of a run. Carries the null-device refusal
/// (and its retry tag), so the surface offers the unsandboxed retry exactly as
/// it does after a failed run.
pub fn not_run_refusal(program: &str) -> String {
    format!(
        "ERROR: this command was not run in the sandbox: `{program}` opens Windows' null \
         device (NUL), which refuses sandboxed programs on this machine, so it would fail \
         there. The user is being asked to approve running it outside the sandbox.{}",
        super::jail::NULL_DEVICE_REFUSED_HINT
    )
}

/// `go`, `Go.EXE`, `C:\Go\bin\go.exe` and `/usr/bin/go` are all `go`.
fn normalize(program: &str) -> String {
    let name = program
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stem) = name.strip_suffix(ext) {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    name
}

/// Split on the shell's command separators, outside quotes.
fn segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) => {
                current.push(c);
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    current.push(c);
                }
                '&' | '|' | ';' | '\n' | '\r' => {
                    out.push(std::mem::take(&mut current));
                }
                _ => current.push(c),
            },
        }
    }
    out.push(current);
    out.retain(|s| !s.trim().is_empty());
    out
}

/// Words of one segment, with quotes removed.
fn words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started || !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => current.push(c),
        }
    }
    if started || !current.is_empty() {
        out.push(current);
    }
    out
}

fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The program a segment runs, normalized.
fn program_of(segment: &str) -> Option<String> {
    let trimmed = segment.trim_start().trim_start_matches(['(', '{', ' ', '\t']);
    let mut rest = words(trimmed).into_iter();
    loop {
        let word = rest.next()?;
        if is_assignment(&word) {
            continue;
        }
        let program = normalize(&word);
        // `env A=b go build`: the program is after env's own assignments.
        if program == "env" || program.is_empty() {
            continue;
        }
        return Some(program);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(command: &str) -> Option<String> {
        opens_null_device(command, &[])
    }

    #[test]
    fn a_plain_program_is_recognised() {
        assert_eq!(hit("go build ./..."), Some("go".into()));
        assert_eq!(hit("git status"), Some("git".into()));
        assert_eq!(hit("  git   log -1"), Some("git".into()));
        assert_eq!(hit("cargo build"), None);
        assert_eq!(hit("echo go git"), None, "only the program counts, not arguments");
        assert_eq!(hit("gofmt -l ."), None);
        assert_eq!(hit("goimports -w ."), None);
        assert_eq!(hit(""), None);
    }

    #[test]
    fn leading_assignments_and_env_are_skipped() {
        assert_eq!(hit("GOOS=linux GOARCH=amd64 go build"), Some("go".into()));
        assert_eq!(hit("env CGO_ENABLED=0 go test"), Some("go".into()));
        assert_eq!(hit("A='x y' git diff"), Some("git".into()));
        assert_eq!(hit("FOO=bar"), None);
    }

    #[test]
    fn any_segment_of_a_chain_counts() {
        assert_eq!(hit("cd src && go vet ./..."), Some("go".into()));
        assert_eq!(hit("ls; git status"), Some("git".into()));
        assert_eq!(hit("cat x | git hash-object --stdin"), Some("git".into()));
        assert_eq!(hit("make || go build"), Some("go".into()));
        assert_eq!(hit("echo a\ngo run ."), Some("go".into()));
        assert_eq!(hit("(cd x; git pull)"), Some("git".into()));
        assert_eq!(hit("echo 'a && go build'"), None, "separators inside quotes");
        assert_eq!(hit("npm test 2>&1 | tee out.txt"), None);
    }

    #[test]
    fn quoted_and_absolute_paths_are_reduced_to_the_program() {
        assert_eq!(hit(r#""C:\Go\bin\go.exe" build"#), Some("go".into()));
        assert_eq!(hit(r#"& "C:\Program Files\Git\cmd\git.exe" status"#), Some("git".into()));
        assert_eq!(hit("/usr/local/go/bin/go version"), Some("go".into()));
        assert_eq!(hit("GIT.EXE status"), Some("git".into()));
        assert_eq!(hit(r"C:\tools\git.cmd fetch"), Some("git".into()));
    }

    #[test]
    fn a_configured_program_counts_too() {
        let extra = vec!["Bazel".to_string(), r"C:\bin\protoc.exe".to_string()];
        assert_eq!(opens_null_device("bazel build //...", &extra), Some("bazel".into()));
        assert_eq!(opens_null_device("protoc --version", &extra), Some("protoc".into()));
        assert_eq!(opens_null_device("cargo build", &extra), None);
    }

    #[test]
    fn the_refusal_offers_the_retry_and_says_nothing_ran() {
        let text = not_run_refusal("go");
        assert!(text.starts_with("ERROR"), "{text}");
        assert!(text.contains("was not run in the sandbox"), "{text}");
        assert!(text.contains("being asked to approve"), "{text}");
        assert!(crate::unsandboxed_retry::qualifies("bash", true, true, &text));
    }
}
