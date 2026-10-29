use super::commands::*;
use super::helpers::resolve_path_within_jan_data_folder;
use crate::core::app::commands::get_jan_data_folder_path;
use jan_utils::normalize_path;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::test::mock_app;

#[test]
fn test_read_commands_follow_the_grants() {
    use super::grants::{ReadGrants, DENIED_PREFIX};
    use tauri::Manager;

    let app = mock_app();
    app.manage(ReadGrants::default());
    fs::create_dir_all(get_jan_data_folder_path(app.handle().clone())).unwrap();

    // file: URIs and relative paths may not leave the data folder.
    for escape in ["file://../outside.txt", "../outside.txt"] {
        assert!(!exists_sync(app.handle().clone(), vec![escape.into()]).unwrap());
        assert!(read_file_sync(app.handle().clone(), vec![escape.into()]).is_err());
    }

    let picked = tempfile::tempdir().unwrap();
    fs::write(picked.path().join("config.json"), "{\"a\":1}").unwrap();
    let dir = picked.path().to_string_lossy().to_string();
    let config = picked.path().join("config.json").to_string_lossy().to_string();
    let missing = picked.path().join("nope.txt").to_string_lossy().to_string();

    // Not picked yet: a real file and a missing one answer the same.
    for path in [&config, &missing] {
        assert!(!exists_sync(app.handle().clone(), vec![path.clone()]).unwrap());
        let err = read_file_sync(app.handle().clone(), vec![path.clone()]).unwrap_err();
        assert!(err.starts_with(DENIED_PREFIX), "{err}");
        let err = file_stat(app.handle().clone(), path.clone()).err().unwrap();
        assert!(err.starts_with(DENIED_PREFIX), "{err}");
    }
    let err = readdir_sync(app.handle().clone(), vec![dir.clone()]).unwrap_err();
    assert!(err.starts_with(DENIED_PREFIX), "{err}");

    assert!(app.state::<ReadGrants>().record_pick(picked.path()));
    assert!(exists_sync(app.handle().clone(), vec![config.clone()]).unwrap());
    assert!(!exists_sync(app.handle().clone(), vec![missing]).unwrap());
    assert!(file_stat(app.handle().clone(), dir.clone()).unwrap().is_directory);
    assert_eq!(
        read_file_sync(app.handle().clone(), vec![config]).unwrap(),
        "{\"a\":1}"
    );
    assert_eq!(readdir_sync(app.handle().clone(), vec![dir]).unwrap().len(), 1);
}

#[test]
fn test_readdir_hides_secret_stores_in_a_picked_folder() {
    use super::grants::ReadGrants;
    use tauri::Manager;

    let app = mock_app();
    app.manage(ReadGrants::default());
    let picked = tempfile::tempdir().unwrap();
    fs::create_dir_all(picked.path().join(".ssh")).unwrap();
    fs::write(picked.path().join("readme.md"), "x").unwrap();
    app.state::<ReadGrants>().record_pick(picked.path());

    let listed = readdir_sync(
        app.handle().clone(),
        vec![picked.path().to_string_lossy().to_string()],
    )
    .unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert!(listed[0].ends_with("readme.md"));
    let key = picked.path().join(".ssh").join("id_rsa");
    fs::write(&key, "k").unwrap();
    assert!(!exists_sync(app.handle().clone(), vec![key.to_string_lossy().to_string()]).unwrap());
}

#[test]
fn test_rm() {
    let app = mock_app();
    let path = "test_rm_dir";
    fs::create_dir_all(get_jan_data_folder_path(app.handle().clone()).join(path)).unwrap();
    let args = vec![format!("file://{path}").to_string()];
    let result = rm(app.handle().clone(), args);
    assert!(result.is_ok());
    assert!(!get_jan_data_folder_path(app.handle().clone())
        .join(path)
        .exists());
}

#[test]
fn test_mkdir() {
    let app = mock_app();
    let path = "test_mkdir_dir";
    let args = vec![format!("file://{path}").to_string()];
    let result = mkdir(app.handle().clone(), args);
    assert!(result.is_ok());
    assert!(get_jan_data_folder_path(app.handle().clone())
        .join(path)
        .exists());
    let _ = fs::remove_dir_all(get_jan_data_folder_path(app.handle().clone()).join(path));
}

