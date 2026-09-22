//! Why a shell command failed, classified before anything is said about it.
//!
//! The sandbox hint used to be appended whenever a failed command's output
//! contained a denial-looking phrase. On Windows PowerShell that misfired on
//! the commonest mistake a model makes there: writing cmd's `2>nul`. PowerShell
//! reads `nul` as a file name, opens `\\.\nul` to write it, and reports "Access
//! to the path '\\.\nul' is denied". Told the sandbox had refused, the model
//! concluded its sandbox forbade what it wanted and gave up, when the fix was
//! `2>$null`.
//!
//! So a failure is classified first, from the command as well as its output,
//! and only a failure the sandbox actually caused gets the sandbox hint. Only
//! a file-access denial is something `request_access` can fix; syntax errors,
//! missing commands, missing paths, device files and network refusals are not.

use super::proc::ShellFlavor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureClass {
    /// cmd's `nul` redirection used in PowerShell. Carries the construct seen.
    CmdNulRedirect(String),
    /// A write to or open of a device path (`\\.\...`, `/dev/...`) failed.
    DeviceFile,
    /// The program does not exist in this shell.
    MissingCommand,
    /// A path the command named does not exist.
    NotFound,
    /// Outbound network was refused or name resolution failed.
    Network,
    /// A file or folder could not be read or written: what the sandbox does.
    FileAccessDenied,
    /// Nothing recognizable.
    Other,
}

/// Every cmd-style `nul` redirection in `command`, outside quotes: `>nul`,
/// `2>nul`, `1>nul`, `>>nul`, `2>>NUL`, `*>nul`, with or without a space.
pub fn cmd_nul_redirects(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut found = Vec::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c == '>' => {
                // The descriptor digit (or `*`) directly before `>`.
                let start = if i > 0 && (chars[i - 1].is_ascii_digit() || chars[i - 1] == '*') {
                    i - 1
                } else {
                    i
                };
                let mut j = i + 1;
                if j < chars.len() && chars[j] == '>' {
                    j += 1;
                }
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                let word_end = (j..chars.len())
                    .find(|&k| {
                        let ch = chars[k];
                        ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | ')' | '}')
                    })
                    .unwrap_or(chars.len());
                let word: String = chars[j..word_end].iter().collect();
                if word.eq_ignore_ascii_case("nul") || word.eq_ignore_ascii_case("nul:") {
                    let text: String = chars[start..word_end].iter().collect();
                    found.push(text.split_whitespace().collect::<Vec<_>>().join(""));
                }
                i = word_end.max(i + 1);
                continue;
            }
            None => {}
        }
        i += 1;
    }
    found
}

/// The PowerShell spelling of a cmd `nul` redirection.
pub fn powershell_equivalent(construct: &str) -> String {
    let lower = construct.to_ascii_lowercase();
    let head = lower.trim_end_matches(':').trim_end_matches("nul");
    // `>>` appends to a file; to `$null` it is the same as `>`.
    let head = head.replace(">>", ">");
    match head.as_str() {
        ">" | "1>" => "| Out-Null  (or >$null)".to_string(),
        "*>" => "*>$null".to_string(),
        other => format!("{other}$null"),
    }
}

/// The refusal returned instead of running a PowerShell command that uses
/// cmd's `nul`. Structured so the model can fix the command in one step.
pub fn cmd_nul_refusal(constructs: &[String]) -> String {
    let fixes: Vec<String> = constructs
        .iter()
        .map(|c| format!("`{c}` -> `{}`", powershell_equivalent(c)))
        .collect();
    format!(
        "ERROR [shell_syntax]: this command uses cmd.exe redirection to `nul` ({}), but \
         commands here run in PowerShell. In PowerShell `nul` is not the null device: it \
         is treated as a file name and the redirect fails with \"Access to the path \
         '\\\\.\\nul' is denied\". That is a syntax problem, not a sandbox restriction. \
         Nothing was run.\n\
         Fix: {}. Then run the command again.",
        constructs.join(", "),
        fixes.join("; ")
    )
}

