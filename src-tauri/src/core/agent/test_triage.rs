//! Reading a failing test run: what broke, how many things broke, and which of
//! them will break again (AH-152, AH-153).
//!
//! A suite that fails forty times has usually broken in two or three ways: one
//! renamed function, one changed error message, forty call sites. A list of
//! forty failures is a list a person has to cluster in their head before they
//! can do anything, and a model handed that list will fix them one at a time.
//!
//! And some of those failures will not happen again. Treating a flake as a
//! regression sends somebody after a bug that is not there; treating a
//! regression as a flake ships it. The only honest way to tell them apart is
//! to run the thing again, so that is what this does -- and it says which it
//! did.
//!
//! What it deliberately will not do:
//!
//! * **It does not guess a root cause.** Failures are grouped by what they
//!   printed, normalised only where the noise is provably incidental (line
//!   numbers, addresses, temporary paths, durations). Two failures in a group
//!   said the same thing; that is the claim, and nothing more is asserted.
//! * **It does not decide a failure is flaky from one run.** A failure is
//!   flaky when it failed and then passed on a re-run of the same test.
//!   Without a re-run, nothing is called flaky at all.
//! * **It reads the shapes it knows.** Rust's test output is parsed; anything
//!   else is reported as output this cannot read, rather than being parsed by
//!   guesswork into failures that were never there.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

/// How long one test run may take.
pub const RUN_DEADLINE: Duration = Duration::from_secs(900);

/// One failing test, as its own output describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// The test's name, as the runner printed it.
    pub name: String,
    /// What it said when it failed, bounded.
    pub message: String,
}

/// Failures that said the same thing (AH-152).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    /// The shared message, normalised.
    pub signature: String,
    /// One real message from the group, unnormalised, so a person sees what
    /// was actually printed.
    pub example: String,
    pub tests: Vec<String>,
}

/// What a re-run said about a failure (AH-153).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reproduced {
    /// It failed again. A regression until somebody says otherwise.
    Yes,
    /// It passed on the re-run: flaky, on this evidence.
    No,
    /// It was not re-run, so nothing is claimed.
    NotChecked,
}

/// The triage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Triage {
    /// Every failure the run reported.
    pub failures: Vec<Failure>,
    /// Those failures, grouped by what they said.
    pub clusters: Vec<Cluster>,
    /// Per test name, what a re-run said.
    pub reproduced: BTreeMap<String, Reproduced>,
    /// True when the run produced output this could not read as test results.
    pub unreadable: bool,
    /// The command that was run.
    pub command: Vec<String>,
}

fn failed(kind: ErrorKind, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message).at(Stage::Startup)
}

/// Run a command, bounded, draining both pipes, returning its combined output.
fn run(command: &[String], project_root: &Path) -> Result<(bool, String), HarnessError> {
    let mut process = std::process::Command::new(&command[0]);
    process
        .args(&command[1..])
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    {
        use jan_process::CommandConsole;
        process.background();
    }
    let mut child = process.spawn().map_err(|e| {
        failed(
            ErrorKind::ToolUnavailable,
            format!("{} could not be started: {e}", command[0]),
        )
    })?;
    let drain = |handle: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut handle) = handle {
                use std::io::Read;
                let _ = handle.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|h| Box::new(h) as Box<dyn std::io::Read + Send>));
    let stderr = drain(child.stderr.take().map(|h| Box::new(h) as Box<dyn std::io::Read + Send>));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= RUN_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(failed(ErrorKind::Io, format!("the run could not be waited on: {e}"))),
        }
    };
    let out = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).to_string();
    let Some(status) = status else {
        return Err(failed(
            ErrorKind::Timeout,
            format!(
                "the test run did not finish within {}s and was stopped",
                RUN_DEADLINE.as_secs()
            ),
        ));
    };
    Ok((status.success(), format!("{out}\n{err}")))
}

