//! Backward-compatible environment lookups for the Flint rebrand.
//!
//! Every knob that used to be read as `JAN_<SUFFIX>` is now read as
//! `FLINT_<SUFFIX>` first, falling back to the legacy `JAN_<SUFFIX>` when the
//! new name is unset. When both are set the new `FLINT_` name wins, so a user
//! who has already switched is never overridden by a stale `JAN_` value left in
//! their environment.
//!
//! Call sites pass only the suffix (`"DATA_FOLDER"`, `"API_KEY"`, ...); the
//! `FLINT_`/`JAN_` prefixes live here so the precedence rule is defined once.

/// `FLINT_<suffix>`, falling back to `JAN_<suffix>` when the new name is unset.
///
/// Mirrors [`std::env::var`]: a set-but-non-UTF-8 `FLINT_` value returns the
/// `NotUnicode` error rather than falling through to the legacy name, because a
/// present-but-unreadable value is a misconfiguration to surface, not a miss.
#[allow(dead_code)]
pub fn var(suffix: &str) -> Result<String, std::env::VarError> {
    match std::env::var(format!("FLINT_{suffix}")) {
        Ok(v) => Ok(v),
        Err(std::env::VarError::NotPresent) => std::env::var(format!("JAN_{suffix}")),
        Err(e) => Err(e),
    }
}

/// `FLINT_<suffix>`, falling back to `JAN_<suffix>` when the new name is unset.
///
/// Mirrors [`std::env::var_os`]: any present `FLINT_` value (UTF-8 or not) wins;
/// only an absent one falls through to the legacy name.
#[allow(dead_code)]
pub fn var_os(suffix: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(format!("FLINT_{suffix}"))
        .or_else(|| std::env::var_os(format!("JAN_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env is process-global; serialize the cases that touch the same names so
    /// parallel test threads cannot race one another's set/remove.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn clear(suffix: &str) {
        std::env::remove_var(format!("FLINT_{suffix}"));
        std::env::remove_var(format!("JAN_{suffix}"));
    }

    #[test]
    fn flint_set_jan_unset_uses_flint() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let s = "COMPAT_TEST_A";
        clear(s);
        std::env::set_var(format!("FLINT_{s}"), "flint");
        assert_eq!(var(s).as_deref(), Ok("flint"));
        assert_eq!(var_os(s).as_deref(), Some(std::ffi::OsStr::new("flint")));
        clear(s);
    }

    #[test]
    fn flint_unset_jan_set_falls_back_to_jan() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let s = "COMPAT_TEST_B";
        clear(s);
        std::env::set_var(format!("JAN_{s}"), "jan");
        assert_eq!(var(s).as_deref(), Ok("jan"));
        assert_eq!(var_os(s).as_deref(), Some(std::ffi::OsStr::new("jan")));
        clear(s);
    }

    #[test]
    fn both_set_flint_wins() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let s = "COMPAT_TEST_C";
        clear(s);
        std::env::set_var(format!("FLINT_{s}"), "flint");
        std::env::set_var(format!("JAN_{s}"), "jan");
        assert_eq!(var(s).as_deref(), Ok("flint"));
        assert_eq!(var_os(s).as_deref(), Some(std::ffi::OsStr::new("flint")));
        clear(s);
    }

    #[test]
    fn neither_set_reports_missing() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let s = "COMPAT_TEST_D";
        clear(s);
        assert_eq!(var(s), Err(std::env::VarError::NotPresent));
        assert_eq!(var_os(s), None);
    }
}
