use libloading::Library;
use std::io;

// Match libappindicator-sys's loader order, including the unversioned names used
// by bundled AppImages. The handle is kept until tray construction finishes, when
// libappindicator-sys holds its own reference to the library.
const APPINDICATOR_LIBRARIES: &[&str] = &[
    "libayatana-appindicator3.so.1",
    "libappindicator3.so.1",
    "libayatana-appindicator3.so",
    "libappindicator3.so",
];

pub(super) fn load_appindicator() -> io::Result<Library> {
    load_library(APPINDICATOR_LIBRARIES)
}

fn load_library(candidates: &[&str]) -> io::Result<Library> {
    let mut errors = Vec::new();
    for name in candidates {
        // SAFETY: these are the platform libraries the tray backend loads
        // itself. No symbol is called here; loading only runs the library's
        // own initializers.
        match unsafe { Library::new(name) } {
            Ok(library) => return Ok(library),
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "System tray unavailable: could not load an AppIndicator library; continuing without a tray icon. {}",
            errors.join("; ")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MISSING: &str = "flint-test-missing-appindicator-library";

    #[test]
    fn missing_library_returns_an_error_instead_of_panicking() {
        let error = load_library(&[MISSING]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains(MISSING));
        assert!(error.to_string().contains("continuing without a tray icon"));
    }

    #[test]
    fn every_absent_candidate_appears_in_the_diagnostic() {
        let error = load_library(&[MISSING, "flint-second-missing-library"]).unwrap_err();
        assert!(error.to_string().contains(MISSING));
        assert!(error.to_string().contains("flint-second-missing-library"));
    }
}
