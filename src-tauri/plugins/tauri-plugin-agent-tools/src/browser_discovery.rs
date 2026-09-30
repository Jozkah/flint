//! Which Chromium-based browser Flint drives, decided in one place.
//!
//! Both "Verify in browser" (`core::browser_verify`, in the app crate) and the
//! agent `screenshot` tool (`tools::handlers::chrome_binary`, here) need an
//! installed browser. The app crate depends on this crate and not the other
//! way round, so the discovery list and the user's chosen executable live here
//! and both consumers call it: choosing a browser in the app changes what the
//! screenshot tool launches, and a browser added to the list is found by both.
//!
//! No browser is ever downloaded, and `PATH` is never searched: on Windows
//! only absolute roots from the environment are used, so a planted executable
//! in the working directory is never launched.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Process-local browser selected by the user.
static CHOSEN_BROWSER: Mutex<Option<String>> = Mutex::new(None);

/// Serialises tests that read or write [`CHOSEN_BROWSER`] or the browser
/// environment variables, which are process-wide.
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

/// The executable the user chose this process, if any.
pub fn chosen_browser() -> Option<String> {
    CHOSEN_BROWSER.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Put back a previous [`chosen_browser`] value (tests use this to undo a
/// choice; `None` clears it).
#[doc(hidden)]
pub fn restore_chosen_browser(previous: Option<String>) {
    *CHOSEN_BROWSER.lock().unwrap_or_else(|e| e.into_inner()) = previous;
}

/// Program names that are browsers but not Chromium-based, so they cannot be
/// driven over the DevTools protocol.
const NOT_CHROMIUM: &[&str] = &[
    "firefox", "waterfox", "librewolf", "floorp", "zen", "tor", "torbrowser", "palemoon",
    "seamonkey", "safari", "iexplore", "msedge_ie", "lynx", "links", "w3m",
];

/// Whether `path` is clearly a browser that is not Chromium-based (matched on
/// the executable's own name, so a folder called `firefox` proves nothing).
pub fn is_clearly_not_chromium(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    NOT_CHROMIUM.contains(&stem)
}

/// Make `path` the browser for this process. Absolute, an existing file, and
/// not obviously a non-Chromium browser.
pub fn set_chosen_browser(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("the browser path must be absolute".to_string());
    }
    if !p.is_file() {
        return Err(format!("no file at {path}"));
    }
    if is_clearly_not_chromium(&p) {
        return Err(format!(
            "{path} is not a Chromium-based browser; choose Chrome, Edge, Brave, Opera, Vivaldi, Arc or Chromium"
        ));
    }
    restore_chosen_browser(Some(path.to_string()));
    Ok(p)
}

/// A display name for the browser at `path`. Matched on the executable's name
/// and on whole folder names, never on substrings of the full path: `Marcus`
/// is not Arc and `Edgar` is not Edge. Splits on both separators so a Windows
/// path is read the same way on every host.
pub fn browser_name(path: &Path) -> String {
    let raw = path.to_string_lossy().to_ascii_lowercase();
    let parts: Vec<&str> = raw.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let file = parts.last().copied().unwrap_or("");
    let stem = file.strip_suffix(".exe").unwrap_or(file);
    let dirs: Vec<&str> = parts
        .iter()
        .take(parts.len().saturating_sub(1))
        .map(|d| d.strip_suffix(".app").unwrap_or(d))
        .collect();
    let dir = |names: &[&str]| dirs.iter().any(|d| names.contains(d));
    let stem_is = |prefixes: &[&str]| {
        prefixes.iter().any(|p| {
            stem == *p || stem.strip_prefix(p).is_some_and(|r| r.starts_with(['-', '_', ' ']))
        })
    };

    if stem_is(&["msedge", "microsoft-edge", "microsoft edge"]) || dir(&["edge", "microsoft edge"]) {
        "Microsoft Edge".into()
    } else if stem_is(&["brave", "brave-browser", "brave browser"])
        || dir(&["brave-browser", "brave browser", "bravesoftware"])
    {
        "Brave".into()
    } else if stem_is(&["opera"]) || dir(&["opera", "opera gx", "opera stable"]) {
        "Opera".into()
    } else if stem_is(&["vivaldi"]) || dir(&["vivaldi"]) {
        "Vivaldi".into()
    } else if stem == "arc" || dir(&["arc"]) {
        "Arc".into()
    } else if stem_is(&["chromium", "chromium-browser"]) || dir(&["chromium"]) {
        "Chromium".into()
    } else {
        "Google Chrome".into()
    }
}

/// The install locations under the three Windows roots. For Opera, the real
/// `opera.exe` comes before `launcher.exe`: the launcher is a stub that starts
/// `opera.exe` and exits, so a process handle on it does not control the
/// browser it opened (killing the launcher would leave the browser running).
pub fn windows_candidates(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [program_files, program_files_x86].into_iter().flatten().filter(|p| p.is_absolute()) {
        out.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        out.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        out.push(root.join("BraveSoftware").join("Brave-Browser").join("Application").join("brave.exe"));
        out.push(root.join("Vivaldi").join("Application").join("vivaldi.exe"));
        out.push(root.join("Opera").join("opera.exe"));
        out.push(root.join("Opera").join("launcher.exe"));
        out.push(root.join("Arc").join("Arc.exe"));
    }
    if let Some(root) = local_app_data.filter(|p| p.is_absolute()) {
        out.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        out.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        out.push(root.join("BraveSoftware").join("Brave-Browser").join("Application").join("brave.exe"));
        out.push(root.join("Vivaldi").join("Application").join("vivaldi.exe"));
        for opera in ["Opera", "Opera GX"] {
            let dir = root.join("Programs").join(opera);
            out.push(dir.join("opera.exe"));
            out.push(dir.join("launcher.exe"));
        }
        out.push(root.join("Programs").join("Arc").join("Arc.exe"));
        // Arc's MSIX/App Installer builds expose an app-execution alias here.
        out.push(root.join("Microsoft").join("WindowsApps").join("Arc.exe"));
    }
    out
}

/// Numbered subfolders of `dir` (`app-3`, `117.0.1`), newest first, that hold
/// `exe`. Vivaldi's older installers and Opera keep the real binary in one.
fn versioned_binaries(dir: &Path, prefix: &str, exe: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u64>, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name.strip_prefix(prefix)?;
            let nums: Vec<u64> = version.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
            let path = entry.path().join(exe);
            path.is_file().then_some((nums, path))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Windows locations that need a folder listing: Vivaldi's legacy `app-N`
/// layout and Opera's versioned `opera.exe`.
fn windows_versioned_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        out.extend(versioned_binaries(&root.join("Vivaldi"), "app-", "vivaldi.exe"));
        for opera in [root.join("Opera"), root.join("Programs").join("Opera"), root.join("Programs").join("Opera GX")] {
            out.extend(versioned_binaries(&opera, "", "opera.exe"));
        }
    }
    out
}

