//! The `docker` tool: read-only Docker, run by the host.
//!
//! The Docker CLI cannot talk to its engine from inside the `bash` sandbox. This
//! runs it directly as an argv array (never a shell string), and only the calls
//! that look: listing containers and images, logs, top, port, one stats sample,
//! version and info, and the same reads through `docker compose`. Anything that
//! starts, stops, removes, builds, runs or execs is refused with a message
//! telling the model to hand the command to the user. Flags are matched against
//! a list per subcommand, so an option that changes the host, the context or
//! the engine (`-H`, `--context`, `--config`, `-f`, ...) never reaches the CLI.
//! `inspect` is not offered: it prints a container's environment, which is
//! where credentials live. Output is redacted and bounded.

use std::time::Duration;

use serde_json::Value;

const OUTPUT_CAP: usize = 48 * 1024;
const TIMEOUT_SECS: u64 = 30;

/// A flag, and whether it takes a value.
type Flag = (&'static str, bool);

const FORMAT: Flag = ("--format", true);
const FILTER: Flag = ("--filter", true);
const NO_TRUNC: Flag = ("--no-trunc", false);
const ALL: Flag = ("--all", false);
const ALL_SHORT: Flag = ("-a", false);
const QUIET: Flag = ("--quiet", false);
const QUIET_SHORT: Flag = ("-q", false);
const TAIL: Flag = ("--tail", true);
const SINCE: Flag = ("--since", true);
const UNTIL: Flag = ("--until", true);
const TIMESTAMPS: Flag = ("--timestamps", false);
const TIMESTAMPS_SHORT: Flag = ("-t", false);

struct Sub {
    words: &'static [&'static str],
    flags: &'static [Flag],
    /// At most this many positional arguments (a container or service name).
    positionals: usize,
    /// A flag the call must carry.
    requires: Option<&'static str>,
}

const SUBS: &[Sub] = &[
    Sub {
        words: &["ps"],
        flags: &[ALL, ALL_SHORT, QUIET, QUIET_SHORT, NO_TRUNC, FORMAT, FILTER, ("--last", true), ("-n", true), ("--size", false)],
        positionals: 0,
        requires: None,
    },
    Sub { words: &["images"], flags: &[ALL, ALL_SHORT, QUIET, QUIET_SHORT, NO_TRUNC, FORMAT, FILTER], positionals: 1, requires: None },
    Sub { words: &["logs"], flags: &[TAIL, SINCE, UNTIL, TIMESTAMPS, TIMESTAMPS_SHORT], positionals: 1, requires: None },
    Sub { words: &["top"], flags: &[], positionals: 1, requires: None },
    Sub { words: &["port"], flags: &[], positionals: 1, requires: None },
    Sub {
        words: &["stats"],
        flags: &[("--no-stream", false), NO_TRUNC, FORMAT, ALL, ALL_SHORT],
        positionals: 4,
        requires: Some("--no-stream"),
    },
    Sub { words: &["version"], flags: &[FORMAT], positionals: 0, requires: None },
    Sub { words: &["info"], flags: &[FORMAT], positionals: 0, requires: None },
    Sub {
        words: &["compose", "ps"],
        flags: &[ALL, ALL_SHORT, QUIET, QUIET_SHORT, FORMAT, FILTER, ("--services", false), ("--status", true)],
        positionals: 4,
        requires: None,
    },
    Sub {
        words: &["compose", "logs"],
        flags: &[TAIL, SINCE, UNTIL, TIMESTAMPS, TIMESTAMPS_SHORT, ("--no-log-prefix", false)],
        positionals: 4,
        requires: None,
    },
    Sub { words: &["compose", "top"], flags: &[], positionals: 4, requires: None },
    Sub { words: &["compose", "ls"], flags: &[ALL, ALL_SHORT, QUIET, QUIET_SHORT, FORMAT, FILTER], positionals: 0, requires: None },
    Sub { words: &["compose", "version"], flags: &[FORMAT], positionals: 0, requires: None },
];

const ASKED_BY_THE_USER: &[&str] = &[
    "run", "exec", "start", "stop", "restart", "kill", "rm", "rmi", "build", "pull", "push", "create", "up", "down", "cp",
    "commit", "tag", "login", "logout", "network", "volume", "system", "prune", "inspect", "save", "load", "export", "import",
    "attach", "update", "pause", "unpause", "rename", "context", "config", "swarm", "service",
];

