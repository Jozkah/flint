//! The one place a Windows sandboxed process's environment is built.
//!
//! `CreateProcessW` takes the environment as a single block of UTF-16, and the
//! rules it is parsed by are not the rules a `HashMap<String, String>` follows.
//! Getting them wrong does not produce a process with a slightly wrong
//! environment -- it produces no process at all, with an error that names
//! nothing useful. The failure that motivated this module was exactly that:
//!
//! ```text
//! could not start C:\Program Files\Git\bin\bash.exe inside the sandbox:
//! The system could not find the environment option that was entered. (os error 203)
//! ```
//!
//! `ERROR_ENVVAR_NOT_FOUND` (203), from `CreateProcessW` itself, before any
//! process exists. The shell was present, readable and executable; the sandbox
//! policy was fine. What was missing was `LOCALAPPDATA` in the environment the
//! child was to receive. Creating a process inside an AppContainer makes
//! Windows resolve the container's own redirected storage --
//! `%LOCALAPPDATA%\Packages\<moniker>\AC` -- out of the environment block being
//! handed to the child, and a block without that name fails the whole call.
//!
//! So the environment is not a convenience here, it is a precondition of the
//! spawn. It is built deliberately, in one function, with the required names
//! supplied explicitly rather than inherited by luck.
//!
//! What this module deliberately does *not* do is hand the sandbox the host's
//! environment. A curated set is assembled: the system locations a Windows
//! process needs to find its own DLLs and interpreter, plus a synthetic home
//! inside the session scratch, so a shell that looks for a profile finds an
//! empty one that belongs to the sandbox rather than the user's real
//! `C:\Users\<name>`.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

/// Why an environment could not be built. Each variant names something a
/// caller can act on; none of them carry a value, so a diagnostic built from
/// one cannot leak a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvError {
    /// A name or value contained a NUL, which would truncate the block.
    EmbeddedNul { name: String },
    /// A name was empty, or contained `=` somewhere other than the leading
    /// position that marks a drive-current-directory entry.
    InvalidName { name: String },
    /// A variable the spawn cannot proceed without was not available on the
    /// host and had no substitute.
    MissingRequired { name: &'static str },
}

impl std::fmt::Display for EnvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnvError::EmbeddedNul { name } => {
                write!(f, "environment variable {name} contains a NUL character")
            }
            EnvError::InvalidName { name } => {
                write!(f, "{name:?} is not a usable environment variable name")
            }
            EnvError::MissingRequired { name } => write!(
                f,
                "the environment is missing {name}, which Windows needs to start a \
                 process in a sandbox"
            ),
        }
    }
}

/// Names whose absence stops the spawn rather than degrading it.
///
/// `SystemRoot` is how a process finds `system32` and therefore every system
/// DLL. `LOCALAPPDATA` is what `CreateProcessW` resolves the AppContainer's own
/// storage from; without it the call fails with `ERROR_ENVVAR_NOT_FOUND` and
/// no process is created. Both come from the host because both name real host
/// locations -- the container reaches only its own subtree of the second, and
/// nothing under the first is writable.
pub const REQUIRED: &[&str] = &["SystemRoot", "LOCALAPPDATA"];

/// System locations copied from the host when present.
///
/// Every one of these is a path to something Windows or a shell needs to find:
/// the system directory, the command interpreter, the executable-extension
/// list, the program directories a native tool resolves its own installation
/// through. None is user data and none is a secret.
pub const SYSTEM_PASSTHROUGH: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "LANG",
    "TERM",
];

/// Names pointed at the sandbox's own synthetic profile rather than the user's.
///
/// A shell started with the host's `HOME` reads the host's `.bashrc`, the
/// host's `.gitconfig` and the host's credential helpers -- from a process the
/// user asked to be confined. Redirecting these is what makes the confinement
/// true for the shell's own conventions, not only for the filesystem ACLs.
pub const HOME_KEYS: &[&str] = &["HOME", "USERPROFILE", "APPDATA"];