/// The failures in a Rust test run's output.
///
/// Rust prints `---- <name> stdout ----` followed by what the test said, and
/// then a `failures:` list of names. The first is what carries the message, so
/// it is what is read.
pub fn parse_rust(output: &str) -> Vec<Failure> {
    let mut out = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("---- ") {
            if let Some((name, said)) = current.take() {
                out.push(Failure {
                    name,
                    message: tidy(&said),
                });
            }
            let name = rest
                .trim_end_matches("----")
                .trim()
                .trim_end_matches("stdout")
                .trim()
                .to_string();
            current = Some((name, Vec::new()));
            continue;
        }
        // The trailing `failures:` list repeats the names with no messages;
        // the blocks above are where the detail is.
        if trimmed == "failures:" || trimmed.starts_with("test result:") {
            if let Some((name, said)) = current.take() {
                out.push(Failure {
                    name,
                    message: tidy(&said),
                });
            }
            continue;
        }
        if let Some((_, said)) = current.as_mut() {
            if !trimmed.is_empty() {
                said.push(trimmed.to_string());
            }
        }
    }
    if let Some((name, said)) = current {
        out.push(Failure {
            name,
            message: tidy(&said),
        });
    }
    out.retain(|f| !f.name.is_empty());
    out
}

/// The first few lines a test printed, bounded.
fn tidy(lines: &[String]) -> String {
    let text = lines
        .iter()
        .take(6)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    tauri_plugin_agent_tools::harness_error::scrub(&text)
}

