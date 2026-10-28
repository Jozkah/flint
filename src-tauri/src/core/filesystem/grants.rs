//! What the webview may read outside the data folder.
//!
//! The read-only file commands (`exists_sync`, `file_stat`, `read_file_sync`,
//! `readdir_sync`) and the `asset:` grants (`allow_asset_path`) take paths from
//! the webview. One allowlist decides both, so a file the user picked is
//! readable and viewable, and nothing else outside the data folder is:
//!
//! - **the data folder**;
//! - **a path the user picked in the native open dialog**. `open_dialog`
//!   records each pick here, in Rust, where the webview cannot forge it. A
//!   picked file grants that file, a picked folder everything under it, and a
//!   picked `.gguf` also the other `.gguf` files beside it (split shards and
//!   the projector the import dialog looks for);
//! - **an ordinary file under the home folder**, the case of a typed `@path`
//!   reference: never through a dot-prefixed folder or file, and never inside
//!   per-app private data (`Library`, `AppData`).
//!
//! The secret-store deny-list (`jan_utils::path_policy`) is checked first and
//! wins over all three, so a picked folder that holds `.ssh` still refuses it.
//!
//! Paths are compared canonicalized (symlinks and junctions resolved, the
//! Windows `\\?\` prefix stripped) and component by component, ignoring case on
//! Windows and macOS. A pick of a filesystem root, the home folder or one of
//! its ancestors, or a secret store is not recorded.
//!
//! Grants persist in a file next to `settings.json`, outside the data folder,
//! so the webview cannot write them. The first run seeds them from the
//! `model.yml` of models already imported in place; the webview can write
//! those files, so only `.gguf` files and MLX model folders are taken.

use super::asset_scope::check_asset_path;
use super::helpers::canonical_scope_path;
use crate::core::app::commands::{get_configuration_file_path, get_jan_data_folder_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, Runtime};

/// Prefix of the error a refused read returns. The message never says whether
/// the path exists.
pub const DENIED_PREFIX: &str = "fs_read_denied";

pub const STORE_FILE_NAME: &str = "fs-grants.json";
const STORE_VERSION: u32 = 1;

/// Folders under home that hold per-app private data (tokens, cookies,
/// keychains, browser profiles), as lowercase components relative to home,
/// with the subfolders that are the user's own files.
const PRIVATE_APP_DATA: &[(&[&str], &[&[&str]])] = &[
    (
        &["library"],
        &[
            &["library", "cloudstorage"],
            &["library", "mobile documents"],
        ],
    ),
    (&["appdata"], &[]),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "snake_case")]
enum Grant {
    File(PathBuf),
    Dir(PathBuf),
    /// The folder of a picked `.gguf`: the folder itself (to list it) and the
    /// `.gguf` files directly in it.
    GgufDir(PathBuf),
}

impl Grant {
    fn path(&self) -> &Path {
        match self {
            Grant::File(p) | Grant::Dir(p) | Grant::GgufDir(p) => p,
        }
    }

    fn covers(&self, canonical: &Path) -> bool {
        match self {
            Grant::File(p) => same_path(canonical, p),
            Grant::Dir(p) => is_within(canonical, p),
            Grant::GgufDir(p) => {
                same_path(canonical, p)
                    || (is_gguf(canonical)
                        && canonical
                            .parent()
                            .is_some_and(|parent| same_path(parent, p)))
            }
        }
    }
}

fn is_gguf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"))
}

