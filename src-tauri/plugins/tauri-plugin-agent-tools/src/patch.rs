//! A proposed change to one file, held as hunks a person can review.
//!
//! Three registry items meet here, and they share one object because they are
//! one idea seen from three sides:
//!
//! * **AH-146, preview.** What is shown before approval is the change as a set
//!   of hunks with real line numbers -- structured data a client can render and
//!   reason about, not only a block of prefixed text.
//! * **AH-147, per-hunk selection.** [`StagedPatch::select`] rebuilds the file
//!   from the base with only the accepted hunks applied. A rejected hunk leaves
//!   the base lines exactly as they were.
//! * **AH-148, no clobbering.** A patch remembers a [`BaseStamp`] of what it was
//!   computed against. [`StagedPatch::check_base`] refuses when the file on
//!   disk is no longer that content, so an approval given against one version
//!   of a file is never applied on top of another.
//!
//! Hunks are the maximal runs of changed lines, with no context merged in:
//! merging nearby changes the way a unified diff does would make two unrelated
//! edits one decision, which is exactly what per-hunk approval exists to avoid.

use serde::Serialize;
use similar::{DiffOp, TextDiff};

/// What a file was, compact enough to keep and cheap enough to compare.
///
/// A hash and a length rather than the content: the stamp is held for the
/// length of an approval, which can be minutes, and a copy of every file an
/// agent proposes to change is not something to keep in memory for that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseStamp {
    exists: bool,
    len: usize,
    hash: u64,
}

impl BaseStamp {
    /// The stamp of `content`, or of a file that does not exist.
    pub fn of(content: Option<&[u8]>) -> Self {
        match content {
            Some(bytes) => Self {
                exists: true,
                len: bytes.len(),
                hash: fnv1a64(bytes),
            },
            None => Self {
                exists: false,
                len: 0,
                hash: 0,
            },
        }
    }

    /// Read `path` and stamp it. A missing file stamps as absent; any other
    /// read failure stamps as absent too, which makes a later comparison against
    /// a real stamp fail -- the safe direction.
    pub async fn read(path: &std::path::Path) -> Self {
        match tokio::fs::read(path).await {
            Ok(bytes) => Self::of(Some(&bytes)),
            Err(_) => Self::of(None),
        }
    }

    pub fn existed(&self) -> bool {
        self.exists
    }

    /// Hex, for display and for the event a client receives.
    pub fn hex(&self) -> String {
        if self.exists {
            format!("fnv1a64:{:016x}", self.hash)
        } else {
            "absent".to_string()
        }
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// One contiguous change: lines removed from the base and lines put in their
/// place. Line numbers are 1-based, against the base and against the full
/// proposal respectively.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// Position in [`StagedPatch::hunks`], and the id a selection names.
    pub index: usize,
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub removed: Vec<String>,
    pub added: Vec<String>,
}

/// What a client receives: the hunks and the base they were computed against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchView {
    pub base: String,
    pub hunks: Vec<Hunk>,
}

/// Why a patch was not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchError {
    /// A selection named a hunk this patch does not have.
    UnknownHunk(usize),
    /// The file is no longer the content the patch was computed against.
    BaseChanged {
        expected: BaseStamp,
        found: BaseStamp,
    },
}

impl PatchError {
    /// For the model and the person. Says nothing was written, because that is
    /// the fact that decides what anyone does next.
    pub fn message(&self, shown: &str) -> String {
        match self {
            PatchError::UnknownHunk(index) => format!(
                "ERROR: {shown}: the change has no hunk {index}; nothing was written"
            ),
            PatchError::BaseChanged { expected, found } => {
                let what = match (expected.existed(), found.existed()) {
                    (false, true) => "was created by something else",
                    (true, false) => "was deleted",
                    _ => "was changed by something else",
                };
                format!(
                    "ERROR: {shown} {what} after this change was reviewed, so it was not \
                     applied and nothing was written. Read the file again and propose the \
                     change against what is there now."
                )
            }
        }
    }
}

/// A change to one file, computed once and applied only against the content it
/// was computed from.
#[derive(Debug, Clone)]
pub struct StagedPatch {
    base: String,
    proposed: String,
    stamp: BaseStamp,
    hunks: Vec<Hunk>,
    /// The diff's own ops, kept so `select` walks exactly the regions the hunks
    /// were built from rather than recomputing and hoping they agree.
    regions: Vec<Region>,
}

#[derive(Debug, Clone)]
enum Region {
    /// Unchanged base lines, by range.
    Same(std::ops::Range<usize>),
    /// A change: base lines out, proposal lines in, and the hunk it belongs to.
    Change {
        old: std::ops::Range<usize>,
        new: std::ops::Range<usize>,
        hunk: usize,
    },
}