#[test]
fn test_join_path() {
    let app = mock_app();
    let path = "file://test_dir";
    let args = vec![path.to_string(), "test_file".to_string()];
    let result = join_path(app.handle().clone(), args).unwrap();
    assert_eq!(
        result,
        get_jan_data_folder_path(app.handle().clone())
            .join(format!("test_dir{}test_file", std::path::MAIN_SEPARATOR))
            .to_string_lossy()
            .to_string()
    );
}

#[test]
fn test_exists_sync() {
    let app = mock_app();
    let path = "file://test_exists_sync_file";
    let dir_path = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&dir_path).unwrap();
    let file_path = dir_path.join("test_exists_sync_file");
    File::create(&file_path).unwrap();
    let args: Vec<String> = vec![path.to_string()];
    let result = exists_sync(app.handle().clone(), args).unwrap();
    assert!(result);
    fs::remove_file(file_path).unwrap();
}

#[test]
fn test_read_file_sync() {
    let app = mock_app();
    let path = "file://test_read_file_sync_file";
    let dir_path = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&dir_path).unwrap();
    let file_path = dir_path.join("test_read_file_sync_file");
    let mut file = File::create(&file_path).unwrap();
    file.write_all(b"test content").unwrap();
    let args = vec![path.to_string()];
    let result = read_file_sync(app.handle().clone(), args).unwrap();
    assert_eq!(result, "test content".to_string());
    fs::remove_file(file_path).unwrap();
}

#[test]
fn test_readdir_sync() {
    let app = mock_app();
    let dir_path = get_jan_data_folder_path(app.handle().clone()).join("test_readdir_sync_dir");
    fs::create_dir_all(&dir_path).unwrap();
    File::create(dir_path.join("file1.txt")).unwrap();
    File::create(dir_path.join("file2.txt")).unwrap();

    let args = vec![dir_path.to_string_lossy().to_string()];
    let result = readdir_sync(app.handle().clone(), args).unwrap();
    assert_eq!(result.len(), 2);

    let _ = fs::remove_dir_all(dir_path);
}

#[cfg(unix)]
#[test]
fn test_resolve_jan_scoped_path_allows_canonicalized_home_symlink_target() {
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base_dir = std::env::temp_dir().join(format!("jan-path-scope-{unique}"));
    let configured_root = base_dir.join("home").join("user").join("jan-data");
    let canonical_root = base_dir
        .join("var")
        .join("home")
        .join("user")
        .join("jan-data");
    fs::create_dir_all(&canonical_root).unwrap();
    fs::create_dir_all(configured_root.parent().unwrap()).unwrap();
    symlink(&canonical_root, &configured_root).unwrap();

    let candidate = canonical_root.join("llamacpp/backends/v1/backend.tar.gz");
    let (_, resolved_path) =
        resolve_path_within_jan_data_folder(&configured_root, candidate.to_string_lossy().as_ref())
            .unwrap();

    let expected_path = canonical_root
        .canonicalize()
        .unwrap()
        .join("llamacpp/backends/v1/backend.tar.gz");
    assert_eq!(resolved_path, expected_path);

    let _ = fs::remove_dir_all(&base_dir);
}

#[test]
fn test_resolve_jan_scoped_path_accepts_relative_path_inside_root() {
    let jan_data_folder = unique_test_dir("relative");
    fs::create_dir_all(&jan_data_folder).unwrap();

    let (resolved_root, resolved_path) = resolve_path_within_jan_data_folder(
        &jan_data_folder,
        "llamacpp/backends/v1/backend.tar.gz",
    )
    .unwrap();

    assert!(resolved_path.starts_with(&resolved_root));
    assert_eq!(
        normalize_test_path(&resolved_root),
        normalize_test_path(&jan_data_folder.canonicalize().unwrap())
    );
    assert_eq!(
        resolved_path.file_name().and_then(|name| name.to_str()),
        Some("backend.tar.gz")
    );

    let _ = fs::remove_dir_all(&jan_data_folder);
}

#[test]
fn test_resolve_jan_scoped_path_rejects_escape_outside_data_folder() {
    let jan_data_folder = unique_test_dir("escape");
    fs::create_dir_all(&jan_data_folder).unwrap();

    let result = resolve_path_within_jan_data_folder(&jan_data_folder, "../outside.txt");
    assert!(result.is_err());

    let _ = fs::remove_dir_all(&jan_data_folder);
}

