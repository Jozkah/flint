//! The native file picker behind the open/save commands.
//!
//! `rfd` has no iOS or Android backend, so phone builds get a stand-in whose
//! dialogs always report "cancelled". The phone client is a thin client of a
//! desktop and picks files with the system document picker, not through these
//! commands.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use rfd::AsyncFileDialog;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub use stub::AsyncFileDialog;

#[cfg(any(target_os = "android", target_os = "ios"))]
mod stub {
    use std::path::{Path, PathBuf};

    pub struct FileHandle(PathBuf);

    impl FileHandle {
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    #[derive(Default)]
    pub struct AsyncFileDialog;

    impl AsyncFileDialog {
        pub fn new() -> Self {
            Self
        }

        pub fn add_filter(self, _name: impl Into<String>, _extensions: &[impl ToString]) -> Self {
            self
        }

        pub fn set_directory<P: AsRef<Path>>(self, _path: P) -> Self {
            self
        }

        pub fn set_file_name(self, _file_name: impl Into<String>) -> Self {
            self
        }

        pub async fn pick_file(self) -> Option<FileHandle> {
            None
        }

        pub async fn pick_files(self) -> Option<Vec<FileHandle>> {
            None
        }

        pub async fn pick_folder(self) -> Option<FileHandle> {
            None
        }

        pub async fn save_file(self) -> Option<FileHandle> {
            None
        }
    }
}
