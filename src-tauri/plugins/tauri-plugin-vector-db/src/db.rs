use crate::VectorDBError;
use crate::utils::{cosine_similarity, from_le_bytes_vec, to_le_bytes_vec};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct FileMetadata {
    pub name: Option<String>,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    pub size: Option<i64>,
}


#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub text: String,
    pub score: Option<f32>,
    pub file_id: String,
    pub chunk_file_order: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttachmentFileInfo {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    pub size: Option<i64>,
    pub chunk_count: i64,
    /// Source file's modification time (seconds since the epoch) when it was
    /// indexed. `None` for rows indexed before the column existed.
    #[serde(default)]
    pub mtime: Option<i64>,
    /// Set by `create_file` when an existing row for the same path was reset
    /// because the file on disk changed; its old chunks are gone.
    #[serde(default)]
    pub replaced: bool,
}

// New minimal chunk input (no id/metadata) for file-scoped insertion
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MinimalChunkInput {
    pub text: String,
    pub embedding: Vec<f32>,
}

// ============================================================================
// Connection & Path Management
// ============================================================================

/// Canonical base directory for all vector-db collections (RAG chunks and the
/// agent memory store). Single source of truth shared by `VectorDBState` and any
/// out-of-plugin consumer so they operate on the same `.db` files.
pub fn default_base_dir() -> PathBuf {
    let mut base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.push("Jan");
    base.push("data");
    base.push("db");
    base
}

const RESERVED_WINDOWS_STEMS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Map a collection name to its `.db` file under `base`. The name is an
/// allow-list (`[A-Za-z0-9_.-]{1,128}`, no leading dot, no Windows reserved
/// device stem) so `C:evil`, `..`, `a/b` and `NUL` can never leave `base`.
pub fn collection_path(base: &Path, name: &str) -> Result<PathBuf, VectorDBError> {
    let bad = |why: &str| VectorDBError::InvalidInput(format!("invalid collection name '{name}': {why}"));
    if name.is_empty() || name.len() > 128 {
        return Err(bad("length must be 1-128"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return Err(bad("only letters, digits, '_', '.' and '-' are allowed"));
    }
    if name.starts_with('.') {
        return Err(bad("must not start with '.'"));
    }
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_WINDOWS_STEMS.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(bad("reserved device name"));
    }
    let path = base.join(format!("{name}.db"));
    if path.parent() != Some(base) {
        return Err(bad("escapes the database folder"));
    }
    Ok(path)
}

/// Remove a collection's database and its `-wal`, `-shm` and `-journal`
/// sidecars. Missing files are fine; a `.db` that is still present afterwards
/// (for example locked on Windows) is an error.
pub fn delete_collection_files(base: &Path, name: &str) -> Result<(), VectorDBError> {
    let db_path = collection_path(base, name)?;
    let mut targets = vec![db_path.clone()];
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut s = db_path.clone().into_os_string();
        s.push(suffix);
        targets.push(PathBuf::from(s));
    }
    let mut last_err: Option<std::io::Error> = None;
    for target in &targets {
        for attempt in 0..5 {
            match fs::remove_file(target) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => {
                    last_err = Some(e);
                    if attempt < 4 {
                        std::thread::sleep(std::time::Duration::from_millis(40));
                    }
                }
            }
        }
    }
    if db_path.exists() {
        let why = last_err.map(|e| e.to_string()).unwrap_or_else(|| "file still present".into());
        return Err(VectorDBError::DatabaseError(format!(
            "could not delete collection '{name}': {why}"
        )));
    }
    Ok(())
}

pub fn open_or_init_conn(path: &PathBuf) -> Result<Connection, VectorDBError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    register_static_vec();
    let conn = Connection::open(path)?;
    Ok(conn)
}

static VEC_STATIC: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Statically linked sqlite-vec, registered as a SQLite auto-extension so every
/// connection opened afterwards has `vec0` with no library file lookup. Must
/// run before the connection opens (`open_or_init_conn` does). Idempotent.
pub fn register_static_vec() -> bool {
    *VEC_STATIC.get_or_init(|| {
        // SAFETY: sqlite3_vec_init has the extension-entry shape; the transmute
        // only restores the parameter list the sqlite-vec crate leaves empty.
        let rc = unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                unsafe extern "C" fn(
                    *mut rusqlite::ffi::sqlite3,
                    *mut *mut std::os::raw::c_char,
                    *const rusqlite::ffi::sqlite3_api_routines,
                ) -> std::os::raw::c_int,
            >(sqlite_vec::sqlite3_vec_init as *const ())))
        };
        if rc != rusqlite::ffi::SQLITE_OK {
            eprintln!("[VectorDB] static sqlite-vec registration failed (sqlite rc {rc}); trying dynamic library paths");
        }
        rc == rusqlite::ffi::SQLITE_OK
    })
}

/// Backend a search on this connection uses: "vec0" (sqlite-vec) or "linear".
pub fn vector_search_backend(conn: &Connection) -> &'static str {
    if vec0_module_available(conn) { "vec0" } else { "linear" }
}

// ============================================================================
// SQLite-vec Extension Loading
// ============================================================================

pub fn try_load_sqlite_vec(conn: &Connection) -> bool {
    load_sqlite_vec(conn, false)
}

/// Same probe, narrating each candidate for startup diagnostics.
pub fn try_load_sqlite_vec_verbose(conn: &Connection) -> bool {
    load_sqlite_vec(conn, true)
}

fn vec0_module_available(conn: &Connection) -> bool {
    if conn
        .execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS temp.temp_vec USING vec0(embedding float[1])",
            [],
        )
        .is_ok()
    {
        let _ = conn.execute("DROP TABLE IF EXISTS temp.temp_vec", []);
        return true;
    }
    false
}

/// Outcome of the first probe for the sqlite-vec library, kept for the life of
/// the process so each search does not retry a dozen failing `dlopen`s.
/// `Some(None)` = probed, not found; `Some(Some(p))` = loads from `p`.
static VEC_PROBE: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);

fn load_sqlite_vec(conn: &Connection, verbose: bool) -> bool {
    if vec0_module_available(conn) {
        if verbose {
            println!("[VectorDB] sqlite-vec already loaded");
        }
        return true;
    }

    let cached = VEC_PROBE.lock().ok().and_then(|g| g.clone());
    if let Some(None) = cached {
        if !verbose {
            return false;
        }
    }

    // SQL-level `load_extension()` stays off except for the instant the
    // Rust-side loader below runs.
    unsafe {
        let _ = conn.load_extension_enable();
    }
    let first_probe = cached.is_none();
    let ok = probe_sqlite_vec(conn, verbose, cached.flatten());
    let _ = conn.load_extension_disable();
    if !ok && first_probe {
        eprintln!(
            "[VectorDB] sqlite-vec (vec0) unavailable: static registration {} and no loadable library found in any search path; RAG falls back to slower linear search",
            if VEC_STATIC.get().copied().unwrap_or(false) { "succeeded but vec0 did not load" } else { "failed" }
        );
    }
    ok
}

fn probe_sqlite_vec(conn: &Connection, verbose: bool, known: Option<String>) -> bool {
    let paths = match known {
        Some(p) => vec![p],
        None => possible_sqlite_vec_paths(),
    };
    if verbose {
        println!("[VectorDB] Trying {} sqlite-vec candidates...", paths.len());
    }
    for p in &paths {
        if verbose {
            println!("[VectorDB]   Trying: {}", p);
        }
        let loaded = unsafe { conn.load_extension(p, Some("sqlite3_vec_init")).is_ok() };
        if loaded && vec0_module_available(conn) {
            if verbose {
                println!("[VectorDB] sqlite-vec loaded from: {}", p);
            }
            if let Ok(mut g) = VEC_PROBE.lock() {
                *g = Some(Some(p.clone()));
            }
            return true;
        }
    }

    if let Ok(mut g) = VEC_PROBE.lock() {
        *g = Some(None);
    }
    if !paths.is_empty() {
        eprintln!(
            "[VectorDB] sqlite-vec library not loadable from any of: {}",
            paths.join(", ")
        );
    }
    if verbose {
        println!("[VectorDB] sqlite-vec unavailable; using linear search");
    }
    false
}