/// Component comparison key: case-folded where the default file system is.
fn key(component: Component<'_>) -> String {
    let text = component.as_os_str().to_string_lossy();
    if cfg!(any(windows, target_os = "macos")) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

/// Whether `path` is `root` or inside it, component by component, so
/// `/work/proj2` is not inside `/work/proj`.
pub fn is_within(path: &Path, root: &Path) -> bool {
    let mut path = path.components();
    for want in root.components() {
        match path.next() {
            Some(have) if key(have) == key(want) => {}
            _ => return false,
        }
    }
    true
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.components().count() == b.components().count() && is_within(a, b)
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    grants: Vec<Grant>,
}

#[derive(Default)]
struct Inner {
    grants: Vec<Grant>,
    /// Where grants persist. `None` keeps them in memory only.
    store: Option<PathBuf>,
}

/// The read allowlist, managed as Tauri state.
#[derive(Default)]
pub struct ReadGrants {
    inner: Mutex<Inner>,
    /// Canonical home folder for the typed-reference rule; `None` turns that
    /// rule off (what `default()` gives tests).
    home: Option<PathBuf>,
}

impl ReadGrants {
    pub fn with_home(home: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::default(),
            home: home.map(|h| canonical_scope_path(&h)),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The whole read decision for a canonical path (see the module docs).
    pub fn allows(&self, canonical: &Path, canonical_data: &Path) -> bool {
        if jan_utils::path_policy::is_sensitive_path(canonical) {
            return false;
        }
        is_within(canonical, canonical_data)
            || self.lock().grants.iter().any(|g| g.covers(canonical))
            || self
                .home
                .as_deref()
                .is_some_and(|home| home_read_allowed(canonical, home))
    }

    /// Records a path the user picked in a native dialog. Returns whether it
    /// was recorded: roots, the home folder and secret stores are refused.
    pub fn record_pick(&self, path: &Path) -> bool {
        let new = grants_for(&canonical_scope_path(path), self.home.as_deref());
        if new.is_empty() {
            return false;
        }
        let mut inner = self.lock();
        let mut changed = false;
        for grant in new {
            changed |= add(&mut inner.grants, grant);
        }
        if changed {
            persist(&inner);
        }
        true
    }

    /// Loads the persisted grants, or on the first run seeds them from
    /// `seed()` and creates the store. A store inside the data folder is not
    /// trusted, as the webview can write there.
    pub fn attach_store(
        &self,
        store: PathBuf,
        data_folder: &Path,
        seed: impl FnOnce() -> Vec<PathBuf>,
    ) {
        if is_within(
            &canonical_scope_path(&store),
            &canonical_scope_path(data_folder),
        ) {
            log::warn!(
                "read grants: {} is inside the data folder, keeping grants in memory only",
                store.display()
            );
            return;
        }
        let mut inner = self.lock();
        let mut first_run = false;
        match fs::read_to_string(&store) {
            Ok(text) => match serde_json::from_str::<StoreFile>(&text) {
                Ok(file) => inner.grants = file.grants,
                Err(e) => log::warn!("read grants: ignoring unreadable {}: {e}", store.display()),
            },
            Err(e) if e.kind() == ErrorKind::NotFound => first_run = true,
            Err(e) => log::warn!("read grants: cannot read {}: {e}", store.display()),
        }
        inner.store = Some(store);
        if first_run {
            for path in seed() {
                for grant in grants_for(&canonical_scope_path(&path), self.home.as_deref()) {
                    add(&mut inner.grants, grant);
                }
            }
            persist(&inner);
        }
    }
}

/// The grants a pick of `canonical` makes, or none when it is too broad or a
/// secret store (the same breadth cap as `asset:` grants).
fn grants_for(canonical: &Path, home: Option<&Path>) -> Vec<Grant> {
    let is_dir = canonical.is_dir();
    if let Err(reason) = check_asset_path(canonical, home, is_dir) {
        log::warn!(
            "read grants: not recording {}: {reason}",
            canonical.display()
        );
        return Vec::new();
    }
    if is_dir {
        return vec![Grant::Dir(canonical.to_path_buf())];
    }
    let mut grants = vec![Grant::File(canonical.to_path_buf())];
    if is_gguf(canonical) {
        if let Some(parent) = canonical.parent() {
            if check_asset_path(parent, home, false).is_ok() {
                grants.push(Grant::GgufDir(parent.to_path_buf()));
            }
        }
    }
    grants
}

/// Adds `grant` unless an existing one covers it; a folder grant replaces the
/// narrower grants beneath it. Returns whether the set changed.
fn add(grants: &mut Vec<Grant>, grant: Grant) -> bool {
    if grants.contains(&grant) {
        return false;
    }
    if let Grant::Dir(dir) = &grant {
        if grants
            .iter()
            .any(|g| matches!(g, Grant::Dir(d) if is_within(dir, d)))
        {
            return false;
        }
        grants.retain(|g| !is_within(g.path(), dir));
    }
    grants.push(grant);
    true
}

fn persist(inner: &Inner) {
    let Some(store) = &inner.store else { return };
    let file = StoreFile {
        version: STORE_VERSION,
        grants: inner.grants.clone(),
    };
    let written = (|| -> std::io::Result<()> {
        if let Some(parent) = store.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = store.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&file)?)?;
        fs::rename(&tmp, store)
    })();
    if let Err(e) = written {
        log::warn!("read grants: cannot write {}: {e}", store.display());
    }
}

