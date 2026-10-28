use super::types::GgufMetadata;
use super::utils::{
    estimate_kv_cache_internal, find_gguf_tensors_internal, read_gguf_metadata_internal,
};
use crate::gguf::types::ModelSupportStatus;
use std::fs;
use tauri_plugin_hardware::{get_system_info, SystemInfo};

/// Streaming SHA-256 of a file as lowercase hex. Fixed 1 MiB buffer, so a
/// multi-GB gguf never sits in memory.
pub fn sha256_file_hex(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// SHA-256 of a local file, hashed off the async runtime.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn sha256_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        sha256_file_hex(std::path::Path::new(&path))
            .map_err(|e| format!("Failed to hash {path}: {e}"))
    })
    .await
    .map_err(|e| format!("Hash task failed: {e}"))?
}

#[cfg(test)]
mod sha256_tests {
    use super::*;

    #[test]
    fn hashes_known_vector_and_empty_file() {
        let dir = std::env::temp_dir().join(format!("flint-sha-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("abc.bin");
        fs::write(&f, b"abc").unwrap();
        assert_eq!(
            sha256_file_hex(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let e = dir.join("empty.bin");
        fs::write(&e, b"").unwrap();
        assert_eq!(
            sha256_file_hex(&e).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(sha256_file_hex(&dir.join("missing")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hashes_file_larger_than_buffer() {
        let dir = std::env::temp_dir().join(format!("flint-sha-big-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("big.bin");
        let data = vec![7u8; (1 << 20) * 2 + 13];
        fs::write(&f, &data).unwrap();
        use sha2::{Digest, Sha256};
        let want: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(sha256_file_hex(&f).unwrap(), want);
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Read GGUF metadata from a model file
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn read_gguf_metadata(path: String) -> Result<GgufMetadata, String> {
    read_gguf_metadata_internal(path).await
}

/// Which of `names` exist as tensors in a gguf.
///
/// Exact names, not a listing: the questions worth asking are yes/no ones
/// (`markov_w1.weight` marks a DSpark draft, `blk.<n>.nextn.eh_proj.weight` an
/// MTP head), and a listing would put every tensor name of a large model
/// through the IPC boundary to answer one.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn find_gguf_tensors(path: String, names: Vec<String>) -> Result<Vec<String>, String> {
    find_gguf_tensors_internal(path, names).await
}

pub async fn get_model_size(path: String) -> Result<u64, String> {
    if path.starts_with("https://") {
        // Handle remote URL
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        let response = client
            .head(&path)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch HEAD request: {}", e))?;

        if let Some(content_length) = response.headers().get("content-length") {
            let content_length_str = content_length
                .to_str()
                .map_err(|e| format!("Invalid content-length header: {}", e))?;
            content_length_str
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse content-length: {}", e))
        } else {
            Ok(0)
        }
    } else {
        // A split model is several files; llama.cpp loads all of them, so all
        // of them count toward what has to fit in memory.
        let mut total: u64 = 0;
        for shard in gguf_shard_paths(&path) {
            let metadata = fs::metadata(&shard)
                .map_err(|e| format!("Failed to get file metadata for {shard}: {e}"))?;
            total = total.saturating_add(metadata.len());
        }
        Ok(total)
    }
}

/// Every shard of a split GGUF (`name-00001-of-00005.gguf`), whichever shard
/// `path` names; a file that is not a split returns just `[path]`.
pub fn gguf_shard_paths(path: &str) -> Vec<String> {
    let lower = path.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".gguf") else {
        return vec![path.to_string()];
    };
    // "-00002-of-00005" is 15 bytes, all ASCII, so byte indexes line up.
    let tail_len = "-00002-of-00005".len();
    if stem.len() < tail_len || !path.is_char_boundary(stem.len() - tail_len) {
        return vec![path.to_string()];
    }
    let (head_end, tail) = (stem.len() - tail_len, &stem[stem.len() - tail_len..]);
    // A non-ASCII byte in the tail would make the str slices below split a
    // character and panic.
    if !tail.is_ascii() {
        return vec![path.to_string()];
    }
    let b = tail.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if b[0] != b'-' || &b[6..10] != b"-of-" || !digits(1..6) || !digits(10..15) {
        return vec![path.to_string()];
    }
    let total: u32 = tail[10..15].parse().unwrap_or(0);
    if !(2..=999).contains(&total) {
        return vec![path.to_string()];
    }
    let head = &path[..head_end];
    let ext = &path[stem.len()..];
    let total_str = &tail[10..15];
    (1..=total)
        .map(|n| format!("{head}-{n:05}-of-{total_str}{ext}"))
        .collect()
}

/// Bytes that must fit in VRAM: with KV offload disabled the cache lives in
/// system RAM, so only the rest competes for the GPU.
fn vram_required_bytes(total_required: u64, kv_cache_size: u64, no_kv_offload: bool) -> u64 {
    if no_kv_offload {
        total_required.saturating_sub(kv_cache_size)
    } else {
        total_required
    }
}

#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn is_model_supported(
    path: String,
    ctx_size: Option<u32>,
    cache_type_k: Option<String>,
    cache_type_v: Option<String>,
    no_kv_offload: Option<bool>,
) -> Result<ModelSupportStatus, String> {
    let no_kv_offload = no_kv_offload.unwrap_or(false);
    // The metadata lives in shard 1 of a split model, whichever shard was named.
    let path = if path.starts_with("https://") {
        path
    } else {
        gguf_shard_paths(&path).into_iter().next().unwrap_or(path)
    };
    // Get model size
    let model_size = get_model_size(path.clone()).await?;

    // Get system info
    let system_info = get_system_info();

    log::info!("modelSize: {}", model_size);

    // Read GGUF metadata
    let gguf = read_gguf_metadata(path.clone()).await?;

    // Calculate KV cache size
    let kv_cache_size = if let Some(ctx_size) = ctx_size {
        log::info!("Using ctx_size: {}", ctx_size);
        estimate_kv_cache_internal(
            gguf.metadata,
            Some(ctx_size as u64),
            cache_type_k.as_deref(),
            cache_type_v.as_deref(),
        )
        .await
            .map_err(|e| e.to_string())?
            .size
    } else {
        estimate_kv_cache_internal(
            gguf.metadata,
            None,
            cache_type_k.as_deref(),
            cache_type_v.as_deref(),
        )
        .await
            .map_err(|e| e.to_string())?
            .size
    };

    // Multimodal projector lives next to model.gguf as mmproj.gguf and is
    // loaded into the same device alongside the weights + KV cache. Only
    // inspected for local paths — remote URLs route through the importer
    // and won't hit this branch with the final on-disk layout.
    let mmproj_size: u64 = if path.starts_with("https://") {
        0
    } else {
        std::path::Path::new(&path)
            .parent()
            .map(|d| d.join("mmproj.gguf"))
            .and_then(|p| fs::metadata(&p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    };
    if mmproj_size > 0 {
        log::info!("mmprojSize: {}", mmproj_size);
    }

    // Total memory consumption = model weights + kvcache + mmproj
    // Saturating: sizes derived from untrusted GGUF metadata must not wrap (#154).
    let total_required = model_size
        .saturating_add(kv_cache_size)
        .saturating_add(mmproj_size);
    log::info!(
        "isModelSupported: Total memory requirement: {} for {}; kvCacheSize: {}, mmprojSize: {}",
        total_required,
        path,
        kv_cache_size,
        mmproj_size
    );

    // Apple Silicon: macOS + ARM64 + no discrete GPUs = unified memory.
    // The cpu.arch check guards against Intel Macs with no discrete GPU
    // (x86_64) accidentally taking this path.
    if system_info.os_type == "macos"
        && system_info.cpu.arch == "aarch64"
        && system_info.gpus.is_empty()
    {
        return check_apple_silicon_compatibility(&system_info, total_required);
    }

    const RESERVE_BYTES: u64 = 2_288_490_189; // ~2.13 GB driver/runtime overhead

    // An integrated GPU has no memory of its own: its "VRAM" is a slice of
    // system RAM. Counting it as VRAM and then adding system RAM again would
    // count that slice twice, so only discrete GPUs form a separate pool.
    let discrete_gpus: Vec<_> = system_info
        .gpus
        .iter()
        .filter(|g| {
            !g.vulkan_info
                .as_ref()
                .is_some_and(|v| v.device_type == "IntegratedGpu")
        })
        .collect();

    let total_system_memory: u64 = match discrete_gpus.is_empty() {
        // No discrete GPU: treat all RAM as the execution pool, no separate system bucket
        true => 0,
        false => system_info.total_memory * 1024 * 1024,
    };

    // Calculate total VRAM from all discrete GPUs
    let total_vram: u64 = match discrete_gpus.is_empty() {
        true => {
            log::info!("No discrete GPUs detected, using total RAM as VRAM");
            system_info.total_memory * 1024 * 1024
        }
        false => discrete_gpus
            .iter()
            .map(|g| g.total_memory * 1024 * 1024)
            .sum::<u64>(),
    };

    log::info!("Total VRAM reported/calculated (in bytes): {}", total_vram);

    let usable_vram = total_vram.saturating_sub(RESERVE_BYTES);

    let usable_total_memory = if total_system_memory > RESERVE_BYTES {
        (total_system_memory - RESERVE_BYTES) + usable_vram
    } else {
        usable_vram
    };
    log::info!("System RAM: {} bytes", total_system_memory);
    log::info!("Total VRAM: {} bytes", total_vram);
    log::info!("Usable total memory: {} bytes", usable_total_memory);
    log::info!("Usable VRAM: {} bytes", usable_vram);
    log::info!("Required: {} bytes", total_required);

    // Check if model fits in total memory at all (this is the hard limit)
    if total_required > usable_total_memory {
        return Ok(ModelSupportStatus::Red); // Truly impossible to run
    }

    // Check if everything fits in VRAM (ideal case — pure GPU execution)
    if vram_required_bytes(total_required, kv_cache_size, no_kv_offload) <= usable_vram {
        return Ok(ModelSupportStatus::Green);
    }

    // Fits in combined RAM+VRAM but not entirely in VRAM: CPU-GPU hybrid scenario
    Ok(ModelSupportStatus::Yellow)
}

/// Compatibility check for Apple Silicon Macs (unified memory architecture).
///
/// On Apple Silicon, CPU and GPU share a single physical memory pool. Unlike
/// discrete-GPU systems, there is no separate VRAM — the entire pool is used
/// by the OS, Metal GPU runtime, system daemons, AND the model simultaneously.
///
/// The OS overhead is larger and more variable than the fixed 2.13 GB constant
/// used for discrete-GPU systems:
///
///   Fixed component (~2.5 GB):
///     macOS kernel, Spotlight, WindowServer, system daemons, Metal runtime init.
///
///   Variable component (~10% of total pool):
///     Metal GPU wired memory and driver state, which scales with pool size
///     because larger pools allow larger GPU-resident textures and command buffers.
///
/// Observed usable memory on real hardware:
///    8 GB  → ~4.7 GB usable  (41% overhead — OS is proportionally huge on small configs)
///   16 GB  → ~11.9 GB usable (26% overhead)
///   32 GB  → ~26.3 GB usable (18% overhead)
///   64 GB  → ~53.7 GB usable (16% overhead)
///
/// Status mapping:
///   GREEN  — fits with ≥15% spare usable memory; full Metal GPU throughput expected.
///   YELLOW — fits but tight; memory pressure may cause inference slowdowns.
///   RED    — exceeds usable memory; macOS will swap to disk or the process will crash.
fn check_apple_silicon_compatibility(
    system_info: &SystemInfo,
    total_required: u64,
) -> Result<ModelSupportStatus, String> {
    let total_bytes = system_info.total_memory * 1024 * 1024;

    // 2.5 GB: fixed baseline consumed by macOS kernel, daemons, Metal runtime
    const FIXED_OVERHEAD: u64 = 2_684_354_560;
    // 10%: Metal GPU wired memory + driver state, proportional to pool size
    const VARIABLE_OVERHEAD_RATIO: f64 = 0.10;

    let variable_overhead = (total_bytes as f64 * VARIABLE_OVERHEAD_RATIO) as u64;
    let usable = total_bytes.saturating_sub(FIXED_OVERHEAD + variable_overhead);

    log::info!(
        "Apple Silicon: total={} B, fixed_overhead={} B, variable_overhead={} B, \
         usable={} B, required={} B",
        total_bytes,
        FIXED_OVERHEAD,
        variable_overhead,
        usable,
        total_required
    );

    // RED: model exceeds available unified memory — will page to disk or crash
    if total_required > usable {
        return Ok(ModelSupportStatus::Red);
    }

    // GREEN vs YELLOW: use an 85% threshold so that models leaving <15% headroom
    // are flagged as YELLOW, warning the user about potential memory pressure
    // during long inference sessions or with large context windows.
    const COMFORTABLE_RATIO: f64 = 0.85;
    let comfortable_threshold = (usable as f64 * COMFORTABLE_RATIO) as u64;

    if total_required <= comfortable_threshold {
        Ok(ModelSupportStatus::Green)
    } else {
        Ok(ModelSupportStatus::Yellow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_hardware::{CpuStaticInfo, SystemInfo};

    fn apple_silicon(total_memory_mib: u64) -> SystemInfo {
        SystemInfo {
            cpu: CpuStaticInfo {
                name: "Apple M2".to_string(),
                core_count: 8,
                arch: "aarch64".to_string(),
                extensions: vec![],
            },
            os_type: "macos".to_string(),
            os_name: "macOS 14.0".to_string(),
            total_memory: total_memory_mib,
            gpus: vec![],
            default_active_gpus: vec![],
        }
    }

    // Computed thresholds (verified by hand):
    //
    //  8 GB (8192 MiB):
    //    total   = 8,589,934,592 B
    //    usable  = 8,589,934,592 - (2,684,354,560 + 858,993,459)  = 5,046,586,573 B (~4.70 GB)
    //    comfy   = 5,046,586,573 * 0.85                           = 4,289,598,586 B (~3.99 GB)
    //
    // 16 GB (16384 MiB):
    //    total   = 17,179,869,184 B
    //    usable  = 17,179,869,184 - (2,684,354,560 + 1,717,986,918) = 12,777,527,706 B (~11.90 GB)
    //    comfy   = 12,777,527,706 * 0.85                            = 10,860,898,550 B (~10.11 GB)
    //
    // 32 GB (32768 MiB):
    //    total   = 34,359,738,368 B
    //    usable  = 34,359,738,368 - (2,684,354,560 + 3,435,973,836) = 28,239,409,972 B (~26.31 GB)
    //    comfy   = 28,239,409,972 * 0.85                             = 24,003,498,476 B (~22.35 GB)

    // --- 8 GB Mac ---

    #[test]
    fn test_8gb_mac_small_model_is_green() {
        // ~1.7 GB — comfortably below comfy threshold (~4.0 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(8 * 1024), 1_825_361_100).unwrap(),
            ModelSupportStatus::Green
        );
    }

    #[test]
    fn test_8gb_mac_tight_model_is_yellow() {
        // ~4.4 GB — above comfy (4.29 GB) but below usable (4.70 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(8 * 1024), 4_724_464_025).unwrap(),
            ModelSupportStatus::Yellow
        );
    }

    #[test]
    fn test_8gb_mac_large_model_is_red() {
        // 5 GB — exceeds usable (~4.70 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(8 * 1024), 5_368_709_120).unwrap(),
            ModelSupportStatus::Red
        );
    }

    // --- 16 GB Mac ---

    #[test]
    fn test_16gb_mac_7b_model_is_green() {
        // ~4.1 GB — well within comfy threshold (~10.1 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), 4_402_341_478).unwrap(),
            ModelSupportStatus::Green
        );
    }

    #[test]
    fn test_16gb_mac_13b_model_is_green() {
        // ~7.4 GB — within comfy threshold (~10.1 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), 7_945_689_497).unwrap(),
            ModelSupportStatus::Green
        );
    }

    #[test]
    fn test_16gb_mac_tight_model_is_yellow() {
        // 11 GB — above comfy (10.86 GB) but below usable (11.90 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), 11_811_160_064).unwrap(),
            ModelSupportStatus::Yellow
        );
    }

    #[test]
    fn test_16gb_mac_20b_model_is_red() {
        // 13 GB — exceeds usable (11.90 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), 13_958_643_712).unwrap(),
            ModelSupportStatus::Red
        );
    }

    // --- 32 GB Mac ---

    #[test]
    fn test_32gb_mac_20b_model_is_green() {
        // 12 GB — well within comfy threshold (~22.4 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(32 * 1024), 12_884_901_888).unwrap(),
            ModelSupportStatus::Green
        );
    }

    #[test]
    fn test_32gb_mac_tight_model_is_yellow() {
        // 25 GB — above comfy (22.35 GB) but below usable (26.31 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(32 * 1024), 26_843_545_600).unwrap(),
            ModelSupportStatus::Yellow
        );
    }

    #[test]
    fn test_32gb_mac_oversized_model_is_red() {
        // 30 GB — exceeds usable (~26.3 GB)
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(32 * 1024), 32_212_254_720).unwrap(),
            ModelSupportStatus::Red
        );
    }

    // --- Boundary conditions ---

    #[test]
    fn test_zero_required_is_green() {
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), 0).unwrap(),
            ModelSupportStatus::Green
        );
    }

    #[test]
    fn test_exactly_at_usable_boundary_is_yellow() {
        // required == usable: fits but no headroom → YELLOW, not RED
        let usable: u64 = 12_777_527_706;
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), usable).unwrap(),
            ModelSupportStatus::Yellow
        );
    }

    #[test]
    fn test_one_byte_over_usable_is_red() {
        let usable: u64 = 12_777_527_706;
        assert_eq!(
            check_apple_silicon_compatibility(&apple_silicon(16 * 1024), usable + 1).unwrap(),
            ModelSupportStatus::Red
        );
    }

    #[test]
    fn shard_paths_non_ascii_does_not_panic() {
        let p = "/m/m-aaaa\u{e9}bbbbbbbb.gguf";
        assert_eq!(gguf_shard_paths(p), vec![p.to_string()]);
        let q = "/m/a-0000\u{e9}-of-00003.gguf";
        assert_eq!(gguf_shard_paths(q), vec![q.to_string()]);
    }

    #[test]
    fn shard_paths_expand_from_any_shard() {
        let want = vec![
            "/m/a-00001-of-00003.gguf".to_string(),
            "/m/a-00002-of-00003.gguf".to_string(),
            "/m/a-00003-of-00003.gguf".to_string(),
        ];
        assert_eq!(gguf_shard_paths("/m/a-00002-of-00003.gguf"), want);
        assert_eq!(gguf_shard_paths("/m/a-00001-of-00003.gguf"), want);
        assert_eq!(gguf_shard_paths("/m/a.gguf"), vec!["/m/a.gguf".to_string()]);
        assert_eq!(
            gguf_shard_paths("/m/a-00001-of-00001.gguf"),
            vec!["/m/a-00001-of-00001.gguf".to_string()]
        );
    }

    #[test]
    fn kv_cache_leaves_the_vram_requirement_when_offload_is_off() {
        assert_eq!(vram_required_bytes(100, 30, false), 100);
        assert_eq!(vram_required_bytes(100, 30, true), 70);
        assert_eq!(vram_required_bytes(10, 30, true), 0);
    }

    #[tokio::test]
    async fn model_size_sums_every_shard() {
        let dir = std::env::temp_dir().join(format!("flint-shards-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for (n, len) in [(1u32, 10usize), (2, 20), (3, 30)] {
            fs::write(dir.join(format!("m-{n:05}-of-00003.gguf")), vec![0u8; len]).unwrap();
        }
        let first = dir.join("m-00001-of-00003.gguf").to_string_lossy().into_owned();
        let second = dir.join("m-00002-of-00003.gguf").to_string_lossy().into_owned();
        assert_eq!(get_model_size(first).await.unwrap(), 60);
        assert_eq!(get_model_size(second).await.unwrap(), 60);
        let _ = fs::remove_dir_all(&dir);
    }
}