/// Filenames sqlite-vec ships under, without a platform suffix; SQLite appends
/// that itself. `vec0` is what most distro packages install.
const SQLITE_VEC_STEMS: [&str; 2] = ["sqlite-vec", "vec0"];

const SQLITE_VEC_SYSTEM_DIRS: &[&str] = if cfg!(target_os = "macos") {
    &["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib"]
} else if cfg!(target_os = "windows") {
    &["C:\\Program Files\\sqlite-vec"]
} else {
    &[
        "/usr/lib/sqlite3",
        "/usr/local/lib/sqlite3",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/usr/lib64",
        "/usr/local/lib",
        "/usr/lib",
    ]
};

/// Tauri's resource folder, set once at plugin setup. The bundle puts
/// `resources/bin/sqlite-vec.<ext>` under it, which in an AppImage
/// (`usr/lib/<product>/`) or a macOS `.app` (`Contents/Resources/`) is not next
/// to the executable.
static RESOURCE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Record the app's resource folder so the bundled sqlite-vec is tried first.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

pub fn possible_sqlite_vec_paths() -> Vec<String> {
    build_sqlite_vec_paths(
        crate::compat_env::var("SQLITE_VEC_PATH").ok(),
        RESOURCE_DIR.get().cloned(),
        std::env::current_exe().ok(),
    )
}

/// `<dir>/resources/bin/sqlite-vec`, the layout the tauri confs bundle.
fn bundled_vec_path(dir: &std::path::Path) -> String {
    dir.join("resources")
        .join("bin")
        .join("sqlite-vec")
        .to_string_lossy()
        .into_owned()
}

fn build_sqlite_vec_paths(
    override_path: Option<String>,
    resource_dir: Option<PathBuf>,
    exe: Option<PathBuf>,
) -> Vec<String> {
    let mut paths = Vec::new();

    if let Some(custom) = override_path {
        if !custom.trim().is_empty() {
            paths.push(custom);
        }
    }

    // The copy the installer bundles (tauri.<os>.conf.json resources).
    if let Some(dir) = resource_dir {
        paths.push(bundled_vec_path(&dir));
    }

    // Dev builds only: the checkout's resources, anchored at compile time. A
    // working-directory-relative path would run whatever the launch directory
    // holds.
    #[cfg(debug_assertions)]
    paths.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/bin/sqlite-vec")
            .to_string_lossy()
            .into_owned(),
    );

    // Exe-relative paths
    if let Some(exe) = exe {
        if let Some(dir) = exe.parent() {
            paths.push(bundled_vec_path(dir));
        }

        #[cfg(target_os = "macos")]
        {
            if let Some(mac_dir) = exe.parent().and_then(|p| p.parent()) {
                let mut r = mac_dir.to_path_buf();
                r.push("Resources");
                r.push("bin");
                r.push("sqlite-vec");
                paths.push(r.to_string_lossy().to_string());
            }
        }
    }

    // System installs: a package-manager copy, for builds whose bundle has no
    // library for the platform (e.g. Windows arm64).
    for dir in SQLITE_VEC_SYSTEM_DIRS {
        for stem in SQLITE_VEC_STEMS {
            paths.push(format!("{dir}{}{stem}", std::path::MAIN_SEPARATOR));
        }
    }

    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

/// Column options of `chunks_vec`. Cosine distance makes the ANN score
/// (`1 - distance`) the same quantity the linear path computes.
const VEC_METRIC: &str = "distance_metric=cosine";

/// The `CREATE` text of `chunks_vec`, if the table exists.
fn vec_table_sql(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
        [],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

/// Whether `chunks_vec` exists and ranks by cosine distance. A table made by an
/// earlier build ranks by L2, which is not comparable with the linear score.
fn cosine_vec_table_exists(conn: &Connection) -> bool {
    vec_table_sql(conn).is_some_and(|sql| sql.contains(VEC_METRIC))
}

/// Create `chunks_vec` for `dimension`, rebuilding it from `chunks` when the
/// existing table is an L2 one or was built for another dimension (the
/// embedding model changed). Returns false when ANN is unavailable, so callers
/// fall back to linear search.
pub fn ensure_vec_table(conn: &Connection, dimension: usize) -> bool {
    if !try_load_sqlite_vec(conn) {
        return false;
    }
    let rebuild = vec_table_sql(conn)
        .is_some_and(|sql| !sql.contains(VEC_METRIC) || !sql.contains(&format!("float[{dimension}]")));
    if rebuild {
        if let Err(e) = conn.execute("DROP TABLE chunks_vec", []) {
            println!("[VectorDB] ✗ Failed to drop stale chunks_vec: {}", e);
            return false;
        }
    }
    let create = format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[{dimension}] {VEC_METRIC})"
    );
    if let Err(e) = conn.execute(&create, []) {
        println!("[VectorDB] ✗ Failed to create chunks_vec: {}", e);
        return false;
    }
    if rebuild {
        // Stored embeddings are little-endian f32 blobs, the layout vec0 takes.
        let filled = conn.execute(
            "INSERT INTO chunks_vec(rowid, embedding) SELECT rowid, embedding FROM chunks WHERE length(embedding) = ?1",
            params![(dimension * 4) as i64],
        );
        if let Err(e) = filled {
            println!("[VectorDB] ✗ Failed to rebuild chunks_vec: {}", e);
            let _ = conn.execute("DROP TABLE IF EXISTS chunks_vec", []);
            return false;
        }
    }
    true
}

// ============================================================================
// Schema Creation
// ============================================================================

/// Idempotent `ALTER TABLE files ADD COLUMN mtime` for databases made before
/// the column existed.
fn ensure_files_mtime(conn: &Connection) -> Result<(), VectorDBError> {
    let has_mtime = conn
        .prepare("SELECT 1 FROM pragma_table_info('files') WHERE name = 'mtime'")?
        .exists([])?;
    if !has_mtime {
        conn.execute("ALTER TABLE files ADD COLUMN mtime INTEGER", [])?;
    }
    Ok(())
}

/// Modification time of `path` in whole seconds since the epoch, if readable.
fn file_mtime(path: &str) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    i64::try_from(secs).ok()
}

pub fn create_schema(conn: &Connection, dimension: usize) -> Result<bool, VectorDBError> {
    // Files table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            name TEXT,
            type TEXT,
            size INTEGER,
            chunk_count INTEGER DEFAULT 0,
            mtime INTEGER
        )",
        [],
    )?;
    ensure_files_mtime(conn)?;

    // Chunks table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            file_id TEXT,
            chunk_file_order INTEGER,
            FOREIGN KEY (file_id) REFERENCES files(id)
        )",
        [],
    )?;

    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_id ON chunks(id)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_file_order ON chunks(file_id, chunk_file_order)", [])?;

    // Try to create vec virtual table
    let has_ann = ensure_vec_table(conn, dimension);
    Ok(has_ann)
}

// ============================================================================
// Insert Operations
// ============================================================================

