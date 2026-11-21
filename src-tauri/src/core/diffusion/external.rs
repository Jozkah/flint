//! Open a gallery picture in an editor the person chose (for example G'MIC-Qt).
//!
//! Flint ships no editor. The person gives the program and, optionally, its
//! arguments with a `{file}` placeholder. The program is started directly with
//! an argument vector: never through a shell, so nothing in a prompt, a path or
//! the argument template can be read as a command.

use std::path::{Path, PathBuf};

/// Longest program path, argument template and single argument accepted.
const MAX_TEXT: usize = 2000;
const PLACEHOLDER: &str = "{file}";

/// Windows file types that run through `cmd.exe` and re-parse their arguments
/// as a command line. Refused, so an argument can never become a command.
const SCRIPT_EXTENSIONS: &[&str] = &["bat", "cmd"];

/// Splits an argument template on spaces; double quotes group words.
pub fn split_template(template: &str) -> Result<Vec<String>, String> {
    if template.len() > MAX_TEXT || template.chars().any(|c| c.is_control()) {
        return Err("The arguments contain a character that is not allowed.".to_string());
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in template.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if quoted {
        return Err("The arguments have an opening quote with no closing quote.".to_string());
    }
    if started {
        out.push(current);
    }
    Ok(out)
}

/// The argument vector for one picture: the template with `{file}` replaced by
/// the picture's path, or the path appended when the template has no `{file}`.
pub fn build_argv(template: &str, file: &str) -> Result<Vec<String>, String> {
    let mut argv = split_template(template)?;
    let mut used = false;
    for arg in &mut argv {
        if arg.contains(PLACEHOLDER) {
            *arg = arg.replace(PLACEHOLDER, file);
            used = true;
        }
    }
    if !used {
        argv.push(file.to_string());
    }
    Ok(argv)
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    true
}

/// The program to start, once it is known to be an existing, absolute,
/// directly executable file.
pub fn validate_program(program: &str) -> Result<PathBuf, String> {
    let program = program.trim();
    if program.is_empty() {
        return Err("Choose an app to edit with first.".to_string());
    }
    if program.len() > MAX_TEXT || program.chars().any(|c| c.is_control()) || program.contains("://") {
        return Err("The app path is not a path on this computer.".to_string());
    }
    let path = Path::new(program);
    if !path.is_absolute() {
        return Err("Give the full path of the app, for example C:\\Program Files\\GMIC\\gmic_qt.exe.".to_string());
    }
    let meta = std::fs::metadata(path).map_err(|_| "That app could not be found.".to_string())?;
    if !meta.is_file() {
        return Err("Choose the app's program file, not a folder.".to_string());
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if let Some(ext) = &ext {
        if SCRIPT_EXTENSIONS.contains(&ext.as_str()) {
            return Err("A .bat or .cmd script cannot be used: point at the app's .exe.".to_string());
        }
    }
    if cfg!(windows) && !matches!(ext.as_deref(), Some("exe" | "com")) {
        return Err("Choose the app's .exe file.".to_string());
    }
    if !is_executable(&meta) {
        return Err("That file is not executable.".to_string());
    }
    Ok(path.to_path_buf())
}

/// Starts the editor on one file and does not wait for it.
pub fn launch(program: &str, template: &str, file: &Path) -> Result<(), String> {
    let program = validate_program(program)?;
    let argv = build_argv(template, &file.to_string_lossy())?;
    if argv.iter().any(|a| a.len() > MAX_TEXT) {
        return Err("An argument is too long.".to_string());
    }
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window; the editor outlives Flint's handle on it.
        cmd.creation_flags(0x0800_0000 | 0x0000_0008);
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the app: {e}"))?;
    // Reap it in the background so it never lingers as a zombie.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_is_appended_when_there_is_no_placeholder() {
        assert_eq!(build_argv("", "a.png").unwrap(), vec!["a.png"]);
        assert_eq!(build_argv("--fast", "a.png").unwrap(), vec!["--fast", "a.png"]);
    }

    #[test]
    fn the_placeholder_is_replaced_in_place() {
        assert_eq!(
            build_argv("--input {file} --mode=edit", "C:\\My Pics\\a.png").unwrap(),
            vec!["--input", "C:\\My Pics\\a.png", "--mode=edit"]
        );
        assert_eq!(build_argv("--in={file}", "a.png").unwrap(), vec!["--in=a.png"]);
    }

    #[test]
    fn quotes_group_words_and_shell_syntax_stays_literal() {
        assert_eq!(split_template(r#"--title "two words" x"#).unwrap(), vec!["--title", "two words", "x"]);
        assert_eq!(split_template(r#""" a"#).unwrap(), vec!["", "a"]);
        // Nothing here is a command: it is passed as plain arguments.
        assert_eq!(split_template("& calc; $(x) |y").unwrap(), vec!["&", "calc;", "$(x)", "|y"]);
        assert!(split_template("\"open").is_err());
        assert!(split_template("a\nb").is_err());
    }

    #[test]
    fn a_path_with_shell_characters_stays_one_argument() {
        let file = "C:\\a & b\\x;y.png";
        assert_eq!(build_argv("{file}", file).unwrap(), vec![file]);
    }

    #[test]
    fn the_program_must_be_an_existing_absolute_executable() {
        let dir = std::env::temp_dir().join(format!("flint-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(if cfg!(windows) { "ed.exe" } else { "ed" });
        std::fs::write(&exe, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let bat = dir.join("run.bat");
        std::fs::write(&bat, "x").unwrap();
        let ok = validate_program(&exe.to_string_lossy());
        assert!(ok.is_ok(), "{ok:?}");
        assert!(validate_program("").is_err());
        assert!(validate_program("gmic_qt").is_err());
        assert!(validate_program("https://x.test/a.exe").is_err());
        assert!(validate_program(&dir.join("missing.exe").to_string_lossy()).unwrap_err().contains("not be found"));
        assert!(validate_program(&dir.to_string_lossy()).is_err());
        assert!(validate_program(&bat.to_string_lossy()).unwrap_err().contains(".bat"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
