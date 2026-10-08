//! Administrator and browser session credentials for headless server mode.
//!
//! The bootstrap credential is 256 random bits, printed once by the CLI. Only
//! its SHA-256 hash is stored. Browser sessions are separate, short-lived
//! bearer secrets whose hashes are stored in the same private file.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SESSION_LIFETIME_SECS: u64 = 12 * 60 * 60;

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredAuth {
    admin_hash: String,
    sessions: Vec<StoredSession>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredSession {
    token_hash: String,
    expires_at: u64,
}

pub struct AuthStore {
    path: PathBuf,
    state: StoredAuth,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.as_bytes()
            .iter()
            .zip(b.as_bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

fn save_private(path: &Path, state: &StoredAuth) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("auth path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    serde_json::to_writer(&mut file, state).map_err(io::Error::other)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

impl AuthStore {
    /// Returns the administrator credential only when a new store was created.
    /// A malformed or unreadable existing store is an error, never a reset.
    pub fn open(path: PathBuf) -> io::Result<(Self, Option<String>)> {
        if path.exists() {
            return Self::load(path).map(|store| (store, None));
        }
        let admin = token();
        let state = StoredAuth {
            admin_hash: hash(&admin),
            sessions: Vec::new(),
        };
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("auth path has no parent"))?;
        fs::create_dir_all(parent)?;
        // Write a complete private file first, then publish it atomically so a
        // crash never leaves a truncated store that blocks every later start.
        let temporary = path.with_extension("init");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, &state).map_err(io::Error::other)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        let published = fs::hard_link(&temporary, &path);
        let _ = fs::remove_file(&temporary);
        match published {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Self::load(path).map(|store| (store, None));
            }
            Err(error) => return Err(error),
        }
        Ok((Self { path, state }, Some(admin)))
    }

    fn load(path: PathBuf) -> io::Result<Self> {
        let state = serde_json::from_slice(&fs::read(&path)?).map_err(io::Error::other)?;
        Ok(Self { path, state })
    }

    pub fn sign_in(&mut self, admin: &str) -> io::Result<Option<String>> {
        if !equal(&hash(admin), &self.state.admin_hash) {
            return Ok(None);
        }
        let session = token();
        let now = now_secs();
        self.state.sessions.retain(|entry| entry.expires_at > now);
        self.state.sessions.push(StoredSession {
            token_hash: hash(&session),
            expires_at: now + SESSION_LIFETIME_SECS,
        });
        save_private(&self.path, &self.state)?;
        Ok(Some(session))
    }

    pub fn authorize(&self, session: &str) -> bool {
        let digest = hash(session);
        let now = now_secs();
        self.state.sessions.iter().fold(false, |valid, entry| {
            valid | (entry.expires_at > now && equal(&entry.token_hash, &digest))
        })
    }

    pub fn sign_out(&mut self, session: &str) -> io::Result<()> {
        let digest = hash(session);
        self.state
            .sessions
            .retain(|entry| !equal(&entry.token_hash, &digest));
        save_private(&self.path, &self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_is_once_and_only_hashes_are_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let (mut store, admin) = AuthStore::open(path.clone()).unwrap();
        let admin = admin.unwrap();
        let session = store.sign_in(&admin).unwrap().unwrap();
        let file = fs::read_to_string(&path).unwrap();
        assert!(!file.contains(&admin));
        assert!(!file.contains(&session));
        assert!(store.authorize(&session));
        let (mut reopened, new_admin) = AuthStore::open(path).unwrap();
        assert!(new_admin.is_none());
        assert!(reopened.authorize(&session));
        reopened.sign_out(&session).unwrap();
        assert!(!reopened.authorize(&session));
        assert!(reopened.sign_in("wrong credential").unwrap().is_none());
    }

    #[test]
    fn corrupted_store_does_not_generate_new_administrator() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        fs::write(&path, b"not json").unwrap();
        assert!(AuthStore::open(path.clone()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"not json");
    }
}