const MISSING_COMMAND: &[&str] = &[
    "is not recognized as the name of a cmdlet",
    "is not recognized as an internal or external command",
    "command not found",
    "commandnotfoundexception",
];

const NOT_FOUND: &[&str] = &[
    "cannot find path",
    "because it does not exist",
    "no such file or directory",
    "the system cannot find the path specified",
    "the system cannot find the file specified",
    "could not find a part of the path",
    "itemnotfoundexception",
    "pathnotfound",
];

const NETWORK: &[&str] = &[
    "network is unreachable",
    "temporary failure in name resolution",
    "could not resolve host",
    "name or service not known",
    "forbidden by its access permissions",
    "no such host is known",
    "attempt was made to access a socket",
    "unable to connect to the remote server",
    "the remote name could not be resolved",
    "connection refused",
];

const FILE_DENIED: &[&str] = &[
    "operation not permitted",
    "permission denied",
    "access is denied",
    "read-only file system",
    "not permitted",
    "unauthorizedaccessexception",
    "access to the path",
    "bwrap:",
    "sandbox",
    "seccomp",
    "landlock",
    "the requested operation requires elevation",
];

/// Device paths a denial may name. A denial on one of these is never about a
/// folder the user could grant.
fn names_device(lower: &str) -> bool {
    lower.contains(r"'\\.\")
        || lower.contains(r"\\.\nul")
        || lower.contains("/dev/null")
        || lower.contains("'/dev/")
        || lower.contains(r"\\.\pipe")
}

/// Classify a failed command's output. `command` matters: the same "access
/// denied" means different things after `2>nul` in PowerShell and after
/// `cat ~/.ssh/config`.
pub fn classify(command: &str, output: &str, flavor: ShellFlavor) -> FailureClass {
    let lower = output.to_lowercase();
    if flavor == ShellFlavor::PowerShell {
        let redirects = cmd_nul_redirects(command);
        if !redirects.is_empty() {
            return FailureClass::CmdNulRedirect(redirects.join(", "));
        }
        if lower.contains(r"\\.\nul") {
            return FailureClass::CmdNulRedirect("nul".to_string());
        }
    }
    if names_device(&lower) {
        return FailureClass::DeviceFile;
    }
    if MISSING_COMMAND.iter().any(|m| lower.contains(m)) {
        return FailureClass::MissingCommand;
    }
    if NETWORK.iter().any(|m| lower.contains(m)) {
        return FailureClass::Network;
    }
    // A denial beats "not found": a sandboxed read of a hidden home can print
    // both, and the denial is the cause.
    if FILE_DENIED.iter().any(|m| lower.contains(m)) {
        return FailureClass::FileAccessDenied;
    }
    if NOT_FOUND.iter().any(|m| lower.contains(m)) {
        return FailureClass::NotFound;
    }
    FailureClass::Other
}

/// A one-line identity for the shell, prefixed to non-POSIX output so the
/// model writes the next command in the right syntax.
pub fn shell_banner(flavor: ShellFlavor, description: &str) -> Option<String> {
    match flavor {
        ShellFlavor::PowerShell => Some(format!(
            "[shell: PowerShell ({description}). Use PowerShell syntax: `2>$null` / `| Out-Null` \
             to discard output (not cmd's `2>nul`), `$env:NAME` for variables, `;` to chain.]\n"
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_every_cmd_nul_spelling() {
        assert_eq!(cmd_nul_redirects("findstr x f 2>nul"), vec!["2>nul"]);
        assert_eq!(cmd_nul_redirects("dir >nul"), vec![">nul"]);
        assert_eq!(cmd_nul_redirects("dir 1>NUL"), vec!["1>NUL"]);
        assert_eq!(cmd_nul_redirects("dir 2>> nul; ls"), vec!["2>>nul"]);
        assert_eq!(cmd_nul_redirects("x *>nul"), vec!["*>nul"]);
        assert_eq!(cmd_nul_redirects("a 2>nul; b >nul").len(), 2);
    }

    #[test]
    fn leaves_powershell_null_and_quoted_text_alone() {
        assert!(cmd_nul_redirects("ls C:\\x 2>$null").is_empty());
        assert!(cmd_nul_redirects("ls | Out-Null").is_empty());
        assert!(cmd_nul_redirects("echo '2>nul'").is_empty());
        assert!(cmd_nul_redirects("echo \"a >nul b\"").is_empty());
        assert!(cmd_nul_redirects("cat file > null.txt").is_empty());
        assert!(cmd_nul_redirects("cat file > nullable").is_empty());
    }

    #[test]
    fn suggests_the_exact_powershell_form() {
        assert_eq!(powershell_equivalent("2>nul"), "2>$null");
        assert_eq!(powershell_equivalent("2>>nul"), "2>$null");
        assert_eq!(powershell_equivalent("*>nul"), "*>$null");
        assert!(powershell_equivalent(">nul").contains("Out-Null"));
        let r = cmd_nul_refusal(&["2>nul".to_string()]);
        assert!(r.contains("`2>$null`"));
        assert!(r.contains("not a sandbox restriction"));
        assert!(r.contains("Nothing was run"));
    }

    /// The exact output from the report that started this.
    const REPORTED: &str = "out-file : Access to the path '\\\\.\\nul' is denied.\n\
        At line:1 char:218\n    + CategoryInfo : OpenError: (:) [Out-File], UnauthorizedAccessException\n[exit 1]";

    #[test]
    fn powershell_nul_denial_is_syntax_not_sandbox() {
        let class = classify(
            "findstr /S /I \"caveman\" C:\\x\\settings.json 2>nul; ls C:\\x 2>$null",
            REPORTED,
            ShellFlavor::PowerShell,
        );
        assert_eq!(class, FailureClass::CmdNulRedirect("2>nul".to_string()));
        // Even when the command text is not available, the device path says it.
        assert_eq!(
            classify("", REPORTED, ShellFlavor::PowerShell),
            FailureClass::CmdNulRedirect("nul".to_string())
        );
        // Under any other shell a `\\.\` denial is a device error, still not
        // something to grant.
        assert_eq!(classify("", REPORTED, ShellFlavor::Cmd), FailureClass::DeviceFile);
    }

    #[test]
    fn genuine_file_denials_stay_sandbox_denials() {
        let ps = "Get-Content : Access to the path 'C:\\Users\\me\\notes.txt' is denied.\n\
                  + CategoryInfo : PermissionDenied: (...) UnauthorizedAccessException\n[exit 1]";
        assert_eq!(
            classify("Get-Content C:\\Users\\me\\notes.txt", ps, ShellFlavor::PowerShell),
            FailureClass::FileAccessDenied
        );
        assert_eq!(
            classify("cat /home/me/x", "cat: /home/me/x: Permission denied\n[exit 1]", ShellFlavor::Posix),
            FailureClass::FileAccessDenied
        );
    }

    #[test]
    fn other_failures_are_not_access_problems() {
        assert_eq!(
            classify("foo", "foo : The term 'foo' is not recognized as the name of a cmdlet", ShellFlavor::PowerShell),
            FailureClass::MissingCommand
        );
        assert_eq!(
            classify("ls C:\\nope", "ls : Cannot find path 'C:\\nope' because it does not exist.", ShellFlavor::PowerShell),
            FailureClass::NotFound
        );
        assert_eq!(
            classify("curl x", "curl: (6) Could not resolve host: x", ShellFlavor::Posix),
            FailureClass::Network
        );
        assert_eq!(
            classify("x > /dev/null", "bash: /dev/null: Permission denied", ShellFlavor::Posix),
            FailureClass::DeviceFile
        );
        assert_eq!(classify("x", "test failed: 3 assertions", ShellFlavor::Posix), FailureClass::Other);
    }

    #[test]
    fn banner_names_powershell_only() {
        assert!(shell_banner(ShellFlavor::PowerShell, "powershell").unwrap().contains("2>$null"));
        assert!(shell_banner(ShellFlavor::Posix, "bash").is_none());
    }
}
