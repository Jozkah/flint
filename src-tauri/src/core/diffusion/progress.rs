//! Reads sd.cpp's log to say how far along a generation is.
//!
//! The server reports no progress over HTTP, but its verbose log draws a bar
//! that redraws in place (`\r<bar> 12/28 - 3.5s/it`), so progress is read from
//! the stream as it is written. The log arrives in arbitrary chunks, redraws use
//! a carriage return instead of a newline, and colour codes are mixed in; this
//! module splits it into records and finds the step counter in them.

/// A step counter: `step` of `total` sampling steps done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub step: u32,
    pub total: u32,
}

/// Remove ANSI escape sequences (colours and the erase-line the bar ends with).
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // Parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
            for next in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// The first `N/M` pair in a line, if it is a plausible step counter.
pub fn parse_step_line(line: &str) -> Option<Step> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let step: u32 = line[start..i].parse().ok()?;
        let mut j = i;
        while j < bytes.len() && bytes[j] == b' ' {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'/' {
            j += 1;
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            let t_start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > t_start {
                let total: u32 = line[t_start..j].parse().ok()?;
                if total > 0 && step <= total {
                    return Some(Step { step, total });
                }
            }
        }
        i = i.max(j);
    }
    None
}

/// Whether a line is the in-place bar (it has a speed on it), as opposed to a
/// message that merely contains two numbers around a slash.
pub fn is_progress_redraw(line: &str) -> bool {
    line.contains("s/it") || line.contains("it/s") || line.contains("B/s")
}

/// Splits a byte stream into records at `\r`, `\n` or `\r\n`, whatever the
/// chunking, and decodes UTF-8 across chunk edges.
#[derive(Default)]
pub struct RecordSplitter {
    pending: Vec<u8>,
}

impl RecordSplitter {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        let mut i = 0;
        while i < self.pending.len() {
            let b = self.pending[i];
            if b == b'\r' || b == b'\n' {
                if i > start {
                    out.push(strip_ansi(&String::from_utf8_lossy(&self.pending[start..i])));
                }
                // `\r\n` is one break.
                if b == b'\r' && self.pending.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            i += 1;
        }
        self.pending.drain(..start);
        out
    }

    /// What is left when the stream ends.
    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let text = strip_ansi(&String::from_utf8_lossy(&self.pending));
        self.pending.clear();
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

/// Where a generation is, for the progress bar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Queued,
    Encoding,
    Sampling,
    Decoding,
    Saving,
}

/// Follows the step counter across a batch. A step number that goes down means
/// the next image of the batch has started.
pub struct ProgressTracker {
    expected_steps: u32,
    batch: u32,
    done: u32,
    last_step: u32,
    pub phase: Phase,
}

impl ProgressTracker {
    pub fn new(expected_steps: u32, batch: u32) -> Self {
        Self {
            expected_steps,
            batch: batch.max(1),
            done: 0,
            last_step: 0,
            phase: Phase::Queued,
        }
    }

    /// Feed one log record. Returns the new fraction (0..1) when it changed.
    pub fn feed(&mut self, record: &str) -> Option<f64> {
        let lower = record.to_ascii_lowercase();
        if lower.contains("decoding") && self.phase == Phase::Sampling {
            self.phase = Phase::Decoding;
            return Some(0.98);
        }
        if !is_progress_redraw(record) && !lower.contains("sampling") {
            return None;
        }
        let step = parse_step_line(record)?;
        // Only the sampling bar counts: another bar (a tile pass, a download)
        // would have a different total.
        if step.total != self.expected_steps || step.step == 0 {
            return None;
        }
        if step.step < self.last_step {
            self.done += self.last_step;
        }
        self.last_step = step.step;
        self.phase = Phase::Sampling;
        let total = self.expected_steps * self.batch;
        let fraction = f64::from(self.done + step.step) / f64::from(total);
        Some(fraction.min(0.97))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_codes_and_erase_line_are_removed() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m done\u{1b}[K"), "ok done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn a_step_counter_is_found_in_the_shapes_sd_cpp_prints() {
        assert_eq!(
            parse_step_line("  |==========>        | 12/28 - 3.52s/it"),
            Some(Step { step: 12, total: 28 })
        );
        assert_eq!(parse_step_line("[ 12/ 28] sampling"), Some(Step { step: 12, total: 28 }));
        assert_eq!(parse_step_line("4/4"), Some(Step { step: 4, total: 4 }));
        assert_eq!(parse_step_line("no numbers here"), None);
        // A step beyond the total is not a counter.
        assert_eq!(parse_step_line("30/28"), None);
        assert_eq!(parse_step_line("1 / 0"), None);
    }

    #[test]
    fn only_a_line_with_a_speed_counts_as_the_bar() {
        assert!(is_progress_redraw("| 3/8 - 2.1s/it"));
        assert!(is_progress_redraw("5.2it/s"));
        assert!(!is_progress_redraw("loading tensor 3/8"));
    }

    #[test]
    fn records_split_on_carriage_returns_across_chunk_edges() {
        let mut s = RecordSplitter::default();
        let mut out = Vec::new();
        for chunk in [&b"| 1/8 - 2s/it\r| 2/"[..], b"8 - 2s/it\r\nnext line\n", b"tail"] {
            out.extend(s.push(chunk));
        }
        assert_eq!(out, vec!["| 1/8 - 2s/it", "| 2/8 - 2s/it", "next line"]);
        assert_eq!(s.finish().as_deref(), Some("tail"));
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn utf8_split_across_chunks_is_decoded_whole() {
        let mut s = RecordSplitter::default();
        let bytes = "héllo\n".as_bytes();
        let mut out = s.push(&bytes[..2]);
        out.extend(s.push(&bytes[2..]));
        assert_eq!(out, vec!["héllo"]);
    }

    #[test]
    fn progress_advances_through_a_batch_and_stays_below_one() {
        let mut t = ProgressTracker::new(4, 2);
        let mut seen = Vec::new();
        for n in [1, 2, 3, 4, 1, 2, 3, 4] {
            if let Some(f) = t.feed(&format!("| {n}/4 - 1.0s/it")) {
                seen.push(f);
            }
        }
        assert_eq!(seen.len(), 8);
        assert!(seen.windows(2).all(|w| w[1] >= w[0]));
        assert!((seen[3] - 0.5).abs() < 1e-9);
        assert!(*seen.last().unwrap() <= 0.97);
        assert_eq!(t.phase, Phase::Sampling);
    }

    #[test]
    fn a_bar_with_another_total_is_not_sampling_progress() {
        let mut t = ProgressTracker::new(8, 1);
        assert_eq!(t.feed("| 3/10 - 1s/it"), None);
        assert_eq!(t.phase, Phase::Queued);
    }

    #[test]
    fn decoding_follows_sampling() {
        let mut t = ProgressTracker::new(2, 1);
        t.feed("| 2/2 - 1s/it");
        assert_eq!(t.feed("decoding 1 latents"), Some(0.98));
        assert_eq!(t.phase, Phase::Decoding);
    }
}