pub fn create_file(
    conn: &Connection,
    path: &str,
    name: Option<&str>,
    file_type: Option<&str>,
    size: Option<i64>,
) -> Result<AttachmentFileInfo, VectorDBError> {
    ensure_files_mtime(conn)?;
    let tx = conn.unchecked_transaction()?;

    // Determine file size if not provided
    let computed_size: Option<i64> = match size {
        Some(s) if s > 0 => Some(s),
        _ => std::fs::metadata(path).ok().map(|meta| meta.len() as i64),
    };
    let mtime = file_mtime(path);

    let read_row = |tx: &Connection, id: &str, replaced: bool| -> Result<AttachmentFileInfo, VectorDBError> {
        let mut stmt = tx.prepare(
            "SELECT id, path, name, type, size, chunk_count, mtime FROM files WHERE id = ?1",
        )?;
        Ok(stmt.query_row(params![id], |r| {
            Ok(AttachmentFileInfo {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                file_type: r.get(3)?,
                size: r.get(4)?,
                chunk_count: r.get(5)?,
                mtime: r.get(6)?,
                replaced,
            })
        })?)
    };

    // An existing row for this path: keep it when the file is unchanged (or
    // cannot be checked); otherwise drop its chunks so stale text cannot be
    // served, and reuse the row. A NULL stored mtime is unknown and replaced.
    let existing: Option<(String, Option<i64>, Option<i64>)> = tx
        .prepare("SELECT id, size, mtime FROM files WHERE path = ?1")?
        .query_row(params![path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    if let Some((id, old_size, old_mtime)) = existing {
        let unchanged = match mtime {
            None => true,
            Some(m) => old_mtime == Some(m) && (computed_size.is_none() || old_size == computed_size),
        };
        if unchanged {
            let row = read_row(&tx, &id, false)?;
            tx.commit()?;
            return Ok(row);
        }
        delete_vec_rows(&tx, "file_id = ?1", &id);
        tx.execute("DELETE FROM chunks WHERE file_id = ?1", params![id])?;
        tx.execute(
            "UPDATE files SET name = ?2, type = ?3, size = ?4, mtime = ?5, chunk_count = 0 WHERE id = ?1",
            params![id, name, file_type, computed_size, mtime],
        )?;
        let row = read_row(&tx, &id, true)?;
        tx.commit()?;
        return Ok(row);
    }

    let new_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO files (id, path, name, type, size, chunk_count, mtime) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![new_id, path, name, file_type, computed_size, mtime],
    )?;
    let row = read_row(&tx, &new_id, false)?;
    tx.commit()?;
    Ok(row)
}

pub fn insert_chunks(
    conn: &Connection,
    file_id: &str,
    chunks: Vec<MinimalChunkInput>,
    vec_loaded: bool,
) -> Result<(), VectorDBError> {
    let tx = conn.unchecked_transaction()?;

    // A table that is not a cosine one is left alone: search ignores it and
    // `create_schema` rebuilds it from `chunks`.
    let has_vec = vec_loaded && cosine_vec_table_exists(conn);

    // Determine current max order
    let mut current_order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(chunk_file_order), -1) FROM chunks WHERE file_id = ?1",
            params![file_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(-1);

    for ch in chunks.into_iter() {
        // Reject unusable vectors before they reach either table: a non-finite
        // value poisons cosine_similarity on the linear path and sqlite-vec
        // silently drops the row on the ANN path.
        validate_embedding(&ch.embedding)?;
        current_order += 1;
        let emb = to_le_bytes_vec(&ch.embedding);
        let chunk_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT OR REPLACE INTO chunks (id, text, embedding, file_id, chunk_file_order) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![chunk_id, ch.text, emb, file_id, current_order],
        )?;

        if has_vec {
            let rowid: i64 = tx
                .prepare("SELECT rowid FROM chunks WHERE id=?1")?
                .query_row(params![chunk_id], |r| r.get(0))?;
            let json_vec = embedding_to_json(&ch.embedding)?;
            // Propagated: a row that is stored but missing from the index would
            // make ANN search silently incomplete. The usual cause is a
            // chunks_vec built for another dimension, which `create_schema`
            // rebuilds.
            if let Err(e) = tx.execute(
                "INSERT OR REPLACE INTO chunks_vec(rowid, embedding) VALUES (?1, ?2)",
                params![rowid, json_vec],
            ) {
                return Err(VectorDBError::DimensionMismatch(format!(
                    "could not index a {}-value embedding in chunks_vec: {e}",
                    ch.embedding.len()
                )));
            }
        }
    }

    // Update chunk_count
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM chunks WHERE file_id = ?1",
        params![file_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE files SET chunk_count = ?1 WHERE id = ?2",
        params![count, file_id],
    )?;

    tx.commit()?;
    Ok(())
}

/// Removes the ANN rows of the chunks `chunk_filter` selects (a `WHERE` on
/// `chunks` with one `?1` parameter). Left behind they would keep matching,
/// fill the `k` nearest slots with rows that join to nothing, and be served
/// again if a new chunk reused the rowid. Best effort: without sqlite-vec
/// there is no `chunks_vec` to clean.
fn delete_vec_rows(conn: &Connection, chunk_filter: &str, param: &str) {
    let has_vec = try_load_sqlite_vec(conn)
        && conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
                [],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some();
    if !has_vec {
        return;
    }
    let sql = format!(
        "DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE {chunk_filter})"
    );
    if let Err(e) = conn.execute(&sql, params![param]) {
        println!("[VectorDB] ✗ Failed to delete chunks_vec rows: {}", e);
    }
}

pub fn delete_file(conn: &Connection, file_id: &str) -> Result<(), VectorDBError> {
    let tx = conn.unchecked_transaction()?;
    delete_vec_rows(&tx, "file_id = ?1", file_id);
    tx.execute("DELETE FROM chunks WHERE file_id = ?1", params![file_id])?;
    tx.execute("DELETE FROM files WHERE id = ?1", params![file_id])?;
    tx.commit()?;
    Ok(())
}

// ============================================================================
// Search Operations
// ============================================================================

// sqlite-vec parses a bound vector as JSON. serde_json writes a non-finite
// float as `null` and sqlite-vec then fails with only "JSON parsing error", so
// reject the vector here while the offending element can still be named.
fn embedding_to_json(embedding: &[f32]) -> Result<String, VectorDBError> {
    validate_embedding(embedding)?;
    Ok(serde_json::to_string(embedding)?)
}

fn validate_embedding(embedding: &[f32]) -> Result<(), VectorDBError> {
    if embedding.is_empty() {
        return Err(VectorDBError::InvalidInput(
            "embedding is empty; the embedding model returned no vector".to_string(),
        ));
    }
    if let Some(i) = embedding.iter().position(|v| !v.is_finite()) {
        return Err(VectorDBError::InvalidInput(format!(
            "embedding has a non-finite value ({}) at index {} of {}; the embedding model returned an unusable vector",
            embedding[i],
            i,
            embedding.len()
        )));
    }
    Ok(())
}

/// Upper bound on results one search may return.
const MAX_SEARCH_LIMIT: usize = 1000;
/// Upper bound on the `file_ids` filter, well under SQLite's variable limit.
const MAX_FILE_IDS: usize = 500;