#[test]
fn test_resolve_jan_scoped_path_rejects_absolute_path_outside_root() {
    let jan_data_folder = unique_test_dir("absolute-inside");
    let outside_path = unique_test_dir("absolute-outside").join("file.txt");
    fs::create_dir_all(&jan_data_folder).unwrap();
    fs::create_dir_all(outside_path.parent().unwrap()).unwrap();

    let result = resolve_path_within_jan_data_folder(
        &jan_data_folder,
        outside_path.to_string_lossy().as_ref(),
    );
    assert!(result.is_err());

    let _ = fs::remove_dir_all(&jan_data_folder);
    let _ = fs::remove_dir_all(outside_path.parent().unwrap());
}

#[test]
fn test_unpack_archive_tar_gz() {
    let dir = unique_test_dir("unpack");
    let nested = dir.join("build/bin");
    fs::create_dir_all(&nested).unwrap();
    File::create(nested.join("llama-server"))
        .unwrap()
        .write_all(b"binary")
        .unwrap();

    let archive_path = dir.join("backend.tar.gz");
    {
        let gz = flate2::write::GzEncoder::new(
            File::create(&archive_path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut builder = tar::Builder::new(gz);
        builder.append_dir_all("build", dir.join("build")).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }

    let out = dir.join("out");
    unpack_archive(&archive_path, &out).unwrap();
    assert_eq!(
        fs::read_to_string(out.join("build/bin/llama-server")).unwrap(),
        "binary"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_unpack_archive_rejects_unknown_extension() {
    let dir = unique_test_dir("unpack-bad");
    fs::create_dir_all(&dir).unwrap();
    let archive_path = dir.join("backend.rar");
    File::create(&archive_path)
        .unwrap()
        .write_all(b"x")
        .unwrap();

    assert!(unpack_archive(&archive_path, &dir.join("out")).is_err());

    let _ = fs::remove_dir_all(&dir);
}

fn write_zip(path: &std::path::Path, files: &[(&str, Vec<u8>)]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    for (name, body) in files {
        zip.start_file(*name, zip::write::FileOptions::default()).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn an_archive_past_the_caps_leaves_no_output_behind() {
    let dir = unique_test_dir("unpack-bomb");
    fs::create_dir_all(&dir).unwrap();
    let archive_path = dir.join("bomb.ZIP");
    write_zip(&archive_path, &[("a.bin", vec![0u8; 64 * 1024]), ("b.bin", vec![0u8; 64 * 1024])]);
    let out = dir.join("out");
    let err = unpack_archive_capped(&archive_path, &out, 100, 100 * 1024).unwrap_err();
    assert!(err.contains("more than"), "{err}");
    assert!(!out.exists(), "a refused unpack must not leave its output");
    let leftovers: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name() != "bomb.ZIP")
        .collect();
    assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    // Too many entries is refused too.
    assert!(unpack_archive_capped(&archive_path, &out, 1, u64::MAX).is_err());
    // Within the caps, the upper-case extension unpacks.
    unpack_archive_capped(&archive_path, &out, 100, 1024 * 1024).unwrap();
    assert_eq!(fs::read(out.join("b.bin")).unwrap().len(), 64 * 1024);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unpacking_into_an_existing_folder_merges_and_keeps_other_files() {
    let dir = unique_test_dir("unpack-merge");
    let out = dir.join("out");
    fs::create_dir_all(out.join("build")).unwrap();
    fs::write(out.join("build/keep.txt"), "kept").unwrap();
    fs::write(out.join("build/new.txt"), "old").unwrap();
    let archive_path = dir.join("b.zip");
    write_zip(&archive_path, &[("build/new.txt", b"new".to_vec())]);
    unpack_archive(&archive_path, &out).unwrap();
    assert_eq!(fs::read_to_string(out.join("build/keep.txt")).unwrap(), "kept");
    assert_eq!(fs::read_to_string(out.join("build/new.txt")).unwrap(), "new");
    let _ = fs::remove_dir_all(&dir);
}

fn unique_test_dir(label: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("jan-filesystem-{label}-{unique}"))
}

fn normalize_test_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            return normalize_path(Path::new(stripped));
        }
    }

    normalize_path(path)
}
