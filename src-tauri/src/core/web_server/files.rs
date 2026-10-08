//! The file calls the app's extensions make, served from the data folder.
//!
//! On desktop an extension reaches the disk through Tauri commands such as
//! `exists_sync` and `read_yaml`. In a browser the same calls arrive as
//! `POST /api/v1/rpc/<command>` with the arguments the Tauri command takes, and
//! are answered here. Every path, read or write, must stay inside the data
//! folder the server was given: a browser session is not a shell on the host.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Lexically fold `.` and `..` so a path cannot climb out by name alone.
fn fold(path: &Path) -> PathBuf {
    jan_utils::normalize_path(path)
}

fn data_path(data_folder: &Path, raw: &str) -> PathBuf {
    if raw.starts_with("file:/") || raw.starts_with("file:\\") {
        let relative = jan_utils::normalize_file_path(raw);
        let relative = relative
            .trim_start_matches(std::path::MAIN_SEPARATOR)
            .trim_start_matches('/')
            .trim_start_matches('\\');
        data_folder.join(relative)
    } else {
        PathBuf::from(raw)
    }
}

/// Canonical form of the nearest existing ancestor plus the remainder, so a
/// path that does not exist yet (a file about to be written) can still be
/// judged, and a link inside the data folder cannot point out of it.
fn settle(path: &Path) -> PathBuf {
    let folded = fold(path);
    let mut existing = folded.clone();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            return folded;
        };
        existing = parent.to_path_buf();
    }
    match existing.canonicalize() {
        Ok(canonical) => {
            let rest = folded.strip_prefix(&existing).unwrap_or(Path::new(""));
            fold(&canonical.join(rest))
        }
        Err(_) => folded,
    }
}

/// The path a request names, or an error when it leaves the data folder.
pub fn confine(data_folder: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("invalid path".into());
    }
    let base = settle(data_folder);
    let target = settle(&data_path(data_folder, raw));
    if !target.starts_with(&base) {
        return Err("path is outside the data folder".into());
    }
    // `web-server/` holds the server's own files: the hashed credential and
    // sessions, the run record with the shutdown secret, the log and the
    // settings. A signed-in browser must not be able to read or rewrite them
    // (rewriting `auth.json` would make a stolen session permanent). Uploads
    // live there too and stay reachable.
    let private = base.join("web-server");
    if target.starts_with(&private) && !target.starts_with(private.join("uploads")) {
        return Err("path is reserved for the server".into());
    }
    Ok(target)
}

fn first_arg(args: &Value) -> Result<&str, String> {
    args.get("args")
        .and_then(|a| a.as_array().and_then(|list| list.first()).or(Some(a)))
        .and_then(Value::as_str)
        .ok_or_else(|| "expected a path".to_string())
}

fn nth_arg(args: &Value, index: usize) -> Result<&str, String> {
    args.get("args")
        .and_then(Value::as_array)
        .and_then(|list| list.get(index))
        .and_then(Value::as_str)
        .ok_or_else(|| "missing argument".to_string())
}

pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "exists_sync"
            | "readdir_sync"
            | "file_stat"
            | "mkdir"
            | "rm"
            | "mv"
            | "read_file_sync"
            | "write_file_sync"
            | "join_path"
            | "get_jan_data_folder_path"
            | "read_yaml"
            | "write_yaml"
    )
}

