//! A short-lived cache for the device list.
//!
//! The settings screen asks for the devices on every render, and each ask
//! spawns the worker with `--list-devices` (it loads every ggml backend, so it
//! is slow and touches the GPU). The answer only changes when the engine, the
//! add-on or the environment does, all of which are part of the key.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a device list is trusted.
pub const DEVICE_TTL: Duration = Duration::from_secs(60);

/// A TTL cache keyed by the string that identifies one enumeration.
pub struct DeviceCache<T> {
    entries: Mutex<HashMap<String, (Instant, T)>>,
}

impl<T: Clone> DeviceCache<T> {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    /// The cached value for `key` if it is younger than `ttl` at `now`.
    pub fn get(&self, key: &str, now: Instant, ttl: Duration) -> Option<T> {
        let guard = self.entries.lock().ok()?;
        let (at, value) = guard.get(key)?;
        (now.saturating_duration_since(*at) < ttl).then(|| value.clone())
    }

    pub fn put(&self, key: String, now: Instant, value: T) {
        if let Ok(mut guard) = self.entries.lock() {
            // A handful of keys at most; bounded anyway so a churn of envs
            // cannot grow it.
            if guard.len() >= 8 {
                guard.clear();
            }
            guard.insert(key, (now, value));
        }
    }

    /// Returns the cached value, or runs `run` and caches a success.
    pub async fn get_or_run<E, F, Fut>(
        &self,
        key: String,
        now: Instant,
        ttl: Duration,
        run: F,
    ) -> Result<T, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        if let Some(hit) = self.get(&key, now, ttl) {
            return Ok(hit);
        }
        let value = run().await?;
        self.put(key, Instant::now(), value.clone());
        Ok(value)
    }
}

impl<T: Clone> Default for DeviceCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// The key for one enumeration: the engine file (path and mtime, so an
/// update replaces it) and the sorted environment (the add-on directory is in
/// there, so installing a CUDA pack misses the cache).
pub fn device_key(exe: &std::path::Path, envs: &HashMap<String, String>) -> String {
    let mtime = std::fs::metadata(exe)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut pairs: Vec<(&String, &String)> = envs.iter().collect();
    pairs.sort();
    let mut key = format!("{}|{mtime}", exe.display());
    for (k, v) in pairs {
        key.push('|');
        key.push_str(k);
        key.push('=');
        key.push_str(v);
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn engine_devices_cache_hit_skips_spawn() {
        let cache: DeviceCache<Vec<u32>> = DeviceCache::new();
        let spawns = AtomicU32::new(0);
        let now = Instant::now();
        for _ in 0..3 {
            let got: Result<_, String> = cache
                .get_or_run("k".into(), now, DEVICE_TTL, || async {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![1, 2])
                })
                .await;
            assert_eq!(got.unwrap(), vec![1, 2]);
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn expired_entry_and_other_key_miss() {
        let cache: DeviceCache<u32> = DeviceCache::new();
        let t0 = Instant::now();
        cache.put("a".into(), t0, 1);
        assert_eq!(cache.get("a", t0 + Duration::from_secs(59), DEVICE_TTL), Some(1));
        assert_eq!(cache.get("a", t0 + Duration::from_secs(61), DEVICE_TTL), None);
        assert_eq!(cache.get("b", t0, DEVICE_TTL), None);
    }

    #[tokio::test]
    async fn failures_are_not_cached() {
        let cache: DeviceCache<u32> = DeviceCache::new();
        let r: Result<u32, String> = cache
            .get_or_run("k".into(), Instant::now(), DEVICE_TTL, || async {
                Err("boom".to_string())
            })
            .await;
        assert!(r.is_err());
        assert_eq!(cache.get("k", Instant::now(), DEVICE_TTL), None);
    }

    #[test]
    fn key_changes_with_envs_and_ignores_order() {
        let exe = std::path::Path::new("nope-worker");
        let mut a = HashMap::new();
        a.insert("A".to_string(), "1".to_string());
        a.insert("B".to_string(), "2".to_string());
        let mut b = HashMap::new();
        b.insert("B".to_string(), "2".to_string());
        b.insert("A".to_string(), "1".to_string());
        assert_eq!(device_key(exe, &a), device_key(exe, &b));
        b.insert("FLINT_ENGINE_ADDON_DIR".to_string(), "/x".to_string());
        assert_ne!(device_key(exe, &a), device_key(exe, &b));
    }
}
