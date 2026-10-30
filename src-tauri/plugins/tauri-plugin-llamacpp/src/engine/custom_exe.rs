//! Gate on the custom llama-server path.
//!
//! `start_engine` takes the path from the webview, so anything that reaches
//! `invoke` could otherwise name any program and have it spawned. A custom
//! path only runs after the user confirmed that exact file in a native dialog
//! the app provides (not the webview). The approval lasts for this run and is
//! tied to the file's size and modification time, so a replaced binary asks
//! again. With no confirmation hook (CLI, tests, phones) a custom path is
//! refused.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

/// Asks the user, natively, whether to run this program. `true` = run it.
pub type ConfirmFn =
    Arc<dyn Fn(PathBuf) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// On Linux the native dialog needs an XDG portal, zenity or kdialog; without
/// one it cannot be shown and reads as a refusal, so say how to fix that.
const NO_DIALOG_HINT: &str = if cfg!(target_os = "linux") {
    ". If no confirmation dialog appeared, install zenity or kdialog so Flint \
     can ask you to approve this custom llama-server path, then try again"
} else {
    ""
};

type Fingerprint =(PathBuf, u64, Option<SystemTime>);

/// `path` for people to read, without the `\\?\` verbatim prefix that
/// `canonicalize` adds on Windows. Display only: spawn the canonical path.
pub fn display_path(path: &Path) -> String {
    let s = path.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

#[derive(Default)]
pub struct CustomExeGate {
    confirm: OnceLock<ConfirmFn>,
    approved: Mutex<HashSet<Fingerprint>>,
}

impl CustomExeGate {
    /// Installed once by the app at startup.
    pub fn set_confirm(&self, f: ConfirmFn) {
        let _ = self.confirm.set(f);
    }

    /// The canonical path to spawn, once the user has approved it.
    pub async fn authorize(&self, exe: &Path) -> Result<PathBuf, String> {
        if !exe.is_file() {
            return Err(format!(
                "The custom llama-server path {} is not a file",
                exe.display()
            ));
        }
        let canon = std::fs::canonicalize(exe).map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
        let fp: Fingerprint = (canon.clone(), meta.len(), meta.modified().ok());
        if self.approved.lock().unwrap_or_else(|e| e.into_inner()).contains(&fp) {
            return Ok(canon);
        }
        let Some(confirm) = self.confirm.get().cloned() else {
            return Err(
                "A custom llama-server can only be started after confirming it in the desktop app"
                    .to_string(),
            );
        };
        if !confirm(canon.clone()).await {
            return Err(format!(
                "Running the custom llama-server {} was not allowed{}",
                display_path(&canon),
                NO_DIALOG_HINT
            ));
        }
        self.approved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(fp);
        Ok(canon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn exe() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("llama-server.exe");
        std::fs::write(&p, b"x").unwrap();
        (d, p)
    }

    #[tokio::test]
    async fn without_a_confirmation_hook_a_custom_path_is_refused() {
        let (_d, p) = exe();
        assert!(CustomExeGate::default().authorize(&p).await.is_err());
    }

    #[tokio::test]
    async fn a_declined_path_is_refused_and_an_approved_one_is_remembered() {
        let (_d, p) = exe();
        let gate = CustomExeGate::default();
        let asked = Arc::new(AtomicUsize::new(0));
        let a = asked.clone();
        gate.set_confirm(Arc::new(move |_| {
            let n = a.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { n > 0 })
        }));
        assert!(gate.authorize(&p).await.is_err());
        assert!(gate.authorize(&p).await.is_ok());
        assert!(gate.authorize(&p).await.is_ok());
        assert_eq!(asked.load(Ordering::SeqCst), 2, "approval remembered");
        // A replaced binary asks again.
        std::fs::write(&p, b"different").unwrap();
        assert!(gate.authorize(&p).await.is_ok());
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn display_path_drops_the_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.exe")), r"C:\a\b.exe");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\s\b.exe")), r"\\srv\s\b.exe");
        assert_eq!(display_path(Path::new("/usr/bin/llama-server")), "/usr/bin/llama-server");
    }

    #[tokio::test]
    async fn a_missing_file_is_refused_without_asking() {
        let gate = CustomExeGate::default();
        gate.set_confirm(Arc::new(|_| Box::pin(async { panic!("must not ask") })));
        assert!(gate.authorize(Path::new("Z:/no/such/llama-server")).await.is_err());
    }
}
