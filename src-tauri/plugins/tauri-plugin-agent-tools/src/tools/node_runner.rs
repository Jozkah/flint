//! Node's test runner inside the Windows AppContainer.
//!
//! `node --test` runs each test file in a child process with piped stdio.
//! libuv builds those pipes as named pipes under the global pipe namespace, and an
//! AppContainer is refused that namespace (`ERROR_ACCESS_DENIED`). libuv
//! reads that error as "name already taken" and retries with a new name
//! forever, so the call never returns: the spawn itself blocks, which is why
//! even a `timeout` option in the script cannot rescue it. A run that takes
//! 0.1 s outside the sandbox sat there until the tool's deadline, three times
//! in a row, and the task was stopped for repeating itself.
//!
//! Two defences, both here so the wording lives in one place:
//!
//! - the PowerShell prologue wraps `node` so `node --test ...` runs without
//!   per-file child processes (`--test-isolation=none`) when the shell is
//!   confined, and
//! - a timed-out run that looks like a test runner says why and what to do
//!   instead of the generic "re-run with a larger timeout", which is the one
//!   advice that cannot work.

use super::proc::ShellFlavor;

/// Prologue for the PowerShell shell: `node --test` without child isolation
/// inside the container. A no-op everywhere else (the marker is only set by
/// `win_env::build`). The flag is spelled `--test-isolation=none` from Node
/// 23.6 and `--experimental-test-isolation=none` from 22.8; older Node gets
/// no rewrite and the timeout note.
pub(crate) const POWERSHELL_NODE_TEST_SHIM: &str = r##"if ($env:FLINT_SANDBOX -eq 'appcontainer' -and (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { foreach ($__jn in 'node','node.exe') { Set-Item -Path "Function:global:$__jn" -Value ([scriptblock]::Create(@'
$__real = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$__a = @($args)
if (($__a -contains '--test') -and -not @($__a | Where-Object { "$_" -match '^--(experimental-)?test-isolation' })) {
  $__v = $null
  try { $__v = [version](((& $__real --version) -join '').Trim().TrimStart('v')) } catch { }
  $__flag = $null
  if ($__v -and $__v -ge [version]'23.6.0') { $__flag = '--test-isolation=none' }
  elseif ($__v -and $__v -ge [version]'22.8.0') { $__flag = '--experimental-test-isolation=none' }
  if ($__flag) { $__a = @($__flag) + $__a }
}
& $__real @__a
if ($LASTEXITCODE) { $global:LASTEXITCODE = $LASTEXITCODE; Write-Error "node exited with code $LASTEXITCODE" }
'@)) } }"##;

/// True for a command that starts Node's test runner: `node --test ...`,
/// `node.exe --test`, or a package script named `test`. The script case is a
/// guess, so it is only used to word a note, never to change the command.
pub fn is_node_test_command(command: &str) -> bool {
    let tokens: Vec<String> = command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')'))
        .filter(|t| !t.is_empty())
        .map(|t| t.trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase())
        .collect();
    let is_node = |t: &str| {
        let stem = t.rsplit(['/', '\\']).next().unwrap_or(t);
        stem == "node" || stem == "node.exe"
    };
    for (i, t) in tokens.iter().enumerate() {
        if is_node(t) && tokens[i + 1..].iter().take_while(|n| !is_node(n)).any(|n| n == "--test") {
            return true;
        }
        if matches!(t.as_str(), "npm" | "pnpm" | "yarn" | "npm.cmd" | "yarn.cmd" | "pnpm.cmd") {
            let rest = &tokens[i + 1..];
            if rest.first().is_some_and(|a| a == "test" || a == "t")
                || (rest.first().is_some_and(|a| a == "run" || a == "run-script")
                    && rest.get(1).is_some_and(|a| a.starts_with("test")))
            {
                return true;
            }
        }
    }
    false
}