/// If `path` is Opera's `launcher.exe`, the real `opera.exe` next to it or in
/// its newest versioned folder; otherwise `path` unchanged. See
/// [`windows_candidates`] for why the launcher is not launched.
fn prefer_real_opera(path: PathBuf) -> PathBuf {
    let is_launcher = path
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("launcher.exe"));
    let Some(dir) = path.parent().filter(|_| is_launcher) else {
        return path;
    };
    if browser_name(&path) != "Opera" {
        return path;
    }
    let sibling = dir.join("opera.exe");
    if sibling.is_file() {
        return sibling;
    }
    versioned_binaries(dir, "", "opera.exe")
        .into_iter()
        .next()
        .unwrap_or(path)
}

/// Default install locations, in preference order.
pub fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Opera.app/Contents/MacOS/Opera",
        "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
        "/Applications/Arc.app/Contents/MacOS/Arc",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/opt/microsoft/msedge/msedge",
        "/usr/bin/brave-browser",
        "/usr/bin/brave-browser-stable",
        "/usr/bin/opera",
        "/usr/bin/opera-stable",
        "/usr/bin/vivaldi",
        "/usr/bin/arc",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
    let (pf, pf86, local) = (var("ProgramFiles"), var("ProgramFiles(x86)"), var("LOCALAPPDATA"));
    out.extend(windows_candidates(pf.as_deref(), pf86.as_deref(), local.as_deref()));
    let roots: Vec<PathBuf> = [pf, pf86, local].into_iter().flatten().collect();
    out.extend(windows_versioned_candidates(&roots));
    out
}