impl StagedPatch {
    /// Stage the change from `base` (absent for a new file) to `proposed`.
    pub fn stage(base: Option<&str>, proposed: &str) -> Self {
        let base_text = base.unwrap_or("").to_string();
        let stamp = BaseStamp::of(base.map(str::as_bytes));
        let diff = TextDiff::from_lines(base_text.as_str(), proposed);
        let old_lines: Vec<&str> = diff.old_slices().to_vec();
        let new_lines: Vec<&str> = diff.new_slices().to_vec();

        let mut regions = Vec::new();
        let mut hunks: Vec<Hunk> = Vec::new();
        // Adjacent non-equal ops (a delete followed by an insert) are one
        // change to the reader, so they are one hunk.
        let mut pending: Option<(std::ops::Range<usize>, std::ops::Range<usize>)> = None;

        let flush = |pending: &mut Option<(std::ops::Range<usize>, std::ops::Range<usize>)>,
                     regions: &mut Vec<Region>,
                     hunks: &mut Vec<Hunk>| {
            if let Some((old, new)) = pending.take() {
                let index = hunks.len();
                let strip = |s: &&str| s.strip_suffix('\n').unwrap_or(s).to_string();
                hunks.push(Hunk {
                    index,
                    old_start: old.start + 1,
                    old_len: old.len(),
                    new_start: new.start + 1,
                    new_len: new.len(),
                    removed: old_lines[old.clone()].iter().map(strip).collect(),
                    added: new_lines[new.clone()].iter().map(strip).collect(),
                });
                regions.push(Region::Change {
                    old,
                    new,
                    hunk: index,
                });
            }
        };

        for op in diff.ops() {
            match op {
                DiffOp::Equal { old_index, len, .. } => {
                    flush(&mut pending, &mut regions, &mut hunks);
                    regions.push(Region::Same(*old_index..old_index + len));
                }
                other => {
                    let (old, new) = (other.old_range(), other.new_range());
                    pending = Some(match pending.take() {
                        Some((o, n)) => (o.start..old.end, n.start..new.end),
                        None => (old, new),
                    });
                }
            }
        }
        flush(&mut pending, &mut regions, &mut hunks);

        Self {
            base: base_text,
            proposed: proposed.to_string(),
            stamp,
            hunks,
            regions,
        }
    }

    pub fn hunks(&self) -> &[Hunk] {
        &self.hunks
    }

    pub fn stamp(&self) -> BaseStamp {
        self.stamp
    }

    pub fn is_empty(&self) -> bool {
        self.hunks.is_empty()
    }

    pub fn view(&self) -> PatchView {
        PatchView {
            base: self.stamp.hex(),
            hunks: self.hunks.clone(),
        }
    }

    /// The whole proposal. Identical to selecting every hunk.
    pub fn proposed(&self) -> &str {
        &self.proposed
    }

    /// The file with only `accepted` hunks applied. AH-147.
    ///
    /// A rejected hunk leaves the base lines exactly as they were, including
    /// their line endings. An unknown index is refused rather than ignored: a
    /// selection that names something that is not there is a selection nobody
    /// can have meant.
    pub fn select(&self, accepted: &[usize]) -> Result<String, PatchError> {
        if let Some(bad) = accepted.iter().find(|i| **i >= self.hunks.len()) {
            return Err(PatchError::UnknownHunk(*bad));
        }
        let diff = TextDiff::from_lines(self.base.as_str(), self.proposed.as_str());
        let old_lines = diff.old_slices();
        let new_lines = diff.new_slices();
        let mut out = String::with_capacity(self.proposed.len().max(self.base.len()));
        for region in &self.regions {
            match region {
                Region::Same(range) => out.extend(old_lines[range.clone()].iter().copied()),
                Region::Change { old, new, hunk } => {
                    if accepted.contains(hunk) {
                        out.extend(new_lines[new.clone()].iter().copied());
                    } else {
                        out.extend(old_lines[old.clone()].iter().copied());
                    }
                }
            }
        }
        Ok(out)
    }