/// Records the paths a native open dialog just returned.
pub fn record_picks<R: Runtime>(app: &AppHandle<R>, picks: &[PathBuf]) {
    if let Some(grants) = app.try_state::<ReadGrants>() {
        for pick in picks {
            grants.record_pick(pick);
        }
    }
}

/// Whether the webview may read `path` (any spelling; canonicalized here).
pub fn app_allows<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    let data = canonical_scope_path(&get_jan_data_folder_path(app.clone()));
    let canonical = canonical_scope_path(path);
    match app.try_state::<ReadGrants>() {
        Some(grants) => grants.allows(&canonical, &data),
        None => ReadGrants::default().allows(&canonical, &data),
    }
}

/// Loads the persisted grants at startup (see [`ReadGrants::attach_store`]).
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let Some(grants) = app.try_state::<ReadGrants>() else {
        return;
    };
    let store = get_configuration_file_path(app.clone()).with_file_name(STORE_FILE_NAME);
    let data_folder = get_jan_data_folder_path(app.clone());
    grants.attach_store(store, &data_folder, || in_place_model_paths(&data_folder));
}

/// Whether a typed `@path` reference may read `canonical`: the home folder or
/// anything under it, never through a dot-prefixed component and never inside
/// [`PRIVATE_APP_DATA`]. Compared case-insensitively.
pub fn home_read_allowed(canonical: &Path, canonical_home: &Path) -> bool {
    if !is_within(canonical, canonical_home) {
        return false;
    }
    let mut parts = Vec::new();
    for component in canonical
        .components()
        .skip(canonical_home.components().count())
    {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_lowercase()),
            _ => return false,
        }
    }
    if parts.iter().any(|part| part.starts_with('.')) {
        return false;
    }
    !PRIVATE_APP_DATA.iter().any(|(dir, keep)| {
        starts_with_parts(&parts, dir) && !keep.iter().any(|k| starts_with_parts(&parts, k))
    })
}

fn starts_with_parts(parts: &[String], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len() && parts.iter().zip(prefix).all(|(a, b)| a == b)
}

