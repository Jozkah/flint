//! Filesystem allow/deny lists for the sandboxed shell.
//!
//! `[tools.fs]` in agent.toml names four lists of paths: `allow_read`,
//! `deny_read`, `allow_write` and `deny_write`. This module is the decision
//! logic only -- it turns the configured strings into canonical paths and works
//! out which entries may stand -- and the sandbox backends in [`super::jail`]
//! turn the result into mounts and profile rules.
//!
//! The rules, in the order they matter:
//!
//! - **Deny wins over allow.** Whatever the backend applies for an allow entry,
//!   it applies the denies after it.
//! - **Entries are canonical.** `~` is expanded, the nearest existing ancestor is
//!   resolved through symlinks, and `..` is refused, so a link or a spelling
//!   cannot reach a path a deny names.
//! - **A stricter layer is never undone.** An allow entry inside a path denied by
//!   another list, by the agent's own hidden state, or by the credential
//!   defaults is dropped, with a note saying why.
//! - **Credentials stay closed by default.** Where the shell can otherwise read
//!   `$HOME` (the CLI's `allow_home_read`), `~/.ssh`, `~/.aws`, `~/.gnupg`,
//!   `~/.config/gcloud`, `~/.azure`, `~/.kube` and the browser profile folders
//!   are denied unless `allow_read` names one of them exactly. Nothing makes
//!   them writable: `allow_write` inside one is always dropped.
//! - **The workspace is not negotiable.** A deny that would hide the workspace
//!   or a granted write root is dropped, since the run could not work at all.

use std::path::{Component, Path, PathBuf};

/// The four configured lists, as written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FsConfig {
    pub allow_read: Vec<String>,
    pub deny_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_write: Vec<String>,
}

impl FsConfig {
    pub fn is_empty(&self) -> bool {
        self.allow_read.is_empty()
            && self.deny_read.is_empty()
            && self.allow_write.is_empty()
            && self.deny_write.is_empty()
    }
}

/// What the backends apply: canonical paths, already filtered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FsRules {
    pub deny_read: Vec<PathBuf>,
    pub allow_read: Vec<PathBuf>,
    pub allow_write: Vec<PathBuf>,
    pub deny_write: Vec<PathBuf>,
    /// Why an entry was dropped or ignored, for the user.
    pub notes: Vec<String>,
}

/// Everything [`resolve`] needs besides the configured lists.
pub struct FsInput<'a> {
    pub config: &'a FsConfig,
    pub home: Option<&'a Path>,
    /// Deny the credential folders (the shell can read `$HOME`).
    pub default_credentials: bool,
    /// Paths the run must keep: the workspace and the granted write roots.
    pub must_stay: &'a [PathBuf],
    /// Paths another layer hides entirely (the agent's state, the data folder).
    pub hidden: &'a [PathBuf],
}

/// Credential and browser-profile folders under `home`.
pub fn credential_dirs(home: &Path) -> Vec<PathBuf> {
    const REL: &[&str] = &[
        ".ssh",
        ".aws",
        ".gnupg",
        ".config/gcloud",
        ".azure",
        ".kube",
        ".docker",
        // Windows locations.
        "AppData/Roaming/gcloud",
        "AppData/Roaming/Mozilla/Firefox",
        "AppData/Local/Google/Chrome/User Data",
        "AppData/Local/Microsoft/Edge/User Data",
        "AppData/Local/BraveSoftware/Brave-Browser/User Data",
        "AppData/Local/Vivaldi/User Data",
        "AppData/Local/Chromium/User Data",
        "AppData/Roaming/Opera Software",
        // Browser profiles hold cookies and saved logins.
        ".mozilla",
        ".config/google-chrome",
        ".config/chromium",
        ".config/BraveSoftware",
        ".config/microsoft-edge",
        ".config/vivaldi",
        ".var/app/org.mozilla.firefox",
        "snap/firefox/common/.mozilla",
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Firefox",
        "Library/Application Support/BraveSoftware",
        "Library/Application Support/Microsoft Edge",
        "Library/Safari",
    ];
    REL.iter().map(|r| home.join(r)).collect()
}