    /// Refuse when the file is no longer what this patch was computed from.
    /// AH-148.
    pub fn check_base(&self, current: BaseStamp) -> Result<(), PatchError> {
        if current == self.stamp {
            Ok(())
        } else {
            Err(PatchError::BaseChanged {
                expected: self.stamp,
                found: current,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

    fn two_changes() -> StagedPatch {
        // A change near the top and one near the bottom, far enough apart that
        // they are two decisions.
        StagedPatch::stage(Some(BASE), "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n")
    }

    #[test]
    fn separate_changes_are_separate_hunks() {
        let patch = two_changes();
        assert_eq!(patch.hunks().len(), 2);
        assert_eq!(patch.hunks()[0].removed, vec!["one"]);
        assert_eq!(patch.hunks()[0].added, vec!["ONE"]);
        assert_eq!(patch.hunks()[0].old_start, 1);
        assert_eq!(patch.hunks()[1].removed, vec!["seven"]);
        assert_eq!(patch.hunks()[1].old_start, 7);
    }

    /// The two invariants everything else rests on.
    #[test]
    fn selecting_everything_is_the_proposal_and_nothing_is_the_base() {
        let patch = two_changes();
        assert_eq!(patch.select(&[0, 1]).unwrap(), patch.proposed());
        assert_eq!(patch.select(&[]).unwrap(), BASE);
    }

    #[test]
    fn a_rejected_hunk_leaves_the_base_lines_untouched() {
        let patch = two_changes();
        assert_eq!(
            patch.select(&[0]).unwrap(),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n"
        );
        assert_eq!(
            patch.select(&[1]).unwrap(),
            "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n"
        );
    }

    #[test]
    fn a_selection_naming_a_hunk_that_does_not_exist_is_refused() {
        let patch = two_changes();
        assert_eq!(patch.select(&[0, 9]), Err(PatchError::UnknownHunk(9)));
    }

    #[test]
    fn insertions_and_deletions_are_hunks_too() {
        let patch = StagedPatch::stage(Some("a\nb\nc\n"), "a\nnew\nb\n");
        assert_eq!(patch.select(&[]).unwrap(), "a\nb\nc\n");
        assert_eq!(patch.select(&(0..patch.hunks().len()).collect::<Vec<_>>()).unwrap(), "a\nnew\nb\n");
        // Each on its own, so the insertion can be kept and the deletion refused.
        let insert = patch
            .hunks()
            .iter()
            .position(|h| h.removed.is_empty())
            .expect("an insertion hunk");
        assert_eq!(patch.select(&[insert]).unwrap(), "a\nnew\nb\nc\n");
    }

    #[test]
    fn a_new_file_is_one_hunk_against_nothing() {
        let patch = StagedPatch::stage(None, "hello\nworld\n");
        assert_eq!(patch.hunks().len(), 1);
        assert!(patch.hunks()[0].removed.is_empty());
        assert_eq!(patch.select(&[]).unwrap(), "");
        assert!(!patch.stamp().existed());
    }

    #[test]
    fn an_unchanged_file_has_no_hunks() {
        assert!(StagedPatch::stage(Some(BASE), BASE).is_empty());
    }

    #[test]
    fn a_missing_final_newline_survives_both_ways() {
        let patch = StagedPatch::stage(Some("a\nb"), "a\nB");
        assert_eq!(patch.select(&[0]).unwrap(), "a\nB");
        assert_eq!(patch.select(&[]).unwrap(), "a\nb");
    }

    /// AH-148. The approval was given against one file; applying it on top of
    /// another would overwrite work nobody reviewed.
    #[test]
    fn a_changed_base_is_refused() {
        let patch = two_changes();
        assert!(patch.check_base(BaseStamp::of(Some(BASE.as_bytes()))).is_ok());
        let edited = format!("{BASE}someone else's line\n");
        assert!(matches!(
            patch.check_base(BaseStamp::of(Some(edited.as_bytes()))),
            Err(PatchError::BaseChanged { .. })
        ));
    }

    #[test]
    fn a_file_created_or_deleted_underneath_is_refused() {
        let new_file = StagedPatch::stage(None, "x\n");
        let appeared = new_file.check_base(BaseStamp::of(Some(b"someone else wrote this\n")));
        assert!(appeared.is_err());
        assert!(appeared.unwrap_err().message("f.txt").contains("created by something else"));

        let existing = two_changes();
        let gone = existing.check_base(BaseStamp::of(None));
        assert!(gone.unwrap_err().message("f.txt").contains("was deleted"));
    }

    #[test]
    fn the_refusal_says_nothing_was_written() {
        let err = two_changes()
            .check_base(BaseStamp::of(Some(b"different\n")))
            .unwrap_err();
        let message = err.message("src/lib.rs");
        assert!(message.contains("src/lib.rs"));
        assert!(message.contains("nothing was written"));
    }

    #[test]
    fn the_view_carries_the_base_it_was_computed_against() {
        let view = two_changes().view();
        assert!(view.base.starts_with("fnv1a64:"));
        assert_eq!(view.hunks.len(), 2);
        let json = serde_json::to_value(&view).unwrap();
        assert!(json["hunks"][0]["oldStart"].is_number());
    }
}