/// The argv for a call, or the reason it is refused.
pub fn plan(args: &Value) -> Result<Vec<String>, String> {
    let list = args
        .get("args")
        .and_then(Value::as_array)
        .ok_or("ERROR: docker needs 'args', the words after `docker`, such as [\"ps\", \"-a\"].")?;
    let mut words: Vec<&str> = Vec::new();
    for item in list {
        let word = item.as_str().ok_or("ERROR: every docker argument must be a string.")?;
        if word.is_empty() || word.len() > 200 || word.chars().any(|c| c.is_control()) {
            return Err("ERROR: a docker argument is empty, too long or holds a control character.".into());
        }
        words.push(word);
    }
    if words.is_empty() || words.len() > 24 {
        return Err("ERROR: docker takes 1 to 24 arguments.".into());
    }
    let sub = SUBS
        .iter()
        .find(|s| words.len() >= s.words.len() && s.words.iter().zip(&words).all(|(a, b)| a == b))
        .ok_or_else(|| {
            let changes = ASKED_BY_THE_USER.contains(&words[0])
                || (words[0] == "compose" && words.get(1).is_some_and(|w| ASKED_BY_THE_USER.contains(w)));
            if changes {
                format!(
                    "ERROR: `docker {}` changes things, so it is not run from here. Give the user the exact command to run.",
                    words[0]
                )
            } else {
                "ERROR: docker here only reads: ps, images, logs, top, port, stats --no-stream, version, info, and compose ps, logs, top, ls, version.".to_string()
            }
        })?;
    let mut argv: Vec<String> = sub.words.iter().map(|w| w.to_string()).collect();
    let mut positionals = 0;
    let mut seen_requires = sub.requires.is_none();
    let mut i = sub.words.len();
    while i < words.len() {
        let word = words[i];
        if word.starts_with('-') {
            let (name, inline) = match word.split_once('=') {
                Some((n, v)) if n.starts_with("--") => (n, Some(v)),
                _ => (word, None),
            };
            let flag = sub
                .flags
                .iter()
                .find(|(f, _)| *f == name)
                .ok_or_else(|| format!("ERROR: docker {} does not take the option {name} here.", sub.words.join(" ")))?;
            if sub.requires == Some(flag.0) {
                seen_requires = true;
            }
            argv.push(word.to_string());
            if flag.1 && inline.is_none() {
                i += 1;
                let value = words.get(i).ok_or_else(|| format!("ERROR: {name} needs a value."))?;
                if value.starts_with('-') {
                    return Err(format!("ERROR: the value of {name} may not start with a dash."));
                }
                argv.push(value.to_string());
            }
        } else {
            positionals += 1;
            if positionals > sub.positionals {
                return Err(format!("ERROR: docker {} takes at most {} name(s).", sub.words.join(" "), sub.positionals));
            }
            argv.push(word.to_string());
        }
        i += 1;
    }
    if !seen_requires {
        return Err(format!(
            "ERROR: docker {} needs {} (it would otherwise run until stopped).",
            sub.words.join(" "),
            sub.requires.unwrap_or("")
        ));
    }
    Ok(argv)
}

fn bounded(text: &str) -> String {
    if text.len() <= OUTPUT_CAP {
        return text.to_string();
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output cut at {} KB; use --tail or a filter]", &text[..end], OUTPUT_CAP / 1024)
}

pub async fn docker(args: &Value) -> String {
    let argv = match plan(args) {
        Ok(argv) => argv,
        Err(message) => return message,
    };
    let mut cmd = tokio::process::Command::new("docker");
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(&argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env("DOCKER_CLI_HINTS", "false")
        .env("COMPOSE_ANSI", "never");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let run = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await;
    match run {
        Err(_) => format!("ERROR: docker did not finish in {TIMEOUT_SECS} seconds and was stopped."),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            "ERROR: Docker is not installed, or `docker` is not on this computer's PATH.".to_string()
        }
        Ok(Err(e)) => format!("ERROR: could not run docker: {e}"),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !out.status.success() {
                let reason = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
                return format!("ERROR: docker failed: {}", bounded(&crate::secrets::redact_secrets(reason)));
            }
            let mut text = stdout.trim().to_string();
            let is_logs = argv[0] == "logs" || argv.get(1).is_some_and(|w| w == "logs");
            if is_logs && !stderr.trim().is_empty() {
                // A container writes its log to both streams.
                text = format!("{text}\n{}", stderr.trim()).trim().to_string();
            }
            if text.is_empty() {
                return "No output.".to_string();
            }
            bounded(&crate::secrets::redact_secrets(&text))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn argv(words: &[&str]) -> Result<Vec<String>, String> {
        plan(&json!({ "args": words }))
    }

    #[test]
    fn reads_are_allowed() {
        assert_eq!(argv(&["ps", "-a"]).unwrap(), ["ps", "-a"]);
        assert_eq!(argv(&["logs", "--tail", "50", "web"]).unwrap(), ["logs", "--tail", "50", "web"]);
        assert_eq!(argv(&["logs", "--tail=50", "web"]).unwrap(), ["logs", "--tail=50", "web"]);
        assert_eq!(
            argv(&["compose", "ps", "--status", "running"]).unwrap(),
            ["compose", "ps", "--status", "running"]
        );
        assert!(argv(&["stats", "--no-stream"]).is_ok());
        assert!(argv(&["version"]).is_ok());
    }

    #[test]
    fn anything_that_changes_things_is_refused() {
        for words in [
            &["run", "-it", "alpine"][..],
            &["exec", "web", "sh"],
            &["rm", "-f", "web"],
            &["compose", "up", "-d"],
            &["compose", "down"],
            &["system", "prune"],
            &["inspect", "web"],
            &["build", "."],
        ] {
            let err = argv(words).unwrap_err();
            assert!(err.contains("changes things") || err.contains("only reads"), "{words:?}: {err}");
        }
    }

    #[test]
    fn options_that_redirect_the_engine_or_follow_forever_are_refused() {
        for words in [
            &["-H", "tcp://evil:2375", "ps"][..],
            &["ps", "-H", "tcp://evil"],
            &["--context", "prod", "ps"],
            &["ps", "--config", "x"],
            &["logs", "-f", "web"],
            &["logs", "--follow", "web"],
            &["compose", "-f", "x.yml", "ps"],
            &["compose", "--project-directory", "x", "ps"],
            &["stats"],
            &["ps", "--format"],
            &["logs", "--tail", "-1", "web"],
            &["ps", "extra"],
        ] {
            assert!(argv(words).is_err(), "{words:?}");
        }
    }

    #[test]
    fn shape_errors_are_refused() {
        assert!(plan(&json!({})).is_err());
        assert!(plan(&json!({ "args": [] })).is_err());
        assert!(plan(&json!({ "args": [1] })).is_err());
        assert!(plan(&json!({ "args": [""] })).is_err());
        assert!(argv(&["ps\n-a"]).is_err());
    }
}