/// Every spelling of "where temporary files go".
pub const TEMP_KEYS: &[&str] = &["TEMP", "TMP", "TMPDIR"];

/// Names that must never be copied to a sandboxed process even if some future
/// passthrough list grows to include them. Matched case-insensitively on a
/// substring, because the interesting ones are provider-prefixed
/// (`OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) and no fixed list would keep up.
const SECRET_MARKERS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "auth",
    "session",
];

/// True when a name looks like it carries a secret, so diagnostics redact its
/// value. Names themselves are always safe to print; values never are.
pub fn looks_secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_MARKERS.iter().any(|m| lower.contains(m))
}

/// An environment ready to be encoded, in the order Windows expects.
///
/// Kept as an ordered map keyed by the case-folded name: Windows environment
/// variables are case-insensitive, so `Path` and `PATH` are one variable and a
/// block containing both is malformed. `BTreeMap` gives the case-insensitive
/// sort the block also wants, and puts drive-current-directory entries
/// (`=C:`) first, which is where Windows itself writes them -- `=` sorts below
/// every letter.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SandboxEnv {
    entries: BTreeMap<String, (String, OsString)>,
}

impl SandboxEnv {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace one variable. The last write wins, so a caller can
    /// layer a redirect (the synthetic home) over a passthrough (the host's).
    pub fn set(&mut self, name: &str, value: impl Into<OsString>) {
        self.entries
            .insert(fold(name), (name.to_string(), value.into()));
    }

    /// Insert only when the name is not already present.
    pub fn set_if_absent(&mut self, name: &str, value: impl Into<OsString>) {
        self.entries
            .entry(fold(name))
            .or_insert_with(|| (name.to_string(), value.into()));
    }

    pub fn get(&self, name: &str) -> Option<&OsStr> {
        self.entries.get(&fold(name)).map(|(_, v)| v.as_os_str())
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(&fold(name))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The variable names, in block order. Safe to log: this is what a
    /// diagnostic reports instead of the values.
    pub fn names(&self) -> Vec<String> {
        self.entries
            .values()
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// `NAME=<len 42>` for every entry, with anything secret-looking marked.
    /// Enough to debug a malformed block, and never enough to leak one.
    pub fn redacted(&self) -> Vec<String> {
        self.entries
            .values()
            .map(|(name, value)| {
                if looks_secret(name) {
                    format!("{name}=<redacted>")
                } else {
                    format!("{name}=<len {}>", value.len())
                }
            })
            .collect()
    }

    /// Validate every entry and encode the UTF-16 block `CreateProcessW` wants:
    /// `NAME=VALUE\0` repeated, then one more `\0` to end the block.
    ///
    /// An empty environment still needs the terminator, and cannot be an empty
    /// vector -- a null pointer means "inherit the parent's", which is the
    /// opposite of what a caller asking for an empty environment means.
    pub fn encode(&self) -> Result<Vec<u16>, EnvError> {
        let mut block: Vec<u16> = Vec::new();
        for (name, value) in self.entries.values() {
            validate_name(name)?;
            let wide: Vec<u16> = encode_wide(value);
            if wide.contains(&0) {
                return Err(EnvError::EmbeddedNul { name: name.clone() });
            }
            block.extend(name.encode_utf16());
            block.push(u16::from(b'='));
            block.extend(wide);
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }
}

#[cfg(windows)]
fn encode_wide(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().collect()
}

#[cfg(not(windows))]
fn encode_wide(value: &OsStr) -> Vec<u16> {
    value.to_string_lossy().encode_utf16().collect()
}

/// The key two spellings of one variable share.
fn fold(name: &str) -> String {
    name.to_uppercase()
}

/// A usable name is non-empty, NUL-free, and contains no `=` -- except for the
/// leading `=` of a drive-current-directory entry (`=C:`), which Windows writes
/// into its own blocks to remember the working directory of each drive. Those
/// are preserved verbatim: dropping them changes how a child resolves a
/// relative path like `D:foo`, and rewriting them corrupts the block.
fn validate_name(name: &str) -> Result<(), EnvError> {
    if name.contains('\0') {
        return Err(EnvError::EmbeddedNul {
            name: name.replace('\0', "\\0"),
        });
    }
    let body = name.strip_prefix('=').unwrap_or(name);
    if body.is_empty() || body.contains('=') {
        return Err(EnvError::InvalidName {
            name: name.to_string(),
        });
    }
    Ok(())
}

/// True for a drive-current-directory entry such as `=C:`.
pub fn is_drive_entry(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('=') else {
        return false;
    };
    let bytes = rest.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// What a sandboxed process is allowed to see of the host, and where its
/// private directories are.
pub struct SandboxEnvSpec<'a> {
    /// The private home created for this session, inside the scratch.
    pub home: &'a Path,
    /// Where temporary files go. Normally the session scratch.
    pub temp: &'a Path,
    /// `PATH` for the sandboxed process. Passed explicitly rather than
    /// inherited so a host `PATH` entry under the user's profile -- which the
    /// sandbox cannot read anyway -- does not become a mysterious lookup
    /// failure inside it.
    pub path: Option<OsString>,
    /// Extra names the caller wants carried through, on top of
    /// [`SYSTEM_PASSTHROUGH`]. Used for the shell's own requirements.
    pub extra: &'a [(&'a str, OsString)],
}

/// Read one host variable. Split out so tests can drive the builder from a
/// fixture instead of the real process environment.
pub trait HostEnv {
    fn var(&self, name: &str) -> Option<OsString>;
}

/// The real process environment.
pub struct ProcessEnv;

impl HostEnv for ProcessEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
}