fn within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn strictly_within(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

/// The path with symlinks resolved as far as it exists: the longest existing
/// ancestor is canonicalised and the remaining components are appended.
pub fn canonical(path: &Path) -> PathBuf {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cursor) {
            let mut out = real;
            for part in missing.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (cursor.file_name().map(|n| n.to_os_string()), cursor.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name);
                cursor = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// One configured entry as a canonical absolute path, or why it was refused.
pub fn expand(raw: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty entry".to_string());
    }
    if raw.contains('\0') {
        return Err(format!("{raw:?} contains a NUL"));
    }
    let expanded = if raw == "~" {
        home.map(Path::to_path_buf)
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.map(|h| h.join(rest))
    } else {
        Some(PathBuf::from(raw))
    }
    .ok_or_else(|| format!("{raw} needs a home directory and none is set"))?;
    if !expanded.is_absolute() {
        return Err(format!("{raw} is not an absolute path (use ~ or a full path)"));
    }
    // Checked on the text: a verbatim Windows path reports `..` as an ordinary
    // name, so the components of `expanded` cannot be trusted.
    if raw.split(['/', '\\']).any(|part| part == "..")
        || expanded.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("{raw} contains .., which is ambiguous next to symlinks"));
    }
    Ok(canonical(&expanded))
}