/// The browser executable to launch, or `None`. Order: `override_path`
/// (when absolute and existing), then `FLINT_BROWSER_PATH` / `CHROME_PATH`,
/// then the default install locations.
pub fn find_browser_path_with_override(override_path: Option<&str>) -> Option<PathBuf> {
    let explicit = override_path
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .or_else(|| {
            ["FLINT_BROWSER_PATH", "CHROME_PATH"]
                .iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .find(|p| p.is_absolute() && p.is_file())
        });
    explicit
        .or_else(|| candidates().into_iter().find(|p| p.is_file()))
        .map(prefer_real_opera)
}

/// The browser every Flint consumer launches: the user's choice if any, else
/// [`find_browser_path_with_override`] with no override.
pub fn find_browser_path() -> Option<PathBuf> {
    find_browser_path_with_override(chosen_browser().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(prefix: &str) -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("{prefix}{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn browser_name_recognises_the_alternative_browsers() {
        for (path, name) in [
            ("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "Brave"),
            ("/usr/bin/brave-browser", "Brave"),
            (r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe", "Brave"),
            ("/Applications/Opera.app/Contents/MacOS/Opera", "Opera"),
            (r"C:\Users\u\AppData\Local\Programs\Opera\launcher.exe", "Opera"),
            (r"C:\Users\u\AppData\Local\Programs\Opera GX\opera.exe", "Opera"),
            ("/usr/bin/vivaldi", "Vivaldi"),
            (r"C:\Users\u\AppData\Local\Vivaldi\Application\vivaldi.exe", "Vivaldi"),
            ("/Applications/Arc.app/Contents/MacOS/Arc", "Arc"),
            (r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\Arc.exe", "Arc"),
            ("/usr/bin/arc", "Arc"),
            ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome"),
            (r"C:\Program Files\Microsoft\Edge\Application\msedge.exe", "Microsoft Edge"),
            ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Microsoft Edge"),
            ("/usr/bin/chromium", "Chromium"),
        ] {
            assert_eq!(browser_name(Path::new(path)), name, "{path}");
        }
    }

    /// Substrings of a user or folder name must not pick the browser.
    #[test]
    fn browser_name_matches_the_executable_not_substrings_of_the_path() {
        for path in [
            r"C:\Users\Marcus\AppData\Local\Google\Chrome\Application\chrome.exe",
            r"C:\Users\Edgar\AppData\Local\Google\Chrome\Application\chrome.exe",
            "/home/operator/bravery/chrome",
            "/opt/arcade/vivaldish/chrome",
            "/home/Marcus/browser",
        ] {
            assert_eq!(browser_name(Path::new(path)), "Google Chrome", "{path}");
        }
    }

    #[test]
    fn windows_candidates_cover_real_install_layouts() {
        let pf = Path::new(r"C:\Program Files");
        let pf86 = Path::new(r"C:\Program Files (x86)");
        let local = Path::new(r"C:\Users\u\AppData\Local");
        let c = windows_candidates(Some(pf), Some(pf86), Some(local));
        for expected in [
            r"C:\Program Files\Vivaldi\Application\vivaldi.exe",
            r"C:\Users\u\AppData\Local\Vivaldi\Application\vivaldi.exe",
            r"C:\Users\u\AppData\Local\Programs\Opera\opera.exe",
            r"C:\Users\u\AppData\Local\Programs\Opera\launcher.exe",
            r"C:\Users\u\AppData\Local\Programs\Opera GX\opera.exe",
            r"C:\Users\u\AppData\Local\Programs\Opera GX\launcher.exe",
            r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\Arc.exe",
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Users\u\AppData\Local\Google\Chrome\Application\chrome.exe",
        ] {
            assert!(c.contains(&PathBuf::from(expected)), "{expected}");
        }
        // The real binary is tried before the stub launcher.
        let at = |p: &str| c.iter().position(|x| x == &PathBuf::from(p)).unwrap();
        assert!(
            at(r"C:\Users\u\AppData\Local\Programs\Opera\opera.exe")
                < at(r"C:\Users\u\AppData\Local\Programs\Opera\launcher.exe")
        );
    }

    #[test]
    fn the_candidate_list_covers_the_alternative_browsers() {
        let c = candidates();
        for expected in [
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Opera.app/Contents/MacOS/Opera",
            "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
            "/Applications/Arc.app/Contents/MacOS/Arc",
            "/usr/bin/brave-browser",
            "/usr/bin/opera",
            "/usr/bin/vivaldi",
            "/usr/bin/arc",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/chromium",
        ] {
            assert!(c.contains(&PathBuf::from(expected)), "{expected}");
        }
    }

    #[test]
    fn legacy_vivaldi_app_folders_are_found_newest_first() {
        let tmp = TempDir::new("flint-vivaldi-");
        for v in ["app-2", "app-10", "app-9"] {
            let dir = tmp.path().join("Vivaldi").join(v);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("vivaldi.exe"), b"x").unwrap();
        }
        let found = windows_versioned_candidates(&[tmp.path().to_path_buf()]);
        let names: Vec<_> = found
            .iter()
            .map(|p| p.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["app-10", "app-9", "app-2"]);
    }

    #[test]
    fn opera_prefers_the_real_binary_over_the_launcher_stub() {
        let tmp = TempDir::new("flint-opera-");
        let dir = tmp.path().join("Opera");
        std::fs::create_dir_all(dir.join("117.0.1")).unwrap();
        std::fs::write(dir.join("launcher.exe"), b"x").unwrap();
        // Only the launcher: unchanged.
        assert_eq!(prefer_real_opera(dir.join("launcher.exe")), dir.join("launcher.exe"));
        // A versioned opera.exe wins.
        std::fs::write(dir.join("117.0.1").join("opera.exe"), b"x").unwrap();
        assert_eq!(prefer_real_opera(dir.join("launcher.exe")), dir.join("117.0.1").join("opera.exe"));
        // One beside the launcher wins over both.
        std::fs::write(dir.join("opera.exe"), b"x").unwrap();
        assert_eq!(prefer_real_opera(dir.join("launcher.exe")), dir.join("opera.exe"));
        // A launcher that is not Opera's is left alone.
        let other = tmp.path().join("Tool").join("launcher.exe");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, b"x").unwrap();
        std::fs::write(other.parent().unwrap().join("opera.exe"), b"x").unwrap();
        assert_eq!(prefer_real_opera(other.clone()), other);
    }

    #[test]
    fn a_user_chosen_browser_wins_over_the_default_locations() {
        let tmp = TempDir::new("flint-browser-test-");
        let exe = tmp.path().join("my-browser");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(find_browser_path_with_override(exe.to_str()), Some(exe));
    }

    #[test]
    fn a_missing_or_relative_override_is_ignored() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for bad in ["relative/path", "/nonexistent/browser-xyz"] {
            if let Some(found) = find_browser_path_with_override(Some(bad)) {
                assert_ne!(found, PathBuf::from(bad));
            }
        }
    }

    #[test]
    fn a_clearly_non_chromium_browser_cannot_be_chosen() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = chosen_browser();
        let tmp = TempDir::new("flint-firefox-");
        for name in ["firefox.exe", "Firefox", "safari", "librewolf.exe"] {
            let exe = tmp.path().join(name);
            std::fs::write(&exe, b"x").unwrap();
            let err = set_chosen_browser(exe.to_str().unwrap()).unwrap_err();
            assert!(err.contains("not a Chromium-based browser"), "{err}");
        }
        assert_eq!(chosen_browser(), before, "a refused choice must not be stored");
        // The folder name does not matter, only the executable's.
        let dir = tmp.path().join("firefox-folder");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("brave.exe");
        std::fs::write(&ok, b"x").unwrap();
        assert!(set_chosen_browser(ok.to_str().unwrap()).is_ok());
        restore_chosen_browser(before);
    }
}
