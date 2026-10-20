//! Safe mode (`flint --safe-mode`, or `FLINT_SAFE_MODE=1`): the session starts
//! with every customization off, so a misbehaving hook, skill, plugin, MCP
//! server or project instruction file can be ruled out. The flag is carried in
//! the process environment so every loader reads one source.

pub const ENV: &str = "FLINT_SAFE_MODE";

/// Whether this process runs in safe mode.
pub fn active() -> bool {
    std::env::var(ENV).is_ok_and(|v| truthy(&v))
}

fn truthy(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
}

/// Turn safe mode on for this process. Call before any thread is started.
pub fn enable() {
    std::env::set_var(ENV, "1");
}

/// The banner line shown for the whole session.
pub const BANNER: &str = "SAFE MODE: hooks, skills, plugins, MCP servers and project instruction files are off";

#[cfg(test)]
mod tests {
    use super::truthy;

    // The environment is process-wide and other tests load hooks in parallel,
    // so only the parsing is tested here, not a toggled variable.
    #[test]
    fn only_a_real_value_turns_safe_mode_on() {
        assert!(truthy("1") && truthy("true") && truthy("yes"));
        assert!(!truthy("") && !truthy(" ") && !truthy("0") && !truthy("False"));
    }
}
