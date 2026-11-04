//! One reader for the router's `/models/sse` wire format, shared by the load
//! progress listener and the unload watcher.

/// How many bytes may pile up without ending a block before they are dropped.
const MAX_PENDING: usize = 1024 * 1024;

/// Bytes of an SSE stream, split into event blocks.
///
/// Bytes are kept until a whole block is in, so a multi-byte character split
/// across chunks decodes intact. A block ends at a blank line in any of the
/// three spellings SSE allows (`\n\n`, `\r\n\r\n`, `\r\r`). Bounded, so a peer
/// that never ends a block cannot grow it without limit.
#[derive(Default)]
pub struct BlockReader {
    buf: Vec<u8>,
}

impl BlockReader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete block, if one is in.
    pub fn next_block(&mut self) -> Option<String> {
        let end = block_end(&self.buf)?;
        let raw: Vec<u8> = self.buf.drain(..end).collect();
        Some(String::from_utf8_lossy(&raw).into_owned())
    }

    /// Call once no block is left: drops a run that never ended one. Returns
    /// how many bytes were dropped.
    pub fn drop_if_oversized(&mut self) -> usize {
        if self.buf.len() > MAX_PENDING {
            let n = self.buf.len();
            self.buf.clear();
            n
        } else {
            0
        }
    }
}

/// Offset just past the first blank-line terminator, if any.
fn block_end(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i < buf.len() {
        let rest = &buf[i..];
        if rest.starts_with(b"\n\n") || rest.starts_with(b"\r\r") {
            return Some(i + 2);
        }
        if rest.starts_with(b"\r\n\r\n") {
            return Some(i + 4);
        }
        i += 1;
    }
    None
}

/// The JSON of every `data:` line of a block. Comments (`: keepalive`), other
/// fields and lines that are not JSON are skipped, not taken as the block's end.
pub fn data_events(block: &str) -> impl Iterator<Item = serde_json::Value> + '_ {
    block.lines().filter_map(|line| {
        let data = line.strip_prefix("data:")?;
        serde_json::from_str(data.trim_start()).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(chunks: &[&[u8]]) -> Vec<String> {
        let mut r = BlockReader::default();
        let mut out = Vec::new();
        for c in chunks {
            r.push(c);
            while let Some(b) = r.next_block() {
                out.push(b);
            }
        }
        out
    }

    #[test]
    fn splits_on_every_blank_line_spelling() {
        assert_eq!(blocks(&[b"data: 1\n\ndata: 2\r\n\r\ndata: 3\r\r"]).len(), 3);
    }

    #[test]
    fn a_block_split_across_chunks_comes_out_once() {
        let out = blocks(&[b"data: {\"a\"", b":1}\r\n", b"\r\nrest"]);
        assert_eq!(out, vec!["data: {\"a\":1}\r\n\r\n".to_string()]);
    }

    #[test]
    fn a_multibyte_char_split_across_chunks_survives() {
        let s = "data: \"é\"\n\n".as_bytes();
        let out = blocks(&[&s[..8], &s[8..]]);
        assert_eq!(out, vec!["data: \"é\"\n\n".to_string()]);
    }

    #[test]
    fn a_block_that_never_ends_is_dropped() {
        let mut r = BlockReader::default();
        r.push(&vec![b'x'; MAX_PENDING + 1]);
        assert!(r.next_block().is_none());
        assert_eq!(r.drop_if_oversized(), MAX_PENDING + 1);
        assert_eq!(r.drop_if_oversized(), 0);
    }

    #[test]
    fn data_events_skip_comments_and_junk() {
        let v: Vec<_> =
            data_events(": keepalive\nevent: x\ndata: nope\ndata:{\"a\":1}\ndata: {\"b\":2}\n\n").collect();
        assert_eq!(v.len(), 2);
    }
}