/// What to tell the model when a sandboxed Windows run of a Node test command
/// hit its deadline. `None` when it does not apply.
pub fn timeout_note(
    command: &str,
    sandboxed: bool,
    flavor: ShellFlavor,
    shell: &str,
) -> Option<String> {
    if !cfg!(windows) || !sandboxed || !is_node_test_command(command) {
        return None;
    }
    let syntax = match flavor {
        ShellFlavor::PowerShell => "PowerShell syntax",
        ShellFlavor::Cmd => "cmd syntax",
        _ => "POSIX shell syntax",
    };
    Some(format!(
        "\n[cause: Node's test runner starts one child process per test file, and \
         inside this Windows sandbox that spawn never returns (libuv cannot create \
         its pipes in the container). It is not a slow test and a longer timeout \
         will not help; do not run the same command again.\n\
         remedy: run the files in this process with `node --test --test-isolation=none \
         <files>` (Node 22.8 to 23.5: `--experimental-test-isolation=none`), or run a \
         single file directly with `node <file>`; the `node:test` API works without \
         child processes. This shell is {shell} ({syntax}).\n\
         If the tests themselves spawn child processes they cannot run in the sandbox: \
         say so in your handoff, and name the exact command the user should run.]"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_node_test_runner() {
        for c in [
            "node --test",
            "node --test tests/commands.test.js",
            "node.exe --test --test-concurrency=1",
            "cd src; node --test",
            "npm test",
            "npm run test:unit",
            "yarn test",
            r"& 'C:\Program Files\nodejs\node.exe' --test a.js",
        ] {
            assert!(is_node_test_command(c), "{c}");
        }
        for c in ["node app.js", "node -e \"1\"", "echo --test", "npm install", "cargo test"] {
            assert!(!is_node_test_command(c), "{c}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_note_names_cause_remedy_and_shell() {
        let n = timeout_note("node --test", true, ShellFlavor::PowerShell, "powershell").unwrap();
        assert!(n.contains("--test-isolation=none"), "{n}");
        assert!(n.contains("do not run the same command again"), "{n}");
        assert!(n.contains("PowerShell syntax"), "{n}");
        assert!(timeout_note("node --test", false, ShellFlavor::PowerShell, "powershell").is_none());
        assert!(timeout_note("node app.js", true, ShellFlavor::PowerShell, "powershell").is_none());
    }

    /// The shim is only live under the container marker, and runs a test file
    /// in this process (no per-file child) there. Skipped when Node is absent.
    #[cfg(windows)]
    #[test]
    fn the_shim_replaces_node_only_inside_the_container() {
        let has_node = std::process::Command::new("node").arg("--version").output().is_ok();
        if !has_node {
            return;
        }
        let dir = std::env::temp_dir().join(format!("jan-nodeshim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("a.test.js"),
            "const t=require('node:test');t('one',()=>{});t('two',()=>{});",
        )
        .unwrap();
        let run = |marker: bool, command: &str| {
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command"])
                .arg(super::super::proc::located(ShellFlavor::PowerShell, command, &dir))
                .current_dir(&dir);
            if marker {
                cmd.env("FLINT_SANDBOX", "appcontainer");
            } else {
                cmd.env_remove("FLINT_SANDBOX");
            }
            let out = cmd.output().unwrap();
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        let kind = "(Get-Command node).CommandType";
        let inside = run(true, kind);
        let outside = run(false, kind);
        let ran = run(true, "node --test a.test.js; \"code=$LASTEXITCODE\"");
        // RQA-009: a failing run through the wrapper is not reported as exit 0.
        std::fs::write(dir.join("b.test.js"), "require('node:test')('bad',()=>{throw new Error('x')});").unwrap();
        let failed = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(super::super::proc::located(ShellFlavor::PowerShell, "node --test b.test.js", &dir))
            .current_dir(&dir)
            .env("FLINT_SANDBOX", "appcontainer")
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(failed.status.code(), Some(0), "{}", String::from_utf8_lossy(&failed.stdout));
        assert!(inside.trim().ends_with("Function"), "inside: {inside}");
        assert!(outside.trim().ends_with("Application"), "outside: {outside}");
        assert!(ran.contains("code=0"), "ran: {ran}");
    }

    #[test]
    fn the_shim_is_gated_on_the_container_marker() {
        assert!(POWERSHELL_NODE_TEST_SHIM.contains("FLINT_SANDBOX"));
        assert!(POWERSHELL_NODE_TEST_SHIM.contains("--test-isolation=none"));
        assert!(POWERSHELL_NODE_TEST_SHIM.contains("--experimental-test-isolation=none"));
    }
}