/// Absolute paths that registered models imported in place point at, read
/// from the `model.yml` files under the data folder's model registries. Used
/// once, to seed the grants of an existing install. Only values shaped like
/// what the app itself stores are taken (see [`is_model_path`]).
pub fn in_place_model_paths(data_folder: &Path) -> Vec<PathBuf> {
    let mut configs = Vec::new();
    for engine in ["llamacpp", "mlx"] {
        collect_model_configs(&data_folder.join(engine).join("models"), 4, &mut configs);
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for config in configs {
        let Ok(text) = fs::read_to_string(&config) else {
            continue;
        };
        let Ok(serde_yaml::Value::Mapping(map)) = serde_yaml::from_str::<serde_yaml::Value>(&text)
        else {
            continue;
        };
        for (key, value) in &map {
            let (Some(key), Some(value)) = (key.as_str(), value.as_str()) else {
                continue;
            };
            let path = Path::new(value);
            if path.is_absolute() && is_model_path(key, path) && !paths.iter().any(|p| p == path) {
                paths.push(path.to_path_buf());
            }
        }
    }
    paths
}

/// A llama.cpp weights or projector file (`.gguf`), or an MLX model folder (a
/// `config.json` next to `model.safetensors` or its shard index).
fn is_model_path(key: &str, path: &Path) -> bool {
    let gguf = is_gguf(path) && path.is_file();
    match key {
        "mmproj_path" | "draft_model_path" => gguf,
        "model_path" => gguf || holds_mlx_weights(path),
        _ => false,
    }
}

fn holds_mlx_weights(dir: &Path) -> bool {
    dir.join("config.json").is_file()
        && (dir.join("model.safetensors").is_file()
            || dir.join("model.safetensors.index.json").is_file())
}

/// Collects `model.yml` files under `dir`, `depth` levels deep, without
/// following symlinked folders.
fn collect_model_configs(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() && entry.file_name() == "model.yml" {
            out.push(entry.path());
        } else if kind.is_dir() && depth > 0 {
            collect_model_configs(&entry.path(), depth - 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn canon(path: &Path) -> PathBuf {
        canonical_scope_path(path)
    }

    struct Fx {
        _tmp: TempDir,
        root: PathBuf,
        data: PathBuf,
    }

    fn fx() -> Fx {
        let tmp = TempDir::new().unwrap();
        let root = canon(tmp.path());
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        Fx {
            _tmp: tmp,
            root,
            data,
        }
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    #[test]
    fn a_picked_file_grants_only_that_file() {
        let f = fx();
        let picked = f.root.join("docs").join("notes.txt");
        let sibling = f.root.join("docs").join("other.txt");
        touch(&picked);
        touch(&sibling);
        let g = ReadGrants::default();
        assert!(g.record_pick(&picked));
        assert!(g.allows(&canon(&picked), &f.data));
        assert!(!g.allows(&canon(&sibling), &f.data), "sibling denied");
        assert!(
            !g.allows(&canon(&f.root.join("docs")), &f.data),
            "parent denied"
        );
    }

    #[test]
    fn a_picked_folder_grants_its_children_but_not_a_lookalike() {
        let f = fx();
        let picked = f.root.join("project");
        let child = picked.join("src").join("a.rs");
        let lookalike = f.root.join("project-other").join("b.txt");
        touch(&child);
        touch(&lookalike);
        let g = ReadGrants::default();
        g.record_pick(&picked);
        assert!(g.allows(&canon(&picked), &f.data));
        assert!(g.allows(&canon(&child), &f.data));
        assert!(!g.allows(&canon(&lookalike), &f.data));
        assert!(!g.allows(&f.root, &f.data));
    }

    #[test]
    fn the_secret_deny_list_wins_inside_a_picked_folder() {
        let f = fx();
        let picked = f.root.join("me");
        let key = picked.join(".ssh").join("id_rsa");
        let secrets = f.data.join("provider_secrets.json");
        touch(&key);
        touch(&secrets);
        let g = ReadGrants::default();
        g.record_pick(&picked);
        assert!(!g.allows(&canon(&key), &f.data));
        assert!(
            !g.allows(&canon(&secrets), &f.data),
            "even in the data folder"
        );
    }

    #[test]
    fn roots_home_and_secret_stores_are_never_recorded() {
        let f = fx();
        let home = f.root.join("home");
        fs::create_dir_all(home.join(".aws")).unwrap();
        let g = ReadGrants::with_home(Some(home.clone()));
        assert!(!g.record_pick(&home), "home itself");
        assert!(!g.record_pick(&f.root), "an ancestor of home");
        assert!(!g.record_pick(&home.join(".aws")), "a secret store");
        let fs_root: PathBuf = f.root.ancestors().last().unwrap().to_path_buf();
        assert!(!g.record_pick(&fs_root), "a filesystem root");
        assert!(g.lock().grants.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_picked_folder_is_denied() {
        let f = fx();
        let picked = f.root.join("project");
        let outside = f.root.join("outside").join("secret.txt");
        touch(&outside);
        fs::create_dir_all(&picked).unwrap();
        std::os::unix::fs::symlink(f.root.join("outside"), picked.join("link")).unwrap();
        let g = ReadGrants::default();
        g.record_pick(&picked);
        assert!(!g.allows(&canon(&picked.join("link").join("secret.txt")), &f.data));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_a_picked_folder_is_denied() {
        let f = fx();
        let picked = f.root.join("project");
        let outside = f.root.join("outside");
        touch(&outside.join("secret.txt"));
        fs::create_dir_all(&picked).unwrap();
        let link = picked.join("link");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        let g = ReadGrants::default();
        g.record_pick(&picked);
        assert!(!g.allows(&canon(&link.join("secret.txt")), &f.data));
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn a_picked_gguf_grants_its_shards_and_projector_but_nothing_else() {
        let f = fx();
        let dir = f.root.join("models");
        let first = dir.join("m-00001-of-00002.gguf");
        let second = dir.join("m-00002-of-00002.gguf");
        let notes = dir.join("notes.txt");
        for p in [&first, &second, &notes] {
            touch(p);
        }
        let g = ReadGrants::default();
        g.record_pick(&first);
        assert!(g.allows(&canon(&second), &f.data));
        assert!(g.allows(&canon(&dir), &f.data), "the folder may be listed");
        assert!(!g.allows(&canon(&notes), &f.data));
        assert!(!g.allows(&canon(&dir.join("sub").join("x.gguf")), &f.data));
    }

    #[test]
    fn typed_references_reach_home_files_but_not_hidden_or_app_data() {
        let f = fx();
        let home = f.root.join("home");
        let note = home.join("Documents").join("note.txt");
        let hidden = home.join(".config").join("x.txt");
        let app_data = home.join("AppData").join("Local").join("x.db");
        for p in [&note, &hidden, &app_data] {
            touch(p);
        }
        let g = ReadGrants::with_home(Some(home));
        assert!(g.allows(&canon(&note), &f.data));
        assert!(!g.allows(&canon(&hidden), &f.data));
        assert!(!g.allows(&canon(&app_data), &f.data));
    }

    #[test]
    fn the_data_folder_is_readable_and_an_unpicked_path_is_not() {
        let f = fx();
        let inside = f.data.join("threads").join("t.json");
        let outside = f.root.join("elsewhere.txt");
        touch(&inside);
        touch(&outside);
        let g = ReadGrants::default();
        assert!(g.allows(&canon(&inside), &f.data));
        assert!(!g.allows(&canon(&outside), &f.data));
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_and_case_spellings_match_a_grant() {
        let f = fx();
        let picked = f.root.join("Project");
        touch(&picked.join("a.txt"));
        let g = ReadGrants::default();
        g.record_pick(&PathBuf::from(format!(r"\\?\{}", picked.display())));
        let upper = PathBuf::from(picked.join("A.TXT").to_string_lossy().to_uppercase());
        assert!(g.allows(&canon(&upper), &f.data));
        let verbatim = PathBuf::from(format!(r"\\?\{}", picked.join("a.txt").display()));
        assert!(g.allows(&canon(&verbatim), &f.data));
        assert!(!g.lock().grants[0]
            .path()
            .to_string_lossy()
            .starts_with(r"\\?\"));
    }

    #[test]
    fn grants_persist_and_the_first_run_seeds_registered_models_only() {
        let f = fx();
        let gguf = f.root.join("weights").join("m.gguf");
        let not_model = f.root.join("weights").join("passwords.txt");
        touch(&gguf);
        touch(&not_model);
        let yml = f
            .data
            .join("llamacpp")
            .join("models")
            .join("m")
            .join("model.yml");
        touch(&yml);
        fs::write(
            &yml,
            format!(
                "model_path: {}\nmmproj_path: {}\nname: {}\n",
                gguf.display(),
                not_model.display(),
                f.root.display()
            ),
        )
        .unwrap();
        let store = f.root.join("config").join(STORE_FILE_NAME);
        let data = f.data.clone();

        let g = ReadGrants::default();
        g.attach_store(store.clone(), &data, || in_place_model_paths(&data));
        assert!(g.allows(&canon(&gguf), &f.data));
        assert!(!g.allows(&canon(&not_model), &f.data));
        assert!(!g.allows(&canon(&f.root.join("weights")).join("x"), &f.data));
        let picked = f.root.join("later.txt");
        touch(&picked);
        g.record_pick(&picked);

        // A second start reads the store and does not seed again.
        let again = ReadGrants::default();
        again.attach_store(store, &data, || panic!("seeded twice"));
        assert!(again.allows(&canon(&gguf), &f.data));
        assert!(again.allows(&canon(&picked), &f.data));
    }

    #[test]
    fn a_store_inside_the_data_folder_is_not_trusted() {
        let f = fx();
        let store = f.data.join(STORE_FILE_NAME);
        let outside = f.root.join("x.txt");
        touch(&outside);
        fs::write(
            &store,
            format!(
                r#"{{"version":1,"grants":[{{"kind":"dir","path":{:?}}}]}}"#,
                f.root.display().to_string()
            ),
        )
        .unwrap();
        let g = ReadGrants::default();
        g.attach_store(store, &f.data, Vec::new);
        assert!(!g.allows(&canon(&outside), &f.data));
    }
}