/// Scores are cosine similarity, higher is better, and `threshold` is a floor
/// on that score on both the ANN and the linear path.
pub fn search_collection(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
    threshold: f32,
    mode: Option<String>,
    vec_loaded: bool,
    file_ids: Option<Vec<String>>,
) -> Result<Vec<SearchResult>, VectorDBError> {
    // Both paths need this: sqlite-vec fails opaquely on a non-finite value,
    // and cosine_similarity turns it into a NaN score that silently fails the
    // threshold, so retrieval would just come back empty.
    validate_embedding(query_embedding)?;

    // `limit` and `file_ids` come straight from the renderer.
    let limit = limit.min(MAX_SEARCH_LIMIT);
    if file_ids.as_ref().is_some_and(|ids| ids.len() > MAX_FILE_IDS) {
        return Err(VectorDBError::InvalidInput(format!(
            "too many file ids ({}); the maximum is {MAX_FILE_IDS}",
            file_ids.as_ref().map_or(0, Vec::len)
        )));
    }

    // An L2 table left by an earlier build scores on another scale: linear.
    let has_vec = vec_loaded && cosine_vec_table_exists(conn);

    let prefer_ann = match mode.as_deref() {
        Some("ann") => true,
        Some("linear") => false,
        _ => true, // auto prefers ANN when available
    };

    // vec0 applies `k` before the file_id filter, so a scoped ANN query
    // returns only those of the k global nearest that belong to the files --
    // often none. A scoped search covers few chunks; scan them exactly.
    if has_vec && prefer_ann && file_ids.is_none() {
        search_ann(conn, query_embedding, limit, threshold, file_ids)
    } else {
        search_linear(conn, query_embedding, limit, threshold, file_ids)
    }
}

fn search_ann(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
    threshold: f32,
    file_ids: Option<Vec<String>>,
) -> Result<Vec<SearchResult>, VectorDBError> {
    let json_vec = embedding_to_json(query_embedding)?;

    // Build query with optional file_id filtering
    let query = if let Some(ref ids) = file_ids {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        format!(
            "SELECT c.id, c.text, c.file_id, c.chunk_file_order, v.distance
             FROM chunks_vec v
             JOIN chunks c ON c.rowid = v.rowid
             WHERE v.embedding MATCH ?1 AND k = ?2 AND c.file_id IN ({})
             ORDER BY v.distance",
            placeholders
        )
    } else {
        "SELECT c.id, c.text, c.file_id, c.chunk_file_order, v.distance
         FROM chunks_vec v
         JOIN chunks c ON c.rowid = v.rowid
         WHERE v.embedding MATCH ?1 AND k = ?2
         ORDER BY v.distance".to_string()
    };

    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(e) => {
            println!("[VectorDB] ✗ Failed to prepare ANN query: {}", e);
            return Err(e.into());
        }
    };

    let mut rows = if let Some(ids) = file_ids {
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(json_vec),
            Box::new(limit as i64),
        ];
        for id in ids {
            params.push(Box::new(id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        match stmt.query(&*param_refs) {
            Ok(r) => r,
            Err(e) => {
                println!("[VectorDB] ✗ Failed to execute ANN query: {}", e);
                return Err(e.into());
            }
        }
    } else {
        match stmt.query(params![json_vec, limit as i64]) {
            Ok(r) => r,
            Err(e) => {
                println!("[VectorDB] ✗ Failed to execute ANN query: {}", e);
                return Err(e.into());
            }
        }
    };

    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let text: String = row.get(1)?;
        let file_id: String = row.get(2)?;
        let chunk_file_order: i64 = row.get(3)?;
        let distance: f32 = row.get(4)?;
        // Cosine distance to similarity: higher is better, as on the linear path.
        let score = 1.0 - distance;
        if score < threshold {
            continue;
        }

        results.push(SearchResult {
            id,
            text,
            score: Some(score),
            file_id,
            chunk_file_order,
        });
    }

    println!("[VectorDB] ANN search returned {} results", results.len());
    Ok(results)
}