impl HostEnv for BTreeMap<String, String> {
    fn var(&self, name: &str) -> Option<OsString> {
        let folded = fold(name);
        self.iter()
            .find(|(k, _)| fold(k) == folded)
            .map(|(_, v)| OsString::from(v))
    }
}

/// Build the environment a sandboxed Windows process is started with.
///
/// The order is deliberate and each layer overrides the one before it:
///
/// 1. the system locations from [`SYSTEM_PASSTHROUGH`], so the process can find
///    its own DLLs, `cmd.exe` and the extension list;
/// 2. `LOCALAPPDATA` from the host, because `CreateProcessW` resolves the
///    AppContainer's storage through it and fails the call without it;
/// 3. the caller's `PATH`;
/// 4. the synthetic home, over any host value the earlier layers brought in;
/// 5. the scratch as every spelling of temp;
/// 6. the caller's extras.
///
/// Nothing else from the host reaches the child. In particular no `*_API_KEY`,
/// no `SSH_AUTH_SOCK`, no `JAN_*`.
pub fn build<H: HostEnv>(host: &H, spec: &SandboxEnvSpec<'_>) -> Result<SandboxEnv, EnvError> {
    let mut env = SandboxEnv::new();

    for name in SYSTEM_PASSTHROUGH {
        if let Some(value) = host.var(name) {
            env.set(name, value);
        }
    }

    // `windir` and `SystemRoot` are the same directory under two names, and
    // plenty of tooling reads only one of them. Fill in whichever is missing
    // rather than leaving a process to fail on the spelling it happened to use.
    match (host.var("SystemRoot"), host.var("windir")) {
        (Some(root), None) => env.set("windir", root),
        (None, Some(dir)) => env.set("SystemRoot", dir),
        _ => {}
    }
    // Not a convenience: see REQUIRED. Without this the spawn fails with 203.
    if let Some(value) = host.var("LOCALAPPDATA") {
        env.set("LOCALAPPDATA", value);
    }

    if let Some(path) = &spec.path {
        env.set("PATH", path.clone());
    }

    // The synthetic profile, last so it wins over anything the passthrough
    // brought in. `HOMEDRIVE`/`HOMEPATH` are set together because a shell that
    // reconstructs a home from the pair must land in the same place as one that
    // reads `HOME`.
    for name in HOME_KEYS {
        env.set(name, spec.home.as_os_str().to_os_string());
    }
    let home = spec.home.to_string_lossy();
    if let Some((drive, rest)) = home.split_once(':') {
        env.set("HOMEDRIVE", format!("{drive}:"));
        env.set("HOMEPATH", rest.to_string());
    }

    for name in TEMP_KEYS {
        env.set(name, spec.temp.as_os_str().to_os_string());
    }

    for (name, value) in spec.extra {
        env.set(name, value.clone());
    }

    for name in REQUIRED {
        if !env.contains(name) {
            return Err(EnvError::MissingRequired { name });
        }
    }

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn host() -> BTreeMap<String, String> {
        [
            ("SystemRoot", r"C:\Windows"),
            ("SystemDrive", "C:"),
            ("windir", r"C:\Windows"),
            ("ComSpec", r"C:\Windows\system32\cmd.exe"),
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
            ("OS", "Windows_NT"),
            ("PROCESSOR_ARCHITECTURE", "AMD64"),
            ("NUMBER_OF_PROCESSORS", "16"),
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("ProgramData", r"C:\ProgramData"),
            ("LOCALAPPDATA", r"C:\Users\me\AppData\Local"),
            ("APPDATA", r"C:\Users\me\AppData\Roaming"),
            ("USERPROFILE", r"C:\Users\me"),
            ("OPENAI_API_KEY", "sk-do-not-leak"),
            ("SSH_AUTH_SOCK", r"\\.\pipe\ssh"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn spec_paths() -> (PathBuf, PathBuf) {
        (
            PathBuf::from(r"C:\Temp\jan-s1\home"),
            PathBuf::from(r"C:\Temp\jan-s1\tmp"),
        )
    }

    fn built(host: &BTreeMap<String, String>) -> SandboxEnv {
        let (home, temp) = spec_paths();
        build(
            host,
            &SandboxEnvSpec {
                home: &home,
                temp: &temp,
                path: Some(OsString::from(
                    r"C:\Windows\system32;C:\Program Files\Git\cmd",
                )),
                extra: &[],
            },
        )
        .expect("built")
    }

    fn decode(block: &[u16]) -> Vec<String> {
        // Split on NUL and drop the terminator, so a test reads the block the
        // way Windows does rather than the way it was written.
        let mut out = Vec::new();
        let mut current = Vec::new();
        for unit in block {
            if *unit == 0 {
                if current.is_empty() {
                    break;
                }
                out.push(String::from_utf16_lossy(&current));
                current.clear();
            } else {
                current.push(*unit);
            }
        }
        out
    }

    #[test]
    fn the_required_windows_variables_are_present() {
        let env = built(&host());
        for name in ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT"] {
            assert!(env.contains(name), "missing {name}");
        }
        for name in [
            "OS",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
        ] {
            assert!(env.contains(name), "missing {name}");
        }
    }

    /// The whole reason this module exists. `CreateProcessW` resolves the
    /// AppContainer's own storage out of this name, and returns
    /// `ERROR_ENVVAR_NOT_FOUND` for a block without it.
    #[test]
    fn localappdata_is_carried_because_appcontainer_creation_needs_it() {
        let env = built(&host());
        assert_eq!(
            env.get("LOCALAPPDATA"),
            Some(OsStr::new(r"C:\Users\me\AppData\Local"))
        );
    }

    #[test]
    fn a_host_without_localappdata_is_a_named_failure_not_a_bad_block() {
        let mut h = host();
        h.remove("LOCALAPPDATA");
        let (home, temp) = spec_paths();
        let err = build(
            &h,
            &SandboxEnvSpec {
                home: &home,
                temp: &temp,
                path: None,
                extra: &[],
            },
        )
        .unwrap_err();
        assert_eq!(
            err,
            EnvError::MissingRequired {
                name: "LOCALAPPDATA"
            }
        );
    }

    #[test]
    fn a_host_without_systemroot_is_a_named_failure() {
        let mut h = host();
        h.remove("SystemRoot");
        h.remove("windir");
        let (home, temp) = spec_paths();
        let err = build(
            &h,
            &SandboxEnvSpec {
                home: &home,
                temp: &temp,
                path: None,
                extra: &[],
            },
        )
        .unwrap_err();
        assert_eq!(err, EnvError::MissingRequired { name: "SystemRoot" });
    }

    #[test]
    fn a_host_without_comspec_still_builds() {
        // ComSpec is worth having and not worth refusing over: a bash command
        // does not need it, and the caller can still report its absence.
        let mut h = host();
        h.remove("ComSpec");
        let env = built(&h);
        assert!(!env.contains("ComSpec"));
        assert!(env.contains("SystemRoot"));
    }

    #[test]
    fn variable_names_collide_case_insensitively() {
        let mut env = SandboxEnv::new();
        env.set("Path", r"C:\one");
        env.set("PATH", r"C:\two");
        env.set("path", r"C:\three");
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("PaTh"), Some(OsStr::new(r"C:\three")));
        let block = decode(&env.encode().expect("encoded"));
        assert_eq!(block, vec![r"path=C:\three".to_string()]);
    }

    #[test]
    fn an_empty_value_is_a_real_entry_not_a_dropped_one() {
        let mut env = SandboxEnv::new();
        env.set("EMPTY", "");
        env.set("AFTER", "x");
        let block = decode(&env.encode().expect("encoded"));
        assert_eq!(block, vec!["AFTER=x".to_string(), "EMPTY=".to_string()]);
    }

    #[test]
    fn an_empty_environment_still_terminates_the_block() {
        // A null pointer means "inherit the parent's environment", so an empty
        // environment must be a real block of exactly one terminator.
        let env = SandboxEnv::new();
        assert_eq!(env.encode().expect("encoded"), vec![0u16]);
    }

    #[test]
    fn the_block_ends_with_a_double_nul() {
        let env = built(&host());
        let block = env.encode().expect("encoded");
        assert_eq!(&block[block.len() - 2..], &[0u16, 0u16]);
    }

    #[test]
    fn a_nul_in_a_value_is_refused_rather_than_truncating_the_block() {
        let mut env = SandboxEnv::new();
        env.set("BAD", "one\0two");
        assert_eq!(
            env.encode().unwrap_err(),
            EnvError::EmbeddedNul {
                name: "BAD".to_string()
            }
        );
    }

    #[test]
    fn a_nul_or_equals_in_a_name_is_refused() {
        let mut env = SandboxEnv::new();
        env.set("A=B", "x");
        assert_eq!(
            env.encode().unwrap_err(),
            EnvError::InvalidName {
                name: "A=B".to_string()
            }
        );

        let mut env = SandboxEnv::new();
        env.set("", "x");
        assert_eq!(
            env.encode().unwrap_err(),
            EnvError::InvalidName {
                name: String::new()
            }
        );
    }

    #[test]
    fn non_ascii_values_survive_as_utf16() {
        let mut env = SandboxEnv::new();
        env.set("GREETING", "naïve — 日本語");
        let block = decode(&env.encode().expect("encoded"));
        assert_eq!(block, vec!["GREETING=naïve — 日本語".to_string()]);
    }

    /// Windows keeps the working directory of each drive in the environment as
    /// `=C:`. They are legal, they must sort first, and rewriting one changes
    /// how the child resolves `D:foo`.
    #[test]
    fn drive_current_directory_entries_are_preserved_and_sort_first() {
        let mut env = SandboxEnv::new();
        env.set("ALPHA", "1");
        env.set("=C:", r"C:\work");
        env.set("=D:", r"D:\data");
        let block = decode(&env.encode().expect("encoded"));
        assert_eq!(
            block,
            vec![
                r"=C:=C:\work".to_string(),
                r"=D:=D:\data".to_string(),
                "ALPHA=1".to_string(),
            ]
        );
        assert!(is_drive_entry("=C:"));
        assert!(!is_drive_entry("=CD:"));
        assert!(!is_drive_entry("PATH"));
    }

    #[test]
    fn entries_are_sorted_case_insensitively() {
        let mut env = SandboxEnv::new();
        for name in ["zeta", "Alpha", "beta", "GAMMA"] {
            env.set(name, "x");
        }
        let block = decode(&env.encode().expect("encoded"));
        let names: Vec<&str> = block.iter().map(|e| e.split('=').next().unwrap()).collect();
        assert_eq!(names, vec!["Alpha", "beta", "GAMMA", "zeta"]);
    }

    #[test]
    fn the_home_is_the_synthetic_one_not_the_users() {
        let (home, _) = spec_paths();
        let env = built(&host());
        for name in HOME_KEYS {
            assert_eq!(
                env.get(name),
                Some(home.as_os_str()),
                "{name} should point at the sandbox home"
            );
        }
        assert_eq!(env.get("HOMEDRIVE"), Some(OsStr::new("C:")));
        assert_eq!(env.get("HOMEPATH"), Some(OsStr::new(r"\Temp\jan-s1\home")));
    }

    /// `LOCALAPPDATA` is the one profile path that has to be real, because
    /// Windows resolves the container's own storage through it. Every other
    /// profile-shaped name points at the sandbox instead.
    #[test]
    fn the_real_user_profile_is_not_handed_to_the_sandbox() {
        let (home, _) = spec_paths();
        let env = built(&host());
        assert_eq!(env.get("USERPROFILE"), Some(home.as_os_str()));
        assert_eq!(env.get("APPDATA"), Some(home.as_os_str()));
        assert_eq!(env.get("HOME"), Some(home.as_os_str()));
        let block = decode(&env.encode().expect("encoded")).join("\n");
        assert!(
            !block.contains(r"C:\Users\me\AppData\Roaming"),
            "the real roaming profile leaked into the block: {block}"
        );
    }

    #[test]
    fn temp_points_at_the_scratch_under_every_spelling() {
        let (_, temp) = spec_paths();
        let env = built(&host());
        for name in TEMP_KEYS {
            assert_eq!(env.get(name), Some(temp.as_os_str()), "{name}");
        }
    }

    #[test]
    fn host_secrets_are_not_carried_into_the_sandbox() {
        let env = built(&host());
        assert!(!env.contains("OPENAI_API_KEY"));
        assert!(!env.contains("SSH_AUTH_SOCK"));
        let block = decode(&env.encode().expect("encoded")).join("\n");
        assert!(!block.contains("sk-do-not-leak"));
    }

    #[test]
    fn diagnostics_report_names_and_lengths_never_values() {
        let mut env = built(&host());
        env.set("MY_API_KEY", "sk-live-abcdef");
        env.set("PLAIN", "hello");
        let lines = env.redacted().join("\n");
        assert!(!lines.contains("sk-live-abcdef"), "{lines}");
        assert!(lines.contains("MY_API_KEY=<redacted>"), "{lines}");
        assert!(lines.contains("PLAIN=<len 5>"), "{lines}");
        assert!(
            !lines.contains(r"C:\Windows"),
            "paths are values too: {lines}"
        );
        assert!(env.names().contains(&"PATH".to_string()));
    }

    #[test]
    fn looks_secret_catches_the_provider_prefixed_names() {
        for name in [
            "OPENAI_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "GH_TOKEN",
            "DB_PASSWORD",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(looks_secret(name), "{name}");
        }
        for name in ["PATH", "SystemRoot", "HOME", "TEMP"] {
            assert!(!looks_secret(name), "{name}");
        }
    }

    #[test]
    fn extras_win_over_the_passthrough() {
        let (home, temp) = spec_paths();
        let env = build(
            &host(),
            &SandboxEnvSpec {
                home: &home,
                temp: &temp,
                path: None,
                extra: &[("PATHEXT", OsString::from(".EXE"))],
            },
        )
        .expect("built");
        assert_eq!(env.get("PATHEXT"), Some(OsStr::new(".EXE")));
    }
}