fn expand_all(label: &str, raw: &[String], home: Option<&Path>, notes: &mut Vec<String>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in raw {
        match expand(entry, home) {
            Ok(p) => {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
            Err(why) => notes.push(format!("[tools.fs].{label}: ignored {why}")),
        }
    }
    out
}

/// Turn the configured lists into the rules the backends apply.
pub fn resolve(input: &FsInput<'_>) -> FsRules {
    let home = input.home;
    let mut notes = Vec::new();
    let home_real = home.map(canonical);
    let must: Vec<PathBuf> = input.must_stay.iter().map(|p| canonical(p)).collect();
    let hidden: Vec<PathBuf> = input.hidden.iter().map(|p| canonical(p)).collect();

    let user_deny_read = expand_all("deny_read", &input.config.deny_read, home, &mut notes);
    let allow_read_in = expand_all("allow_read", &input.config.allow_read, home, &mut notes);
    let allow_write_in = expand_all("allow_write", &input.config.allow_write, home, &mut notes);
    let deny_write = expand_all("deny_write", &input.config.deny_write, home, &mut notes);

    // The credential folders, minus any that `allow_read` names exactly.
    let creds: Vec<PathBuf> = match (&home_real, input.default_credentials) {
        (Some(h), true) => credential_dirs(h).iter().map(|p| canonical(p)).collect(),
        _ => Vec::new(),
    };
    let standing_creds: Vec<PathBuf> = creds
        .iter()
        .filter(|c| !allow_read_in.contains(*c))
        .cloned()
        .collect();

    let mut deny_read: Vec<PathBuf> = Vec::new();
    for d in user_deny_read.iter().chain(standing_creds.iter()) {
        if must.iter().any(|m| within(m, d)) {
            notes.push(format!(
                "[tools.fs]: not denying reads of {}: it contains the workspace",
                d.display()
            ));
            continue;
        }
        if !deny_read.contains(d) {
            deny_read.push(d.clone());
        }
    }

    // An allow stands unless a user deny covers it. Inside a standing
    // credential folder it is a carve-out, which is the explicit opt-in.
    let mut allow_read: Vec<PathBuf> = Vec::new();
    for a in &allow_read_in {
        if let Some(d) = user_deny_read.iter().find(|d| within(a, d)) {
            notes.push(format!(
                "[tools.fs].allow_read: dropped {}: deny_read covers it ({})",
                a.display(),
                d.display()
            ));
            continue;
        }
        if let Some(h) = hidden.iter().find(|h| within(a, h)) {
            notes.push(format!(
                "[tools.fs].allow_read: dropped {}: hidden by the agent ({})",
                a.display(),
                h.display()
            ));
            continue;
        }
        allow_read.push(a.clone());
    }

    let mut allow_write: Vec<PathBuf> = Vec::new();
    for a in &allow_write_in {
        let too_broad = a.parent().is_none()
            || home_real.as_ref().is_some_and(|h| within(h, a));
        let reason = if too_broad {
            Some("it is the filesystem root or contains the home folder".to_string())
        } else if let Some(d) = deny_write.iter().find(|d| within(a, d)) {
            Some(format!("deny_write covers it ({})", d.display()))
        } else if let Some(d) = deny_read.iter().find(|d| within(a, d)) {
            Some(format!("deny_read covers it ({})", d.display()))
        } else if let Some(c) = creds.iter().find(|c| within(a, c)) {
            Some(format!("credential folders are never writable ({})", c.display()))
        } else {
            hidden
                .iter()
                .find(|h| within(a, h))
                .map(|h| format!("hidden by the agent ({})", h.display()))
        };
        match reason {
            Some(why) => notes.push(format!(
                "[tools.fs].allow_write: dropped {}: {why}",
                a.display()
            )),
            None => allow_write.push(a.clone()),
        }
    }

    FsRules { deny_read, allow_read, allow_write, deny_write, notes }
}

impl FsRules {
    /// Whether `path` is unreadable under these rules: inside a deny entry and
    /// not inside a carve-out that sits strictly inside that same entry.
    pub fn read_denied(&self, path: &Path) -> bool {
        let p = canonical(path);
        self.deny_read.iter().any(|d| {
            within(&p, d)
                && !self
                    .allow_read
                    .iter()
                    .any(|a| strictly_within(a, d) && within(&p, a))
        })
    }

    /// Whether the rules refuse writes to `path`: inside a deny_write or a
    /// deny_read entry. (Whether it is writable at all is the backend's
    /// workspace and allow_write grants.)
    pub fn write_denied(&self, path: &Path) -> bool {
        let p = canonical(path);
        self.deny_write.iter().any(|d| within(&p, d))
            || self.deny_read.iter().any(|d| within(&p, d))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        _dir: tempfile::TempDir,
        home: PathBuf,
        ws: PathBuf,
    }

    fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let ws = home.join("proj");
        for sub in [".ssh", ".aws", ".config/gcloud", ".config/chromium", "proj", "data"] {
            std::fs::create_dir_all(home.join(sub)).unwrap();
        }
        Fx { _dir: dir, home, ws }
    }

    #[test]
    fn fs_policy_default_denies_chrome_user_data() {
        let f = fx();
        for sub in ["AppData/Local/Google/Chrome/User Data", ".docker"] {
            std::fs::create_dir_all(f.home.join(sub)).unwrap();
        }
        let r = rules(&f, FsConfig::default(), true);
        assert!(r.read_denied(&f.home.join("AppData/Local/Google/Chrome/User Data/Default/Login Data")));
        assert!(r.read_denied(&f.home.join(".docker/config.json")));
    }

    fn rules(f: &Fx, cfg: FsConfig, creds: bool) -> FsRules {
        resolve(&FsInput {
            config: &cfg,
            home: Some(&f.home),
            default_credentials: creds,
            must_stay: std::slice::from_ref(&f.ws),
            hidden: &[f.ws.join(".jan")],
        })
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn credential_folders_are_denied_by_default_including_browser_profiles() {
        let f = fx();
        let r = rules(&f, FsConfig::default(), true);
        for dir in [".ssh", ".aws", ".config/gcloud", ".config/chromium"] {
            assert!(r.read_denied(&f.home.join(dir).join("id_rsa")), "{dir}");
        }
        assert!(!r.read_denied(&f.home.join("data/file.txt")));
        assert!(!r.read_denied(&f.ws.join("src/main.rs")));
        // Not applied where the home is already hidden wholesale.
        assert!(rules(&f, FsConfig::default(), false).deny_read.is_empty());
    }

    #[test]
    fn naming_a_credential_folder_in_allow_read_opens_that_one_only() {
        let f = fx();
        let cfg = FsConfig { allow_read: s(&["~/.aws"]), ..Default::default() };
        let r = rules(&f, cfg, true);
        assert!(!r.read_denied(&f.home.join(".aws/credentials")));
        assert!(r.read_denied(&f.home.join(".ssh/id_rsa")));
    }

    #[test]
    fn an_allow_inside_a_credential_folder_is_a_carve_out_not_the_whole_folder() {
        let f = fx();
        std::fs::write(f.home.join(".ssh/config"), "Host x").unwrap();
        let cfg = FsConfig { allow_read: s(&["~/.ssh/config"]), ..Default::default() };
        let r = rules(&f, cfg, true);
        assert!(!r.read_denied(&f.home.join(".ssh/config")));
        assert!(r.read_denied(&f.home.join(".ssh/id_rsa")));
    }

    #[test]
    fn deny_wins_over_allow() {
        let f = fx();
        let cfg = FsConfig {
            allow_read: s(&["~/data/secret", "~/data"]),
            deny_read: s(&["~/data/secret"]),
            ..Default::default()
        };
        let r = rules(&f, cfg, false);
        assert!(r.read_denied(&f.home.join("data/secret/key")));
        assert!(!r.allow_read.contains(&f.home.join("data/secret")));
        assert!(r.notes.iter().any(|n| n.contains("deny_read covers it")), "{:?}", r.notes);
        // The ancestor allow stands, and the deny still carves the secret out.
        assert!(r.allow_read.contains(&f.home.join("data")));
        assert!(!r.read_denied(&f.home.join("data/other")));
    }

    #[test]
    fn allow_write_is_dropped_under_any_stricter_layer() {
        let f = fx();
        let cfg = FsConfig {
            allow_write: s(&[
                "~/data/out",         // fine
                "~/.ssh",             // credential folder: never writable
                "~/.ssh/authorized_keys",
                "~/data/locked/x",    // under deny_write
                "~/proj/.jan/state",  // hidden by the agent
                "~",                  // contains the home folder
            ]),
            deny_write: s(&["~/data/locked"]),
            deny_read: s(&["~/data/hidden"]),
            ..Default::default()
        };
        let mut cfg = cfg;
        cfg.allow_write.push("~/data/hidden/w".to_string());
        // The filesystem root, spelled the way this platform spells it.
        cfg.allow_write
            .push(f.home.ancestors().last().unwrap().to_string_lossy().to_string());
        let r = rules(&f, cfg, true);
        assert_eq!(r.allow_write, vec![f.home.join("data/out")], "{:?}", r.notes);
        assert_eq!(r.notes.iter().filter(|n| n.contains("allow_write: dropped")).count(), 7);
    }

    #[test]
    fn a_deny_that_would_hide_the_workspace_is_dropped() {
        let f = fx();
        let cfg = FsConfig { deny_read: s(&["~", "~/proj", "~/data"]), ..Default::default() };
        let r = rules(&f, cfg, false);
        assert_eq!(r.deny_read, vec![f.home.join("data")]);
        assert!(r.notes.iter().any(|n| n.contains("contains the workspace")));
    }

    #[test]
    fn entries_are_canonical_so_a_symlink_cannot_dodge_a_deny() {
        let f = fx();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(f.home.join(".ssh"), f.home.join("data/shortcut")).unwrap();
            let cfg = FsConfig { deny_read: s(&["~/data/shortcut"]), ..Default::default() };
            let r = rules(&f, cfg, false);
            assert_eq!(r.deny_read, vec![f.home.join(".ssh")]);
        }
        // Not-yet-existing paths resolve through their existing ancestor.
        let r = rules(&f, FsConfig { deny_read: s(&["~/data/new/dir"]), ..Default::default() }, false);
        assert_eq!(r.deny_read, vec![f.home.join("data/new/dir")]);
    }

    #[test]
    fn bad_entries_are_ignored_with_a_note() {
        let f = fx();
        let cfg = FsConfig {
            deny_read: s(&["", "relative/path", "~/a/../b", "~/ok"]),
            ..Default::default()
        };
        let r = rules(&f, cfg, false);
        assert_eq!(r.deny_read, vec![f.home.join("ok")]);
        assert_eq!(r.notes.len(), 3, "{:?}", r.notes);
    }

    #[test]
    fn deny_read_implies_no_write_and_deny_write_blocks_only_writes() {
        let f = fx();
        let cfg = FsConfig {
            deny_read: s(&["~/data/private"]),
            deny_write: s(&["~/proj/dist"]),
            ..Default::default()
        };
        let r = rules(&f, cfg, false);
        assert!(r.write_denied(&f.home.join("data/private/x")));
        assert!(r.write_denied(&f.ws.join("dist/out.js")));
        assert!(!r.read_denied(&f.ws.join("dist/out.js")));
        assert!(!r.write_denied(&f.ws.join("src/lib.rs")));
    }
}