fn search_linear(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
    threshold: f32,
    file_ids: Option<Vec<String>>,
) -> Result<Vec<SearchResult>, VectorDBError> {
    let (query, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(ids) = file_ids {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query_str = format!(
            "SELECT c.id, c.text, c.embedding, c.file_id, c.chunk_file_order
             FROM chunks c
             WHERE c.file_id IN ({})",
            placeholders
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for id in ids {
            params.push(Box::new(id));
        }
        (query_str, params)
    } else {
        (
            "SELECT c.id, c.text, c.embedding, c.file_id, c.chunk_file_order
             FROM chunks c".to_string(),
            Vec::new()
        )
    };

    let mut stmt = conn.prepare(&query)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mut rows = if param_refs.is_empty() {
        stmt.query([])?
    } else {
        stmt.query(&*param_refs)?
    };
    let mut results: Vec<SearchResult> = Vec::new();
    let mut skipped = 0usize;

    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let text: String = row.get(1)?;
        let embedding_bytes: Vec<u8> = row.get(2)?;
        let file_id: String = row.get(3)?;
        let chunk_file_order: i64 = row.get(4)?;

        let emb = from_le_bytes_vec(&embedding_bytes);
        // A chunk stored at another dimension (the embedding model changed
        // under an existing collection) cannot be compared; skip it rather
        // than failing the search for every chunk that can (Jozkah/jan#246).
        if emb.len() != query_embedding.len() {
            skipped += 1;
            continue;
        }
        let score = cosine_similarity(query_embedding, &emb)?;

        if score >= threshold {
            results.push(SearchResult {
                id,
                text,
                score: Some(score),
                file_id,
                chunk_file_order,
            });
            // Keep memory bounded to O(limit) instead of every chunk above
            // the threshold.
            if results.len() >= limit.saturating_mul(2).max(64) {
                results.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                results.truncate(limit);
            }
        }
    }

    results.sort_by(|a, b| {
        match (b.score, a.score) {
            (Some(b_score), Some(a_score)) => b_score.partial_cmp(&a_score).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
    let take: Vec<SearchResult> = results.into_iter().take(limit).collect();
    if skipped > 0 {
        println!(
            "[VectorDB] Linear search skipped {skipped} chunk(s) stored at another dimension; re-index to include them"
        );
    }
    println!("[VectorDB] Linear search returned {} results", take.len());
    Ok(take)
}

// ============================================================================
// List Operations
// ============================================================================

pub fn list_attachments(
    conn: &Connection,
    limit: Option<usize>,
) -> Result<Vec<AttachmentFileInfo>, VectorDBError> {
    // A database made before the mtime column existed is read as-is: listing
    // never migrates, and its rows report no mtime.
    let has_mtime = conn
        .prepare("SELECT 1 FROM pragma_table_info('files') WHERE name = 'mtime'")?
        .exists([])?;
    let mtime_col = if has_mtime { "mtime" } else { "NULL" };
    let query = if let Some(lim) = limit {
        format!("SELECT id, path, name, type, size, chunk_count, {} FROM files LIMIT {}", mtime_col, lim)
    } else {
        format!("SELECT id, path, name, type, size, chunk_count, {} FROM files", mtime_col)
    };

    let mut stmt = conn.prepare(&query)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();

    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let path: Option<String> = row.get(1)?;
        let name: Option<String> = row.get(2)?;
        let file_type: Option<String> = row.get(3)?;
        let size: Option<i64> = row.get(4)?;
        let chunk_count: i64 = row.get(5)?;
        let mtime: Option<i64> = row.get(6)?;
        out.push(AttachmentFileInfo {
            id,
            name,
            path,
            file_type,
            size,
            chunk_count,
            mtime,
            replaced: false,
        });
    }

    Ok(out)
}

// ============================================================================
// Delete Operations
// ============================================================================

pub fn delete_chunks(conn: &Connection, ids: Vec<String>) -> Result<(), VectorDBError> {
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        delete_vec_rows(&tx, "id = ?1", &id);
        tx.execute("DELETE FROM chunks WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(())
}

// ============================================================================
// Get Chunks by Order
// ============================================================================

pub fn get_chunks(
    conn: &Connection,
    file_id: String,
    start_order: i64,
    end_order: i64,
) -> Result<Vec<SearchResult>, VectorDBError> {
    let mut stmt = conn.prepare(
        "SELECT id, text, chunk_file_order FROM chunks
         WHERE file_id = ?1 AND chunk_file_order >= ?2 AND chunk_file_order <= ?3
         ORDER BY chunk_file_order
         LIMIT 200"
    )?;
    let mut rows = stmt.query(params![&file_id, start_order, end_order])?;

    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
        results.push(SearchResult {
            id: row.get(0)?,
            text: row.get(1)?,
            score: None,
            file_id: file_id.clone(),
            chunk_file_order: row.get(2)?,
        });
    }

    Ok(results)
}

// ============================================================================
// Utility Operations
// ============================================================================

pub const MAX_CHUNK_SIZE: usize = 100_000;
pub const MAX_CHUNKS: usize = 20_000;

/// Split `text` into windows of `chunk_size` characters that overlap by
/// `chunk_overlap`. Offsets are char-boundary byte offsets; no per-char vector.
pub fn chunk_text(
    text: String,
    chunk_size: usize,
    chunk_overlap: usize,
) -> Result<Vec<String>, VectorDBError> {
    if chunk_size == 0 || chunk_size > MAX_CHUNK_SIZE {
        return Err(VectorDBError::InvalidInput(format!(
            "chunk_size must be between 1 and {MAX_CHUNK_SIZE}"
        )));
    }
    if chunk_overlap >= chunk_size {
        return Err(VectorDBError::InvalidInput(
            "chunk_overlap must be smaller than chunk_size".into(),
        ));
    }
    let step = chunk_size - chunk_overlap;
    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < text.len() {
        let rest = &text[start..];
        let (end, last) = match rest.char_indices().nth(chunk_size) {
            Some((i, _)) => (start + i, false),
            None => (text.len(), true),
        };
        if chunks.len() >= MAX_CHUNKS {
            return Err(VectorDBError::InvalidInput(format!(
                "text would produce more than {MAX_CHUNKS} chunks"
            )));
        }
        chunks.push(text[start..end].to_string());
        if last {
            break;
        }
        start += rest.char_indices().nth(step).map(|(i, _)| i).unwrap_or(rest.len());
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_path_rejects_drive_relative_name() {
        let base = Path::new("base");
        for bad in ["C:evil", "..", "a/b", "a\\b", "CON", "nul.x", "", ".hidden", "a b"] {
            assert!(collection_path(base, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn collection_path_accepts_real_ids() {
        let base = Path::new("base");
        for ok in ["attachments_0a1b-2c", "project_123e4567-e89b", "__memory__", "__status__"] {
            let p = collection_path(base, ok).unwrap();
            assert_eq!(p.parent(), Some(base));
            assert_eq!(p.file_name().unwrap().to_string_lossy(), format!("{ok}.db"));
        }
    }

    #[test]
    fn delete_collection_removes_wal_and_shm() {
        let dir = std::env::temp_dir().join(format!("vdb-del-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for ext in ["db", "db-wal", "db-shm", "db-journal"] {
            fs::write(dir.join(format!("c1.{ext}")), b"x").unwrap();
        }
        delete_collection_files(&dir, "c1").unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Missing files are fine.
        delete_collection_files(&dir, "c1").unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn delete_collection_errors_when_file_locked() {
        let dir = std::env::temp_dir().join(format!("vdb-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("locked.db");
        let _held = fs::File::create(&path).unwrap();
        assert!(delete_collection_files(&dir, "locked").is_err());
        drop(_held);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn chunk_text_rejects_overlap_ge_size() {
        assert!(chunk_text("abcdef".into(), 3, 3).is_err());
        assert!(chunk_text("abcdef".into(), 3, 9).is_err());
        assert!(chunk_text("abcdef".into(), 0, 0).is_err());
    }

    #[test]
    fn chunk_text_multibyte_boundaries() {
        let out = chunk_text("héllo wörld ✓✓".into(), 4, 1).unwrap();
        assert_eq!(out[0], "héll");
        assert_eq!(out[1], "lo w");
        assert!(out.iter().all(|c| c.chars().count() <= 4));
        assert_eq!(out.last().unwrap(), "✓✓");
    }

    #[test]
    fn chunk_text_caps_chunk_count() {
        let text = "a".repeat(MAX_CHUNKS + 5);
        assert!(chunk_text(text, 1, 0).is_err());
    }

    #[test]
    fn static_vec0_knn_works_on_fresh_connection() {
        assert!(register_static_vec());
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(vector_search_backend(&conn), "vec0");
        let v: String = conn.query_row("select vec_version()", [], |r| r.get(0)).unwrap();
        assert!(v.starts_with('v'), "vec_version = {v}");
        conn.execute("CREATE VIRTUAL TABLE t USING vec0(embedding float[3])", []).unwrap();
        for (id, e) in [(1, "[1,0,0]"), (2, "[0,1,0]"), (3, "[0.9,0.1,0]")] {
            conn.execute("INSERT INTO t(rowid, embedding) VALUES (?1, ?2)", params![id, e]).unwrap();
        }
        let mut st = conn
            .prepare("SELECT rowid, distance FROM t WHERE embedding MATCH ?1 AND k = 2 ORDER BY distance")
            .unwrap();
        let rows: Vec<(i64, f64)> = st
            .query_map(["[1,0,0]"], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 3]);
        assert!(rows[0].1 < 1e-6);
    }

    // AppImage: exe in usr/bin, resources in usr/lib/<product>. The resource
    // folder copy must come before the exe-relative guess and system dirs.
    #[test]
    fn resource_dir_is_tried_before_exe_relative_and_system_paths() {
        let res = PathBuf::from("/tmp/.mount_flint/usr/lib/Flint");
        let paths = build_sqlite_vec_paths(
            None,
            Some(res.clone()),
            Some(PathBuf::from("/tmp/.mount_flint/usr/bin/flint")),
        );
        let bundled = bundled_vec_path(&res);
        assert_eq!(paths.first(), Some(&bundled), "{paths:?}");
        let exe_rel = bundled_vec_path(std::path::Path::new("/tmp/.mount_flint/usr/bin"));
        let exe_pos = paths.iter().position(|p| *p == exe_rel).expect("exe-relative fallback kept");
        let sys_pos = paths
            .iter()
            .position(|p| SQLITE_VEC_SYSTEM_DIRS.iter().any(|dir| p.starts_with(dir)))
            .expect("system fallback kept");
        assert!(exe_pos > 0 && sys_pos > exe_pos, "{paths:?}");
    }

    #[test]
    fn override_still_beats_resource_dir() {
        let paths = build_sqlite_vec_paths(
            Some("/custom/vec".to_string()),
            Some(PathBuf::from("/res")),
            None,
        );
        assert_eq!(paths[0], "/custom/vec");
        assert_eq!(paths[1], bundled_vec_path(std::path::Path::new("/res")));
    }

    #[test]
    fn override_takes_priority_over_every_other_candidate() {
        let paths = build_sqlite_vec_paths(Some("/custom/vec".to_string()), Some(PathBuf::from("/res")), None);
        assert_eq!(paths.first().map(String::as_str), Some("/custom/vec"));
    }

    #[test]
    fn blank_override_is_ignored() {
        let paths = build_sqlite_vec_paths(Some("   ".to_string()), None, None);
        assert!(!paths.iter().any(|p| p.trim().is_empty()), "{paths:?}");
    }

    #[test]
    fn bundled_paths_are_searched_before_system_paths() {
        let paths = build_sqlite_vec_paths(None, None, Some(PathBuf::from("/opt/jan/bin/jan")));
        let bundled = paths
            .iter()
            .position(|p| p.contains("resources"))
            .expect("a bundled candidate should exist");
        let system = paths
            .iter()
            // By the platform's own system directories: on Windows they are
            // `C:\...`, so an absolute-Unix-path check finds none there.
            .position(|p| SQLITE_VEC_SYSTEM_DIRS.iter().any(|dir| p.starts_with(dir)))
            .expect("a system candidate should exist");
        assert!(bundled < system, "{paths:?}");
    }

    // A package-manager install covers platforms the bundle has no library for.
    #[test]
    fn searches_system_library_directories() {
        let paths = build_sqlite_vec_paths(None, None, None);
        assert!(
            paths.iter().any(|p| p.starts_with("/usr/")
                || p.starts_with("/opt/")
                || p.starts_with("C:\\")),
            "{paths:?}"
        );
    }

    // A bare stem or a CWD-relative path would let the loader pick up a library
    // from the launch directory or PATH.
    #[test]
    fn never_offers_bare_or_cwd_relative_candidates() {
        let paths = build_sqlite_vec_paths(None, None, Some(PathBuf::from("/opt/jan/bin/jan")));
        for p in &paths {
            assert!(
                std::path::Path::new(p).is_absolute() || p.starts_with('/'),
                "relative candidate {p}"
            );
        }
    }

    #[test]
    fn candidates_are_unique() {
        let paths = build_sqlite_vec_paths(None, None, Some(PathBuf::from("/opt/jan/bin/jan")));
        let mut seen = paths.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), paths.len(), "duplicate candidates in {paths:?}");
    }

    #[test]
    fn serializes_a_finite_embedding() {
        assert_eq!(embedding_to_json(&[0.5, -0.25]).unwrap(), "[0.5,-0.25]");
    }

    // serde_json writes a non-finite float as `null`, which sqlite-vec rejects
    // with an opaque "JSON parsing error". Catch it here with a usable message.
    #[test]
    fn rejects_non_finite_values() {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let err = embedding_to_json(&[0.1, bad, 0.3]).unwrap_err();
            let msg = err.to_string();
            assert!(matches!(err, VectorDBError::InvalidInput(_)), "{msg}");
            assert!(msg.contains("index 1"), "{msg}");
        }
        assert_eq!(serde_json::to_string(&f32::NAN).unwrap(), "null");
    }

    // How a non-finite value reaches us at all: a JSON number past f32::MAX is
    // cast, not rejected, so an embedding of 1e39 arrives over IPC as infinity.
    #[test]
    fn json_numbers_past_f32_max_arrive_as_infinity() {
        assert_eq!(
            serde_json::from_str::<Vec<f32>>("[1e39]").unwrap(),
            vec![f32::INFINITY]
        );
    }

    // The linear path has no JSON step, so it needs its own guard or a NaN
    // query silently returns zero matches instead of reporting the bad vector.
    #[test]
    fn linear_search_rejects_a_non_finite_query() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        let err = search_collection(
            &conn,
            &[0.1, f32::NAN, 0.3],
            5,
            0.0,
            Some("linear".to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, VectorDBError::InvalidInput(_)), "{err}");
    }

    /// Jozkah/jan#246: one chunk stored at another dimension (an embedding
    /// model changed mid-collection) must not fail the whole search; the
    /// matching chunks are still found.
    #[test]
    fn linear_search_skips_a_chunk_of_another_dimension() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        conn.execute("INSERT INTO files (id, path) VALUES ('f1', '/f1')", []).unwrap();
        insert_chunks(
            &conn,
            "f1",
            vec![MinimalChunkInput { text: "good".to_string(), embedding: vec![0.1, 0.2, 0.3] }],
            false,
        )
        .unwrap();
        let odd: Vec<u8> = [0.5f32, 0.5].iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO chunks (id, text, embedding, file_id, chunk_file_order) VALUES ('odd', 'odd', ?1, 'f1', 99)",
            [odd],
        )
        .unwrap();
        let found = search_collection(&conn, &[0.1, 0.2, 0.3], 5, 0.0, Some("linear".to_string()), false, None)
            .expect("one bad chunk must not fail the search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "good");
    }

    fn temp_file(tag: &str, body: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("flint-vdb-cf-{tag}-{}", std::process::id()));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn create_file_same_size_mtime_returns_existing() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        let path = temp_file("same", b"hello");
        let p = path.to_str().unwrap();
        let first = create_file(&conn, p, Some("a"), None, None).unwrap();
        insert_chunks(
            &conn,
            &first.id,
            vec![MinimalChunkInput { text: "x".to_string(), embedding: vec![0.1, 0.2, 0.3] }],
            false,
        )
        .unwrap();
        let second = create_file(&conn, p, Some("a"), None, None).unwrap();
        assert_eq!(second.id, first.id);
        assert!(!second.replaced);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_file_changed_replaces_chunks() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        let path = temp_file("changed", b"hello");
        let p = path.to_str().unwrap();
        let first = create_file(&conn, p, Some("a"), None, None).unwrap();
        insert_chunks(
            &conn,
            &first.id,
            vec![MinimalChunkInput { text: "x".to_string(), embedding: vec![0.1, 0.2, 0.3] }],
            false,
        )
        .unwrap();
        std::fs::write(&path, b"hello, much longer now").unwrap();
        let second = create_file(&conn, p, Some("a"), None, None).unwrap();
        assert_eq!(second.id, first.id);
        assert!(second.replaced);
        assert_eq!(second.chunk_count, 0);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the stale chunks must be gone");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_migration_adds_mtime_to_old_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT, type TEXT, size INTEGER, chunk_count INTEGER DEFAULT 0)",
            [],
        )
        .unwrap();
        create_schema(&conn, 3).unwrap();
        // Running it again must not fail on the existing column.
        create_schema(&conn, 3).unwrap();
        let has: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('files') WHERE name = 'mtime'")
            .unwrap()
            .exists([])
            .unwrap();
        assert!(has);
    }

    #[test]
    fn list_attachments_reports_the_indexed_mtime() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        let path = temp_file("listmtime", b"hello");
        let p = path.to_str().unwrap();
        let created = create_file(&conn, p, Some("a"), None, None).unwrap();
        assert!(created.mtime.is_some());
        let listed = list_attachments(&conn, None).unwrap();
        assert_eq!(listed[0].mtime, created.mtime);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_attachments_reads_a_db_without_the_mtime_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT, type TEXT, size INTEGER, chunk_count INTEGER DEFAULT 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO files (id, path, size) VALUES ('f1', '/x', 5)", [])
            .unwrap();
        let listed = list_attachments(&conn, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mtime, None);
    }

    #[test]
    fn get_chunks_has_limit() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        conn.execute("INSERT INTO files (id, path) VALUES ('f1', '/f1')", []).unwrap();
        let chunks: Vec<MinimalChunkInput> = (0..250)
            .map(|i| MinimalChunkInput { text: format!("c{i}"), embedding: vec![0.1, 0.2, 0.3] })
            .collect();
        insert_chunks(&conn, "f1", chunks, false).unwrap();
        let got = get_chunks(&conn, "f1".to_string(), 0, 1_000_000).unwrap();
        assert_eq!(got.len(), 200);
    }

    #[test]
    fn insert_rejects_a_non_finite_embedding() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn, 3).unwrap();
        let err = insert_chunks(
            &conn,
            "f1",
            vec![MinimalChunkInput {
                text: "hello".to_string(),
                embedding: vec![0.1, f32::INFINITY, 0.3],
            }],
            false,
        )
        .unwrap_err();
        assert!(matches!(err, VectorDBError::InvalidInput(_)), "{err}");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_an_empty_embedding() {
        assert!(matches!(
            embedding_to_json(&[]).unwrap_err(),
            VectorDBError::InvalidInput(_)
        ));
    }
}

// ============================================================================
// Project-scoped agent memory (FTS5 / BM25)
// ============================================================================

/// Single global collection file holding all agent memories, isolated per
/// project via the `project_id` column.
pub const MEMORY_COLLECTION: &str = "__memory__";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryHit {
    pub msg_id: String,
    pub project_id: String,
    pub text: String,
    pub role: String,
    pub ts: i64,
    pub score: f32,
}

/// FTS5 virtual table. `project_id` is UNINDEXED (filter column, not a search
/// term). Porter stemming + unicode61 folding for lexical recall.
pub fn ensure_memory_table(conn: &Connection) -> Result<(), VectorDBError> {
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories USING fts5(
            msg_id UNINDEXED,
            project_id UNINDEXED,
            text,
            role UNINDEXED,
            ts UNINDEXED,
            tokenize = 'porter unicode61'
        )",
        [],
    )?;
    // Per-project key -> FTS rowid map so re-indexing deletes only the row of
    // the same (project, message), never another project's row.
    let keys_existed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_keys')",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memory_keys (
            project_id TEXT NOT NULL,
            msg_id TEXT NOT NULL,
            fts_rowid INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (project_id, msg_id)
        )",
        [],
    )?;
    if !keys_existed {
        // One-time backfill for stores created before this table existed.
        conn.execute(
            "INSERT OR REPLACE INTO memory_keys (project_id, msg_id, fts_rowid, ts)
             SELECT project_id, msg_id, rowid, CAST(ts AS INTEGER) FROM memories",
            [],
        )?;
    }
    Ok(())
}

