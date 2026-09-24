use crate::gguf::helpers;
use crate::gguf::types::{GgufMetadata, KVCacheError, KVCacheEstimate};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;

/// Runs a parse over a gguf, local or remote.
///
/// A remote file is fetched in range chunks and the parse retried after each
/// one, since neither the KV section nor the tensor-info block has a length
/// known up front. `what` names the parse in the error, which is all that
/// differs between callers -- the fetch loop is shared so the chunking rules
/// cannot drift apart.
async fn parse_gguf<T, F>(path: &str, what: &str, parse: F) -> Result<T, String>
where
    F: Fn(&mut (dyn ReadSeek + '_)) -> std::io::Result<T>,
{
    if path.starts_with("http://") || path.starts_with("https://") {
        // Remote: read in 2MB chunks until successful
        let client = reqwest::Client::new();
        let chunk_size = 2 * 1024 * 1024; // Fixed 2MB chunks
        let max_total_size = 120 * 1024 * 1024; // Don't exceed 120MB total
        let mut total_downloaded = 0;
        let mut accumulated_data = Vec::new();

        while total_downloaded < max_total_size {
            let start = total_downloaded;
            let end = std::cmp::min(start + chunk_size - 1, max_total_size - 1);

            let mut resp = client
                .get(path)
                .header("Range", format!("bytes={}-{}", start, end))
                .send()
                .await
                .map_err(|e| format!("Failed to fetch chunk {}-{}: {}", start, end, e))?;

            let status = resp.status();
            if status == reqwest::StatusCode::OK {
                // The server ignored Range and is sending the whole file from
                // byte 0. Appending it as "the next chunk" would duplicate the
                // file, and reading it with bytes() would pull down every byte
                // of a multi-GB model. Stream it once, up to the cap, instead.
                let mut data = Vec::new();
                let mut parsed_at = 0;
                loop {
                    let next = resp
                        .chunk()
                        .await
                        .map_err(|e| format!("Failed to read response: {}", e))?;
                    let done = match next {
                        Some(bytes) => {
                            data.extend_from_slice(&bytes);
                            data.len() >= max_total_size
                        }
                        None => true,
                    };
                    if done || data.len() - parsed_at >= chunk_size {
                        parsed_at = data.len();
                        let mut cursor = std::io::Cursor::new(data.as_slice());
                        if let Ok(parsed) = parse(&mut cursor) {
                            return Ok(parsed);
                        }
                    }
                    if done {
                        break;
                    }
                }
                return Err(format!("Could not read {} from downloaded data", what));
            }
            if status != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(format!(
                    "Failed to fetch {} from {}: HTTP {}",
                    what, path, status
                ));
            }

            let chunk_data = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed to read chunk response: {}", e))?;

            accumulated_data.extend_from_slice(&chunk_data);
            total_downloaded += chunk_data.len();

            // Try parsing after each chunk
            let mut cursor = std::io::Cursor::new(accumulated_data.as_slice());
            if let Ok(parsed) = parse(&mut cursor) {
                return Ok(parsed);
            }

            // If we got less data than expected, we've reached EOF
            if chunk_data.len() < chunk_size {
                break;
            }
        }
        Err(format!("Could not read {} from downloaded data", what))
    } else {
        // Local: use streaming file reader
        let file =
            File::open(path).map_err(|e| format!("Failed to open local file {}: {}", path, e))?;
        let mut reader = BufReader::new(file);

        parse(&mut reader).map_err(|e| format!("Failed to parse {}: {}", what, e))
    }
}

/// One trait object for the two readers `parse_gguf` hands out, so the parse
/// closure does not have to be generic over both.
pub trait ReadSeek: std::io::Read + std::io::Seek {}
impl<T: std::io::Read + std::io::Seek> ReadSeek for T {}

// read gguf metadata
pub async fn read_gguf_metadata_internal(path: String) -> Result<GgufMetadata, String> {
    parse_gguf(&path, "GGUF metadata", |r: &mut (dyn ReadSeek + '_)| {
        helpers::read_gguf_metadata(r)
    })
    .await
}

/// Which of `names` exist as tensors in the gguf. See `find_gguf_tensors` for
/// why this is an exact-name question rather than a listing.
pub async fn find_gguf_tensors_internal(
    path: String,
    names: Vec<String>,
) -> Result<Vec<String>, String> {
    parse_gguf(&path, "GGUF tensor names", |r: &mut (dyn ReadSeek + '_)| {
        helpers::find_gguf_tensors(r, &names)
    })
    .await
}

/// Estimate KVCache size from a given metadata
pub async fn estimate_kv_cache_internal(
    meta: HashMap<String, String>,
    ctx_size: Option<u64>,
) -> Result<KVCacheEstimate, KVCacheError> {
    log::info!("Received ctx_size parameter: {:?}", ctx_size);
    let arch = meta
        .get("general.architecture")
        .ok_or(KVCacheError::ArchitectureNotFound)?;

    // Number of layers
    let n_layer_key = format!("{}.block_count", arch);
    let n_layer = meta
        .get(&n_layer_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .ok_or(KVCacheError::BlockCountInvalid)?;

    // Attention heads (use kv heads if present, else full heads)
    let n_head_key = format!("{}.attention.head_count", arch);
    let n_head_kv_key = format!("{}.attention.head_count_kv", arch);
    let n_head = meta
        .get(&n_head_kv_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            meta.get(&n_head_key)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        });
    if n_head == 0 {
        return Err(KVCacheError::HeadCountInvalid);
    }

    // Key/value dimensions
    let key_len_key = format!("{}.attention.key_length", arch);
    let val_len_key = format!("{}.attention.value_length", arch);

    let mut key_len = meta
        .get(&key_len_key)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut val_len = meta
        .get(&val_len_key)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    // Fallback: calculate from embedding_length if key/val lengths not found
    if key_len == 0 || val_len == 0 {
        let emb_len_key = format!("{}.embedding_length", arch);
        let emb_len = meta
            .get(&emb_len_key)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if emb_len > 0 && n_head > 0 {
            // For most transformers: head_dim = embedding_length / total_heads
            let total_heads = meta
                .get(&n_head_key)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(n_head);

            let head_dim = emb_len / total_heads;
            key_len = head_dim;
            val_len = head_dim;

            log::info!(
                "Calculated key_len and val_len from embedding_length: {} / {} heads = {} per head",
                emb_len,
                total_heads,
                head_dim
            );
        }
    }

    if key_len == 0 || val_len == 0 {
        return Err(KVCacheError::EmbeddingLengthInvalid);
    }

    // Context length
    let max_ctx_key = format!("{}.context_length", arch);
    let max_ctx = meta
        .get(&max_ctx_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .ok_or(KVCacheError::ContextLengthInvalid)?;
    let ctx_len = ctx_size.map(|size| size.min(max_ctx)).unwrap_or(max_ctx);

    // Sliding window if present
    let sliding_key = format!("{}.attention.sliding_window", arch);
    let sliding_window = meta
        .get(&sliding_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0);

    // Assume fp16
    const BYTES_PER_ELEMENT: u64 = 2;

    // Per-token KV size
    let kv_per_token = n_layer * n_head * (key_len + val_len) * BYTES_PER_ELEMENT;

    // Pure full-attention cost
    let full_cost = ctx_len * kv_per_token;

    // Pure sliding-window cost (tiny, only keeps last W tokens)
    let sliding_cost = sliding_window.map(|w| w * kv_per_token);

    // Middle estimate: average of sliding + full if sliding_window is present
    let chosen_size = if let Some(slide) = sliding_cost {
        let middle = (full_cost + slide) / 2;
        log::info!(
            "KV estimates -> sliding: {} bytes (~{:.2} MB), full: {} bytes (~{:.2} MB), middle: {} bytes (~{:.2} MB)",
            slide,
            slide as f64 / (1024.0 * 1024.0),
            full_cost,
            full_cost as f64 / (1024.0 * 1024.0),
            middle,
            middle as f64 / (1024.0 * 1024.0)
        );
        middle
    } else {
        log::info!(
            "KV estimate (no SWA detected) -> full: {} bytes (~{:.2} MB)",
            full_cost,
            full_cost as f64 / (1024.0 * 1024.0)
        );
        full_cost
    };

    Ok(KVCacheEstimate {
        size: chosen_size,
        per_token_size: kv_per_token,
    })
}

#[cfg(test)]
mod remote_fetch_status_tests {
    use super::*;
    use std::io::Read;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves every request with the same status line and body.
    async fn serve(status: &'static str, body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => req.extend_from_slice(&buf[..n]),
                        }
                    }
                    let head = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        status,
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{}/model.gguf", addr)
    }

    fn read_all(r: &mut (dyn ReadSeek + '_)) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        r.read_to_end(&mut out)?;
        if out.starts_with(b"GGUF") {
            Ok(out)
        } else {
            Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not gguf"))
        }
    }

    // Regression for #161: an HTTP error must be reported, not parsed as bytes.
    #[tokio::test]
    async fn an_http_error_is_reported_with_its_status() {
        let url = serve("404 Not Found", b"GGUF-looking error page".to_vec()).await;
        let err = parse_gguf(&url, "GGUF metadata", read_all).await.unwrap_err();
        assert!(err.contains("404"), "status missing from error: {err}");
    }

    #[tokio::test]
    async fn a_server_ignoring_range_yields_the_file_once() {
        let body = b"GGUF-whole-file".to_vec();
        let url = serve("200 OK", body.clone()).await;
        let data = parse_gguf(&url, "GGUF metadata", read_all).await.unwrap();
        assert_eq!(data, body);
    }

    #[tokio::test]
    async fn a_partial_content_response_is_parsed() {
        let body = b"GGUF-range".to_vec();
        let url = serve("206 Partial Content", body.clone()).await;
        let data = parse_gguf(&url, "GGUF metadata", read_all).await.unwrap();
        assert_eq!(data, body);
    }
}