pub fn call(data_folder: &Path, command: &str, args: &Value) -> Result<Value, String> {
    match command {
        "get_jan_data_folder_path" => Ok(json!(settle(data_folder).to_string_lossy())),
        "join_path" => {
            let list = args
                .get("args")
                .and_then(Value::as_array)
                .filter(|l| !l.is_empty())
                .ok_or("join_path error: Invalid argument")?;
            let mut parts = list.iter().filter_map(Value::as_str);
            let head = data_path(data_folder, parts.next().ok_or("join_path error: Invalid argument")?);
            let joined = parts.fold(head, |acc, part| acc.join(part));
            Ok(json!(fold(&joined).to_string_lossy()))
        }
        "exists_sync" => Ok(json!(confine(data_folder, first_arg(args)?)?.exists())),
        "file_stat" => {
            let path = confine(data_folder, first_arg(args)?)?;
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
            let is_symlink = fs::symlink_metadata(&path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            Ok(json!({
                "isDirectory": metadata.is_dir(),
                "size": if metadata.is_dir() { 0 } else { metadata.len() },
                "isSymlink": is_symlink,
                "is_directory": metadata.is_dir(),
                "is_symlink": is_symlink,
            }))
        }
        "read_file_sync" => {
            let path = confine(data_folder, first_arg(args)?)?;
            fs::read_to_string(path).map(|text| json!(text)).map_err(|e| e.to_string())
        }
        "write_file_sync" => {
            let path = confine(data_folder, nth_arg(args, 0)?)?;
            let content = nth_arg(args, 1)?;
            fs::write(path, content).map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "readdir_sync" => {
            let path = confine(data_folder, first_arg(args)?)?;
            let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|e| e.path().to_string_lossy().into_owned())
                .collect();
            names.sort();
            Ok(json!(names))
        }
        "mkdir" => {
            let path = confine(data_folder, first_arg(args)?)?;
            fs::create_dir_all(path).map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "rm" => {
            let path = confine(data_folder, first_arg(args)?)?;
            if path == settle(data_folder) {
                return Err("rm error: refusing to remove the data folder".into());
            }
            if path.is_file() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            } else if path.is_dir() {
                fs::remove_dir_all(path).map_err(|e| e.to_string())?;
            } else {
                return Err("rm error: Path does not exist".into());
            }
            Ok(Value::Null)
        }
        "mv" => {
            let source = confine(data_folder, nth_arg(args, 0)?)?;
            let destination = confine(data_folder, nth_arg(args, 1)?)?;
            if !source.exists() {
                return Err("mv error: Source path does not exist".into());
            }
            fs::rename(source, destination).map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "read_yaml" => {
            let raw = args.get("path").and_then(Value::as_str).ok_or("expected a path")?;
            let path = confine(data_folder, raw)?;
            let file = fs::File::open(path).map_err(|e| e.to_string())?;
            serde_yaml::from_reader::<_, Value>(std::io::BufReader::new(file)).map_err(|e| e.to_string())
        }
        "write_yaml" => {
            let raw = args
                .get("savePath")
                .or_else(|| args.get("save_path"))
                .and_then(Value::as_str)
                .ok_or("expected a savePath")?;
            let data = args.get("data").ok_or("expected data")?;
            let path = confine(data_folder, raw)?;
            let file = fs::File::create(path).map_err(|e| e.to_string())?;
            serde_yaml::to_writer(std::io::BufWriter::new(file), data)
                .map(|_| Value::Null)
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unsupported command {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: Value) -> Value {
        json!({ "args": list })
    }

    #[test]
    fn paths_must_stay_inside_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let inside = data.path().join("ok.txt");
        std::fs::write(&inside, "x").unwrap();

        assert!(confine(data.path(), inside.to_str().unwrap()).is_ok());
        assert!(confine(data.path(), "file://models/a.gguf").is_ok());
        assert!(confine(data.path(), outside.path().join("secret.txt").to_str().unwrap()).is_err());
        let climb = data.path().join("..").join(outside.path().file_name().unwrap()).join("secret.txt");
        assert!(confine(data.path(), climb.to_str().unwrap()).is_err());
        assert!(confine(data.path(), "file://../../etc/passwd").is_err());
        assert!(confine(data.path(), "").is_err());
        for reserved in ["auth.json", "server.json", "server.log", "settings.json"] {
            let path = data.path().join("web-server").join(reserved);
            assert!(confine(data.path(), path.to_str().unwrap()).is_err(), "{reserved}");
            assert!(confine(data.path(), &format!("file://web-server/{reserved}")).is_err(), "{reserved} via file://");
            let sneaky = data.path().join("web-server").join("uploads").join("..").join(reserved);
            assert!(confine(data.path(), sneaky.to_str().unwrap()).is_err(), "{reserved} via uploads/..");
        }
        assert!(confine(data.path(), data.path().join("web-server").to_str().unwrap()).is_err());
        let upload = data.path().join("web-server").join("uploads").join("abc").join("a.txt");
        assert!(confine(data.path(), upload.to_str().unwrap()).is_ok());
        let auth = data.path().join("web-server").join("auth.json");
        assert!(call(data.path(), "write_file_sync", &args(json!([auth, "x"]))).is_err());
        assert!(call(data.path(), "rm", &args(json!([data.path().join("web-server").join("server.json")]))).is_err());
        assert!(call(data.path(), "read_file_sync", &args(json!([data.path().join("web-server").join("server.json")]))).is_err());
        assert!(call(data.path(), "read_file_sync", &args(json!([outside.path().join("secret.txt")]))).is_err());
        assert!(call(data.path(), "rm", &args(json!([data.path()]))).is_err());
    }

    #[test]
    fn a_link_inside_the_data_folder_cannot_lead_out() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let link = data.path().join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok();
        if made {
            assert!(confine(data.path(), link.join("secret.txt").to_str().unwrap()).is_err());
        }
    }

    #[test]
    fn the_calls_extensions_make_work_on_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let d = data.path();
        let p = |name: &str| json!(d.join(name).to_string_lossy());

        call(d, "mkdir", &args(json!([p("models/m1")]))).unwrap();
        assert_eq!(call(d, "exists_sync", &args(json!([p("models/m1")]))).unwrap(), json!(true));
        call(d, "write_file_sync", &args(json!([p("models/m1/note.txt"), "hello"]))).unwrap();
        assert_eq!(call(d, "read_file_sync", &args(json!([p("models/m1/note.txt")]))).unwrap(), json!("hello"));
        let stat = call(d, "file_stat", &args(json!(p("models/m1/note.txt")))).unwrap();
        assert_eq!((stat["size"].as_u64(), stat["isDirectory"].as_bool()), (Some(5), Some(false)));

        call(d, "write_yaml", &json!({"data": {"name": "m1", "size_bytes": 7}, "savePath": p("models/m1/model.yml")})).unwrap();
        let yaml = call(d, "read_yaml", &json!({"path": p("models/m1/model.yml")})).unwrap();
        assert_eq!(yaml["name"], "m1");

        let listed = call(d, "readdir_sync", &args(json!([p("models/m1")]))).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);
        call(d, "mv", &args(json!([p("models/m1"), p("models/m2")]))).unwrap();
        assert_eq!(call(d, "exists_sync", &args(json!([p("models/m1")]))).unwrap(), json!(false));
        call(d, "rm", &args(json!([p("models/m2")]))).unwrap();
        assert!(call(d, "rm", &args(json!([p("models/m2")]))).is_err());

        let joined = call(d, "join_path", &args(json!(["file://models", "a", "b.gguf"]))).unwrap();
        assert!(joined.as_str().unwrap().ends_with(&format!("models{0}a{0}b.gguf", std::path::MAIN_SEPARATOR)));
        assert!(call(d, "get_jan_data_folder_path", &json!({})).unwrap().as_str().is_some());
        assert!(!handles("write_blob"));
        assert!(call(d, "write_blob", &json!({})).is_err());
    }
}