/// What two failures have to share to be the same failure.
///
/// Only provably incidental detail is removed: numbers, hex addresses and
/// paths. Anything else a failure said is part of what it said -- normalising
/// further would group failures that are not the same and call it a root
/// cause.
pub fn signature(message: &str) -> String {
    // `thread 'name_of_the_test' panicked at ...` names the test, which is the
    // one thing every failure in a group has different. Only this exact
    // preamble is rewritten: a quoted string anywhere else may well be what
    // the failure is about.
    // Rust writes `thread 'name' panicked at` and, since it started printing
    // thread ids, `thread 'name' (1234) panicked at`. Both are rewritten, and
    // only up to the `panicked at`.
    let message = match (message.find("thread '"), message.find("panicked at")) {
        (Some(start), Some(end)) if end > start => format!(
            "{}thread {}",
            &message[..start],
            &message[end..]
        ),
        _ => message.to_string(),
    };
    let message = message.as_str();
    let mut out = String::new();
    let mut chars = message.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // A path is where it happened, not what happened.
            '/' | '\\' => {
                while chars
                    .peek()
                    .is_some_and(|n| !n.is_whitespace() && *n != ':' && *n != '"')
                {
                    chars.next();
                }
                out.push_str("<path>");
            }
            c if c.is_ascii_digit() => {
                while chars.peek().is_some_and(|n| n.is_ascii_digit() || *n == '.') {
                    chars.next();
                }
                out.push_str("<n>");
            }
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Group failures by what they said (AH-152).
pub fn cluster(failures: &[Failure]) -> Vec<Cluster> {
    let mut groups: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for failure in failures {
        let entry = groups
            .entry(signature(&failure.message))
            .or_insert_with(|| (failure.message.clone(), Vec::new()));
        entry.1.push(failure.name.clone());
    }
    let mut out: Vec<Cluster> = groups
        .into_iter()
        .map(|(signature, (example, tests))| Cluster {
            signature,
            example,
            tests,
        })
        .collect();
    // The biggest group first: it is the one fix that buys the most.
    out.sort_by(|a, b| b.tests.len().cmp(&a.tests.len()).then(a.signature.cmp(&b.signature)));
    out
}

/// Run the tests, group what failed, and -- when asked -- run each failure
/// again to see whether it happens twice (AH-152, AH-153).
///
/// `command` is the test command as the caller wants it run; nothing is
/// invented here. `retry` is the argument that names one test to the runner
/// (`Some("")` appends the name as a bare argument, which is what `cargo test`
/// and most runners take); `None` skips the re-run entirely, and then nothing
/// is called flaky.
pub fn triage(
    project_root: &Path,
    command: &[String],
    retry: bool,
) -> Result<Triage, HarnessError> {
    if command.is_empty() {
        return Err(failed(
            ErrorKind::InvalidInput,
            "a triage needs a test command to run",
        ));
    }
    let (passed, output) = run(command, project_root)?;
    let failures = parse_rust(&output);
    let mut triage = Triage {
        clusters: cluster(&failures),
        // A run that failed and printed nothing this can read is worth saying
        // so about: silence here would read as "no failures".
        unreadable: !passed && failures.is_empty(),
        failures,
        command: command.to_vec(),
        ..Default::default()
    };
    if retry {
        for failure in &triage.failures {
            let mut again = command.to_vec();
            again.push(failure.name.clone());
            match run(&again, project_root) {
                // It passed this time: flaky, on this evidence.
                Ok((true, _)) => {
                    triage
                        .reproduced
                        .insert(failure.name.clone(), Reproduced::No);
                }
                Ok((false, _)) => {
                    triage
                        .reproduced
                        .insert(failure.name.clone(), Reproduced::Yes);
                }
                // A re-run that could not be done says nothing about the
                // failure, and is recorded as saying nothing.
                Err(_) => {
                    triage
                        .reproduced
                        .insert(failure.name.clone(), Reproduced::NotChecked);
                }
            }
        }
    } else {
        for failure in &triage.failures {
            triage
                .reproduced
                .insert(failure.name.clone(), Reproduced::NotChecked);
        }
    }
    Ok(triage)
}

/// The triage, as a person reads it.
pub fn render(triage: &Triage) -> String {
    if triage.unreadable {
        return format!(
            "the run failed and printed nothing this can read as test results\n  {}\n",
            triage.command.join(" ")
        );
    }
    if triage.failures.is_empty() {
        return "no failures\n".to_string();
    }
    let flaky: Vec<&String> = triage
        .reproduced
        .iter()
        .filter(|(_, r)| **r == Reproduced::No)
        .map(|(name, _)| name)
        .collect();
    let mut out = format!(
        "{} failure(s) in {} group(s)\n",
        triage.failures.len(),
        triage.clusters.len()
    );
    for cluster in &triage.clusters {
        out.push_str(&format!("  {} test(s) said the same thing:\n", cluster.tests.len()));
        for line in cluster.example.lines().take(3) {
            out.push_str(&format!("      {line}\n"));
        }
        for name in &cluster.tests {
            let mark = match triage.reproduced.get(name) {
                Some(Reproduced::No) => "  (passed on a re-run: flaky)",
                Some(Reproduced::Yes) => "  (failed again)",
                _ => "",
            };
            out.push_str(&format!("    {name}{mark}\n"));
        }
    }
    if !flaky.is_empty() {
        out.push_str(&format!(
            "{} of these did not happen again: {}\n",
            flaky.len(),
            flaky
                .iter()
                .map(|n| n.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUST_OUTPUT: &str = r#"
running 4 tests
test a ... FAILED
test b ... FAILED
test c ... FAILED
test d ... ok

failures:

---- a stdout ----
thread 'a' panicked at src/lib.rs:12:5:
assertion `left == right` failed
  left: 1
  right: 2

---- b stdout ----
thread 'b' panicked at src/lib.rs:40:9:
assertion `left == right` failed
  left: 3
  right: 4

---- c stdout ----
thread 'c' panicked at src/other.rs:7:1:
the door was locked

failures:
    a
    b
    c

test result: FAILED. 1 passed; 3 failed; 0 ignored
"#;

    /// Failures are read from what the runner printed, with the message each
    /// test actually said.
    #[test]
    fn failures_are_read_with_what_each_test_said() {
        let failures = parse_rust(RUST_OUTPUT);
        let names: Vec<&str> = failures.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"], "{failures:#?}");
        assert!(failures[0].message.contains("left: 1"), "{:?}", failures[0]);
        assert!(failures[2].message.contains("the door was locked"));
    }

    /// AH-152: failures that said the same thing are one group, and the group
    /// that costs the most is first. Line numbers and values are not what a
    /// failure is about.
    #[test]
    fn failures_that_said_the_same_thing_are_one_group() {
        let clusters = cluster(&parse_rust(RUST_OUTPUT));
        assert_eq!(clusters.len(), 2, "{clusters:#?}");
        assert_eq!(clusters[0].tests, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(clusters[1].tests, vec!["c".to_string()]);
        // The example is what was really printed, not the normalised form.
        assert!(clusters[0].example.contains("left: 1"), "{:?}", clusters[0]);
    }

    /// The normalisation removes only what is provably incidental.
    #[test]
    fn only_incidental_detail_is_normalised_away() {
        let a = signature("thread 'x' panicked at src/lib.rs:12:5: it broke");
        let b = signature("thread 'x' panicked at src/lib.rs:900:1: it broke");
        assert_eq!(a, b, "a line number is where, not what");

        let c = signature("expected 3 items, found 4");
        let d = signature("expected 9 items, found 1");
        assert_eq!(c, d, "counts in one message are the same complaint");

        let e = signature("the door was locked");
        assert_ne!(e, a, "different complaints stay different");

        // The test's own name is in the panic preamble, and it is the one
        // thing every failure in a group has different.
        let f = signature("thread 'one' panicked at src/lib.rs:1:1: it broke");
        let g = signature("thread 'another' panicked at src/lib.rs:2:2: it broke");
        assert_eq!(f, g);
        // Rust prints a thread id too, these days.
        let h = signature("thread 'one' (41640) panicked at src/lib.rs:1:1: it broke");
        assert_eq!(f, h);
        // A quoted string anywhere else is left alone: it may be what the
        // failure is about.
        assert_ne!(
            signature("expected 'red', found 'blue'"),
            signature("expected 'red', found 'green'")
        );
    }

    /// AH-153: a failure that passes on a re-run is flaky; one that fails
    /// again is not; and without a re-run nothing is claimed either way.
    #[test]
    fn a_failure_is_only_flaky_once_it_has_been_run_again() {
        let root = std::env::temp_dir().join(format!(
            "jan_triage_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // A "runner" that fails the first time it is asked about a test and
        // passes the second, which is exactly what a flake looks like.
        let script = root.join("runner.py");
        std::fs::write(
            &script,
            r#"import sys, os
here = os.path.dirname(os.path.abspath(__file__))
named = sys.argv[1] if len(sys.argv) > 1 else None
if named is None:
    print("running 2 tests")
    print("---- flaky stdout ----")
    print("thread 'flaky' panicked at src/lib.rs:1:1:")
    print("the network was slow")
    print("---- solid stdout ----")
    print("thread 'solid' panicked at src/lib.rs:2:2:")
    print("the network was slow")
    print("test result: FAILED. 0 passed; 2 failed; 0 ignored")
    sys.exit(1)
marker = os.path.join(here, named + ".seen")
if named == "flaky":
    sys.exit(0)
sys.exit(1)
"#,
        )
        .unwrap();
        let command = vec![
            "python".to_string(),
            script.to_string_lossy().to_string(),
        ];

        let without = triage(&root, &command, false).expect("triaged");
        assert_eq!(without.failures.len(), 2);
        assert!(
            without
                .reproduced
                .values()
                .all(|r| *r == Reproduced::NotChecked),
            "nothing is claimed without a re-run: {:?}",
            without.reproduced
        );
        // The test happens to be named "flaky"; what must be absent is any
        // claim about it.
        let text = render(&without);
        assert!(!text.contains("re-run"), "{text}");
        assert!(!text.contains("did not happen again"), "{text}");

        let with = triage(&root, &command, true).expect("triaged");
        assert_eq!(with.reproduced.get("flaky"), Some(&Reproduced::No));
        assert_eq!(with.reproduced.get("solid"), Some(&Reproduced::Yes));
        let text = render(&with);
        assert!(text.contains("passed on a re-run"), "{text}");
        assert!(text.contains("did not happen again: flaky"), "{text}");
        // Both said the same thing, so they are one group even though one of
        // them is a flake.
        assert_eq!(with.clusters.len(), 1, "{:#?}", with.clusters);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A run that failed and printed nothing this can read says so: silence
    /// would read as "no failures".
    #[test]
    fn output_that_cannot_be_read_is_said_to_be_unreadable() {
        let root = std::env::temp_dir().join(format!(
            "jan_triage_unreadable_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let command = if cfg!(windows) {
            vec![
                "python".to_string(),
                "-c".to_string(),
                "import sys; print('FAIL something, somewhere'); sys.exit(1)".to_string(),
            ]
        } else {
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "echo 'FAIL something, somewhere'; exit 1".to_string(),
            ]
        };
        let triaged = triage(&root, &command, false).expect("triaged");
        assert!(triaged.unreadable);
        assert!(render(&triaged).contains("nothing this can read"), "{}", render(&triaged));

        let err = triage(&root, &[], false).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&root);
    }
}