/// Most memories kept per project; the oldest are evicted first.
const MEMORY_PER_PROJECT_CAP: i64 = 20_000;

/// Sanitize raw user text into a safe FTS5 MATCH expression: alphanumeric terms
/// (>=2 chars) quoted and OR-joined, so FTS5 operators in the input cannot raise
/// a syntax error. Returns None when nothing indexable remains.
fn build_fts_match(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .map(|t| format!("\"{}\"", t.to_lowercase()))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

/// Idempotent index keyed by (project_id, msg_id): re-indexing an edited
/// message replaces its row in the same project only.
pub fn memory_index(
    conn: &Connection,
    msg_id: &str,
    project_id: &str,
    text: &str,
    role: &str,
    ts: i64,
) -> Result<(), VectorDBError> {
    memory_index_capped(conn, msg_id, project_id, text, role, ts, MEMORY_PER_PROJECT_CAP)
}

fn memory_index_capped(
    conn: &Connection,
    msg_id: &str,
    project_id: &str,
    text: &str,
    role: &str,
    ts: i64,
    cap: i64,
) -> Result<(), VectorDBError> {
    ensure_memory_table(conn)?;
    // IMMEDIATE so two connections cannot interleave the read-then-write.
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<(), VectorDBError> {
        let old: Option<i64> = conn
            .query_row(
                "SELECT fts_rowid FROM memory_keys WHERE project_id = ?1 AND msg_id = ?2",
                params![project_id, msg_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(rowid) = old {
            conn.execute("DELETE FROM memories WHERE rowid = ?1", params![rowid])?;
        }
        conn.execute(
            "INSERT INTO memories (msg_id, project_id, text, role, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![msg_id, project_id, text, role, ts],
        )?;
        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT OR REPLACE INTO memory_keys (project_id, msg_id, fts_rowid, ts) VALUES (?1, ?2, ?3, ?4)",
            params![project_id, msg_id, rowid, ts],
        )?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memory_keys WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        if count > cap {
            let mut stmt = conn.prepare(
                "SELECT fts_rowid FROM memory_keys WHERE project_id = ?1
                 ORDER BY ts ASC, fts_rowid ASC LIMIT ?2",
            )?;
            let victims = stmt
                .query_map(params![project_id, count - cap], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for v in victims {
                conn.execute("DELETE FROM memories WHERE rowid = ?1", params![v])?;
                conn.execute(
                    "DELETE FROM memory_keys WHERE project_id = ?1 AND fts_rowid = ?2",
                    params![project_id, v],
                )?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// BM25-ranked recall scoped to a single project. Best match first (bm25 is more
/// negative = more relevant), recency breaks ties.
pub fn memory_search(
    conn: &Connection,
    project_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<MemoryHit>, VectorDBError> {
    ensure_memory_table(conn)?;
    let match_expr = match build_fts_match(query) {
        Some(m) => m,
        None => return Ok(Vec::new()),
    };
    let mut stmt = conn.prepare(
        "SELECT msg_id, project_id, text, role, ts, bm25(memories) AS score
         FROM memories
         WHERE project_id = ?1 AND memories MATCH ?2
         ORDER BY score ASC, ts DESC
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![project_id, match_expr, top_k as i64], |r| {
        Ok(MemoryHit {
            msg_id: r.get(0)?,
            project_id: r.get(1)?,
            text: r.get(2)?,
            role: r.get(3)?,
            ts: r.get(4)?,
            score: r.get::<_, f64>(5)? as f32,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Clear memories: a single project when `project_id` is given, else all.
pub fn memory_clear(conn: &Connection, project_id: Option<&str>) -> Result<(), VectorDBError> {
    ensure_memory_table(conn)?;
    match project_id {
        Some(pid) => {
            conn.execute("DELETE FROM memories WHERE project_id = ?1", params![pid])?;
            conn.execute("DELETE FROM memory_keys WHERE project_id = ?1", params![pid])?
        }
        None => {
            conn.execute("DELETE FROM memories", [])?;
            conn.execute("DELETE FROM memory_keys", [])?
        }
    };
    Ok(())
}

#[cfg(test)]
mod memory_tests {
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        ensure_memory_table(&conn).expect("fts5 memory table");
        conn
    }

    #[test]
    fn bundled_sqlite_ships_fts5() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute(
            "CREATE VIRTUAL TABLE t USING fts5(content)",
            [],
        )
        .expect("bundled rusqlite must ship FTS5");
    }

    #[test]
    fn index_and_bm25_recall() {
        let conn = mem_conn();
        memory_index(&conn, "m1", "p1", "the quick brown fox jumps", "user", 100).unwrap();
        memory_index(&conn, "m2", "p1", "lazy dogs sleep all day", "user", 200).unwrap();

        let hits = memory_search(&conn, "p1", "brown fox", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].msg_id, "m1");
    }

    #[test]
    fn reindex_by_msg_id_is_idempotent() {
        let conn = mem_conn();
        memory_index(&conn, "m1", "p1", "original text about apples", "user", 100).unwrap();
        memory_index(&conn, "m1", "p1", "revised text about oranges", "user", 150).unwrap();

        assert!(memory_search(&conn, "p1", "apples", 5).unwrap().is_empty());
        let hits = memory_search(&conn, "p1", "oranges", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "revised text about oranges");
    }

    #[test]
    fn search_is_project_isolated() {
        let conn = mem_conn();
        memory_index(&conn, "a", "projectA", "shared keyword alpha", "user", 100).unwrap();
        memory_index(&conn, "b", "projectB", "shared keyword alpha", "user", 100).unwrap();

        let hits = memory_search(&conn, "projectA", "keyword", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].project_id, "projectA");
    }

    #[test]
    fn recency_breaks_score_ties() {
        let conn = mem_conn();
        memory_index(&conn, "old", "p1", "duplicate phrase here", "user", 100).unwrap();
        memory_index(&conn, "new", "p1", "duplicate phrase here", "user", 200).unwrap();

        let hits = memory_search(&conn, "p1", "duplicate phrase", 5).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].msg_id, "new");
    }

    #[test]
    fn operator_injection_is_safe() {
        let conn = mem_conn();
        memory_index(&conn, "m1", "p1", "normal indexed content", "user", 100).unwrap();
        // Raw FTS5 operators in the query must not raise a syntax error.
        let hits = memory_search(&conn, "p1", "content AND (OR* NEAR/2 \"", 5).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn same_msg_id_in_two_projects_does_not_collide() {
        let conn = mem_conn();
        memory_index(&conn, "m1", "p1", "alpha content", "user", 100).unwrap();
        memory_index(&conn, "m1", "p2", "beta content", "user", 100).unwrap();
        assert_eq!(memory_search(&conn, "p1", "alpha", 5).unwrap().len(), 1);
        assert_eq!(memory_search(&conn, "p2", "beta", 5).unwrap().len(), 1);
    }

    #[test]
    fn reindex_replaces_row_in_same_project() {
        let conn = mem_conn();
        memory_index(&conn, "m1", "p1", "first version", "user", 100).unwrap();
        memory_index(&conn, "m1", "p1", "second version", "user", 200).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM memories WHERE project_id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert!(memory_search(&conn, "p1", "first", 5).unwrap().is_empty());
    }

    #[test]
    fn memory_clear_clears_keys() {
        let conn = mem_conn();
        memory_index(&conn, "a", "p1", "content one", "user", 100).unwrap();
        memory_index(&conn, "b", "p2", "content two", "user", 100).unwrap();
        memory_clear(&conn, Some("p1")).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        memory_clear(&conn, None).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn cap_evicts_oldest() {
        let conn = mem_conn();
        for (i, ts) in [(1, 100), (2, 200), (3, 300), (4, 400)] {
            memory_index_capped(&conn, &format!("m{i}"), "p1", "capped content", "user", ts, 3).unwrap();
        }
        let hits = memory_search(&conn, "p1", "capped", 10).unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|h| h.msg_id != "m1"));
    }

    #[test]
    fn backfill_populates_keys_for_existing_rows() {
        // Legacy store: FTS table only, no memory_keys.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE VIRTUAL TABLE memories USING fts5(
                msg_id UNINDEXED, project_id UNINDEXED, text, role UNINDEXED, ts UNINDEXED,
                tokenize = 'porter unicode61')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (msg_id, project_id, text, role, ts) VALUES ('m1','p1','legacy words','user',100)",
            [],
        )
        .unwrap();
        ensure_memory_table(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Re-indexing the legacy message replaces it rather than duplicating.
        memory_index(&conn, "m1", "p1", "updated words", "user", 200).unwrap();
        assert_eq!(memory_search(&conn, "p1", "legacy", 5).unwrap().len(), 0);
        assert_eq!(memory_search(&conn, "p1", "updated", 5).unwrap().len(), 1);
    }

    #[test]
    fn clear_all_and_per_project() {
        let conn = mem_conn();
        memory_index(&conn, "a", "p1", "content one", "user", 100).unwrap();
        memory_index(&conn, "b", "p2", "content two", "user", 100).unwrap();

        memory_clear(&conn, Some("p1")).unwrap();
        assert!(memory_search(&conn, "p1", "content", 5).unwrap().is_empty());
        assert_eq!(memory_search(&conn, "p2", "content", 5).unwrap().len(), 1);

        memory_clear(&conn, None).unwrap();
        assert!(memory_search(&conn, "p2", "content", 5).unwrap().is_empty());
    }

    /// An in-memory collection with sqlite-vec, or None when it is unavailable.
    fn ann_conn(dim: usize) -> Option<Connection> {
        if !register_static_vec() {
            return None;
        }
        let conn = Connection::open_in_memory().unwrap();
        if !create_schema(&conn, dim).unwrap() {
            return None;
        }
        conn.execute("INSERT INTO files (id, path) VALUES ('f1', '/f1')", []).unwrap();
        Some(conn)
    }

    fn sample_vectors(n: usize) -> Vec<Vec<f32>> {
        (0..n)
            .map(|i| {
                let t = i as f32 * 0.37 + 0.1;
                vec![t.sin(), t.cos(), (t * 0.5).sin() + 1.5]
            })
            .collect()
    }

    fn add(conn: &Connection, vectors: &[Vec<f32>]) -> Result<(), VectorDBError> {
        let chunks = vectors
            .iter()
            .enumerate()
            .map(|(i, v)| MinimalChunkInput { text: format!("c{i}"), embedding: v.clone() })
            .collect();
        insert_chunks(conn, "f1", chunks, true)
    }

    #[test]
    fn ann_and_linear_same_order_and_score_range() {
        let Some(conn) = ann_conn(3) else { return };
        let vectors = sample_vectors(20);
        add(&conn, &vectors).unwrap();
        let q = [0.3f32, 0.9, 1.2];
        let ann = search_collection(&conn, &q, 5, -1.0, Some("ann".into()), true, None).unwrap();
        let lin = search_collection(&conn, &q, 5, -1.0, Some("linear".into()), true, None).unwrap();
        assert_eq!(ann.len(), 5);
        let ids = |r: &[SearchResult]| r.iter().map(|x| x.text.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&ann), ids(&lin));
        for (a, l) in ann.iter().zip(lin.iter()) {
            assert!((a.score.unwrap() - l.score.unwrap()).abs() < 1e-3);
        }
    }

    #[test]
    fn ann_applies_threshold() {
        let Some(conn) = ann_conn(3) else { return };
        add(&conn, &[vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]]).unwrap();
        let found =
            search_collection(&conn, &[1.0, 0.0, 0.0], 5, 0.5, Some("ann".into()), true, None).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "c0");
        assert!(found[0].score.unwrap() > 0.99);
    }

    #[test]
    fn ann_insert_failure_is_error_not_silent() {
        let Some(conn) = ann_conn(3) else { return };
        let err = add(&conn, &[vec![1.0, 0.0]]).unwrap_err();
        assert!(matches!(err, VectorDBError::DimensionMismatch(_)), "{err}");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn dimension_change_rebuilds_vec_table() {
        let Some(conn) = ann_conn(3) else { return };
        add(&conn, &[vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]]).unwrap();
        // The model changed to 2 dimensions: the 3-d chunks stay in `chunks`
        // but cannot be indexed, and new 2-d chunks can.
        assert!(create_schema(&conn, 2).unwrap());
        assert!(vec_table_sql(&conn).unwrap().contains("float[2]"));
        let two = vec![MinimalChunkInput { text: "two".into(), embedding: vec![1.0, 0.0] }];
        insert_chunks(&conn, "f1", two, true).unwrap();
        let found =
            search_collection(&conn, &[1.0, 0.0], 5, 0.5, Some("ann".into()), true, None).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "two");
    }

    #[test]
    fn legacy_l2_table_rebuilt_or_linear() {
        if !register_static_vec() {
            return;
        }
        let conn = Connection::open_in_memory().unwrap();
        assert!(try_load_sqlite_vec(&conn));
        // Collection as an earlier build left it: L2 vec table, chunks present.
        create_schema(&conn, 3).unwrap();
        conn.execute("DROP TABLE chunks_vec", []).unwrap();
        conn.execute("CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[3])", []).unwrap();
        conn.execute("INSERT INTO files (id, path) VALUES ('f1', '/f1')", []).unwrap();
        let blob = to_le_bytes_vec(&[1.0f32, 0.0, 0.0]);
        conn.execute(
            "INSERT INTO chunks (id, text, embedding, file_id, chunk_file_order) VALUES ('x', 'x', ?1, 'f1', 0)",
            [blob],
        )
        .unwrap();
        assert!(!cosine_vec_table_exists(&conn));
        // Searching before the rebuild takes the linear path.
        let found = search_collection(&conn, &[1.0, 0.0, 0.0], 5, 0.5, None, true, None).unwrap();
        assert_eq!(found.len(), 1);
        // Reopening the collection rebuilds the index as cosine from `chunks`.
        assert!(create_schema(&conn, 3).unwrap());
        assert!(cosine_vec_table_exists(&conn));
        let found =
            search_collection(&conn, &[1.0, 0.0, 0.0], 5, 0.5, Some("ann".into()), true, None).unwrap();
        assert_eq!(found.len(), 1);
    }
}
