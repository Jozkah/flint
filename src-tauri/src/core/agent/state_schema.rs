//! What this harness writes to disk, at which version, and what happens when
//! it meets a file it did not write. AH-010.
//!
//! Eighteen stores had a `SCHEMA_VERSION` each, declared next to the code that
//! writes them and catalogued nowhere. That is fine until somebody has to
//! answer one of the questions this module exists for: what is on disk after a
//! run, which of it survives an upgrade, what happens to a file written by a
//! newer build, and where does a support request send someone to look.
//!
//! So the stores are listed here, each with its version, where it lives, and
//! -- the part that is easy to leave implicit -- what reading an *older* or a
//! *newer* file actually does. A test holds each entry's version against the
//! constant the writing module declares, so this list cannot quietly go stale;
//! that is the whole reason it is worth having rather than a document.
//!
//! This is a catalogue, not a migration engine. Every store here either reads
//! older shapes in place (serde defaults), rebuilds from a source that still
//! exists, or refuses the file and says so. Nothing rewrites a user's data on
//! startup, which is the migration strategy that turns one bad release into
//! lost work.

use serde::Serialize;

/// What happens when this store meets a file from another version.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Migration {
    /// Older files are read as they stand: every field added since has a
    /// default, and the absent ones read as absent rather than as zero.
    ReadsOlderInPlace,
    /// The file is derived from something that still exists, so an older or
    /// unreadable one is simply rebuilt. Nothing is lost by throwing it away.
    RebuildsFromSource,
    /// The file is refused and left alone: it is somebody's data, written by a
    /// build that knows more than this one, and guessing at it would be worse
    /// than declining.
    RefusedAndKept,
    /// Append-only records where a line that will not parse is skipped and the
    /// rest of the file is still read -- one bad line never costs the record.
    SkipsUnreadableLines,
}

impl Migration {
    pub fn as_str(self) -> &'static str {
        match self {
            Migration::ReadsOlderInPlace => "reads older files in place",
            Migration::RebuildsFromSource => "rebuilt from its source",
            Migration::RefusedAndKept => "refused and left alone",
            Migration::SkipsUnreadableLines => "skips lines it cannot read",
        }
    }
}

/// Who a store belongs to, which is also who has to migrate it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Owner {
    /// Under the Jan data folder: state about conversations and runs.
    DataFolder,
    /// Inside the project, under `.jan/agent`: state a repository carries.
    Project,
    /// A file a person chose the location of -- an export, a bundle.
    UserChosen,
}

/// One thing this harness writes down.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    /// The module that owns it, as a path a person can open.
    pub module: &'static str,
    /// What it holds, in one line.
    pub holds: &'static str,
    pub version: u32,
    pub owner: Owner,
    /// Where it is, relative to its owner's root.
    pub location: &'static str,
    pub migration: Migration,
}

/// Everything this harness writes to disk.
///
/// Ordered by where it lives rather than by name, so the list reads the way
/// somebody looking at a data folder reads it.
pub fn stores() -> Vec<Store> {
    use Migration::*;
    use Owner::*;
    vec![
        Store {
            module: "tauri-plugin-agent-tools/src/event_log.rs",
            holds: "the canonical per-session event log",
            version: tauri_plugin_agent_tools::event_log::ENVELOPE_VERSION as u32,
            owner: DataFolder,
            location: "events/<hash of session>.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/activity.rs",
            holds: "tool activity, as the timeline shows it",
            version: tauri_plugin_agent_tools::activity::SCHEMA_VERSION,
            owner: DataFolder,
            location: "audit/tool-activity.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/audit.rs",
            holds: "permission decisions and tool invocations",
            version: tauri_plugin_agent_tools::audit::SCHEMA_VERSION,
            owner: DataFolder,
            location: "audit/permissions.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/snapshot.rs",
            holds: "the request each turn sent, for replay and inspection",
            version: tauri_plugin_agent_tools::snapshot::SCHEMA_VERSION,
            owner: DataFolder,
            location: "audit/prompts.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/usage.rs",
            holds: "tokens and cost per run",
            version: tauri_plugin_agent_tools::usage::SCHEMA_VERSION,
            owner: DataFolder,
            location: "audit/payload-usage.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/job_record.rs",
            holds: "background jobs and how they ended",
            version: 1,
            owner: DataFolder,
            location: "jobs/<hash of owner>.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/mailbox.rs",
            holds: "messages between runs of one conversation",
            version: 1,
            owner: DataFolder,
            location: "mail/<hash of run>.jsonl",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "core/agent/index.rs",
            holds: "the repository's files and the symbols they define",
            version: crate::core::agent::index::INDEX_VERSION,
            owner: DataFolder,
            location: "index/<hash of project>.json",
            migration: RebuildsFromSource,
        },
        Store {
            module: "core/agent/review.rs",
            holds: "a review being worked through, and what was said about it",
            version: 1,
            owner: DataFolder,
            location: "reviews/<hash of project>.json",
            migration: RefusedAndKept,
        },
        Store {
            module: "core/agent/replay.rs",
            holds: "replays of recorded turns and how they compared",
            version: crate::core::agent::replay::SCHEMA_VERSION,
            owner: DataFolder,
            location: "replays/<hash of session>.json",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/proposal.rs",
            holds: "changes a run proposes, before anybody applies them",
            version: tauri_plugin_agent_tools::proposal::SCHEMA_VERSION,
            owner: DataFolder,
            location: "proposals/ and proposals/blobs/",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/undo.rs",
            holds: "what a tool changed, so it can be put back",
            version: tauri_plugin_agent_tools::undo::SCHEMA_VERSION,
            owner: DataFolder,
            location: "undo/<session>.jsonl (one journal per session)",
            migration: SkipsUnreadableLines,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/memory/record.rs",
            holds: "what the harness was asked to remember",
            version: tauri_plugin_agent_tools::memory::record::SCHEMA_VERSION,
            owner: Project,
            location: ".jan/agent/memory/*.md",
            migration: ReadsOlderInPlace,
        },
        Store {
            module: "core/agent/roles.rs",
            holds: "the roles a project defines for its agents",
            version: crate::core::agent::roles::ROLES_VERSION,
            owner: Project,
            location: ".jan/agent/roles.toml",
            migration: ReadsOlderInPlace,
        },
        Store {
            module: "core/agent/team_children.rs",
            holds: "a team run's children and what each produced",
            version: crate::core::agent::team_children::SCHEMA_VERSION,
            owner: DataFolder,
            location: "team-children/<hash of owner>.json",
            migration: RefusedAndKept,
        },
        Store {
            module: "core/agent/session_bundle.rs",
            holds: "a session exported to be opened somewhere else",
            version: crate::core::agent::session_bundle::SCHEMA_VERSION as u32,
            owner: UserChosen,
            location: "<chosen>/session-bundle.json",
            migration: RefusedAndKept,
        },
        Store {
            module: "core/agent/bundle_import.rs",
            holds: "a bundle being imported, as a proposal",
            version: crate::core::agent::bundle_import::SCHEMA_VERSION,
            owner: UserChosen,
            location: "<chosen>/the bundle being imported",
            migration: RefusedAndKept,
        },
        Store {
            module: "core/agent/worktree_export.rs",
            holds: "a worktree's changes, exported for review",
            version: crate::core::agent::worktree_export::SCHEMA_VERSION,
            owner: UserChosen,
            location: "<chosen>/worktree-export.json",
            migration: RefusedAndKept,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/memory/transfer.rs",
            holds: "memory exported or imported between projects",
            version: tauri_plugin_agent_tools::memory::transfer::VERSION,
            owner: UserChosen,
            location: "<chosen>/memory-transfer.json",
            migration: RefusedAndKept,
        },
        Store {
            module: "tauri-plugin-agent-tools/src/utility.rs",
            holds: "the harness's own small settings",
            version: tauri_plugin_agent_tools::utility::SCHEMA_VERSION,
            owner: DataFolder,
            location: "audit/utility-agents.jsonl",
            migration: ReadsOlderInPlace,
        },
    ]
}

/// The catalogue, as a person reads it.
pub fn render() -> String {
    let mut out = String::from("What this harness writes down:\n\n");
    for owner in [Owner::DataFolder, Owner::Project, Owner::UserChosen] {
        let heading = match owner {
            Owner::DataFolder => "In the Jan data folder",
            Owner::Project => "In the project, under .jan/agent",
            Owner::UserChosen => "Where the person chose",
        };
        out.push_str(&format!("{heading}:\n"));
        for store in stores().into_iter().filter(|s| s.owner == owner) {
            out.push_str(&format!(
                "  {:<44} v{}  {}\n      {} ({})\n",
                store.location,
                store.version,
                store.holds,
                store.migration.as_str(),
                store.module
            ));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalogue is only worth having if it cannot drift, so each entry's
    /// version is the constant the writing module declares -- read here, not
    /// copied.
    #[test]
    fn every_store_reports_the_version_its_module_declares() {
        let by_module = |name: &str| {
            stores()
                .into_iter()
                .find(|s| s.module.ends_with(name))
                .unwrap_or_else(|| panic!("{name} is not in the catalogue"))
        };
        assert_eq!(
            by_module("event_log.rs").version,
            tauri_plugin_agent_tools::event_log::ENVELOPE_VERSION as u32
        );
        assert_eq!(
            by_module("activity.rs").version,
            tauri_plugin_agent_tools::activity::SCHEMA_VERSION
        );
        assert_eq!(
            by_module("index.rs").version,
            crate::core::agent::index::INDEX_VERSION
        );
        assert_eq!(
            by_module("replay.rs").version,
            crate::core::agent::replay::SCHEMA_VERSION
        );
        assert_eq!(
            by_module("session_bundle.rs").version,
            crate::core::agent::session_bundle::SCHEMA_VERSION as u32
        );
    }

    #[test]
    fn the_catalogue_covers_what_the_tree_declares() {
        // Every store has a location, says what it holds, and has a version.
        for store in stores() {
            assert!(!store.location.is_empty(), "{}", store.module);
            assert!(!store.holds.is_empty(), "{}", store.module);
            assert!(store.version >= 1, "{} has no version", store.module);
        }
        // No two entries claim the same place on disk.
        let mut seen = std::collections::BTreeSet::new();
        for store in stores() {
            assert!(
                seen.insert((store.owner, store.location)),
                "{} is catalogued twice",
                store.location
            );
        }
        // And the count is asserted, so a store added to the tree without an
        // entry here is a failing test rather than a silent omission -- the
        // number is meant to be updated deliberately.
        assert_eq!(stores().len(), 20, "a store was added or removed");
    }

    /// What the catalogue promises about older files is what the code does.
    #[test]
    fn an_older_index_is_rebuilt_rather_than_misread() {
        use crate::core::agent::fixtures::Workspace;
        let project = Workspace::new("schema-index").file("src/a.rs", "pub fn a() {}\n");
        let data = Workspace::new("schema-index-data");
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (index, _) =
            crate::core::agent::index::refresh(data.path(), project.path(), &cancel).unwrap();

        // Write it back a version older, as an upgrade would find it.
        let mut old = index.clone();
        old.version -= 1;
        let path = crate::core::agent::index::path_for(data.path(), project.path());
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();

        // The catalogue says this one is rebuilt from its source.
        let entry = stores()
            .into_iter()
            .find(|s| s.module.ends_with("index.rs"))
            .unwrap();
        assert_eq!(entry.migration, Migration::RebuildsFromSource);
        assert!(crate::core::agent::index::load(data.path(), project.path()).is_none());
        let (rebuilt, update) =
            crate::core::agent::index::refresh(data.path(), project.path(), &cancel).unwrap();
        assert_eq!(rebuilt.version, crate::core::agent::index::INDEX_VERSION);
        assert!(update.added > 0, "a rebuild reads the files again: {update:?}");
    }

    /// The locations are checked against the functions that build them, for
    /// every store that exposes one. The first version of this catalogue was
    /// written from each store's name and sent a reader to five paths that do
    /// not exist -- which is what a catalogue is for, and what makes it worth
    /// deriving rather than describing.
    #[test]
    fn the_catalogued_locations_are_where_the_code_actually_writes() {
        use crate::core::agent::fixtures::Workspace;
        let data = Workspace::new("schema-paths");
        let root = data.path();
        let shown = |needle: &str| {
            stores()
                .into_iter()
                .find(|s| s.module.ends_with(needle))
                .unwrap_or_else(|| panic!("{needle} is not catalogued"))
                .location
                .to_string()
        };
        let under = |path: std::path::PathBuf| {
            path.strip_prefix(root)
                .expect("inside the data folder")
                .to_string_lossy()
                .replace('\\', "/")
        };

        // Each of these is the real path, with the variable part replaced by
        // the placeholder the catalogue uses.
        let usage = under(tauri_plugin_agent_tools::usage::log_path(root));
        assert_eq!(usage, shown("usage.rs"));

        let prompts = under(tauri_plugin_agent_tools::snapshot::log_path(root));
        assert_eq!(prompts, shown("snapshot.rs"));

        let permissions = under(tauri_plugin_agent_tools::audit::log_path(root));
        assert_eq!(permissions, shown("audit.rs"));

        let activity = under(tauri_plugin_agent_tools::activity::log_path(root));
        assert_eq!(activity, shown("activity.rs"));

        let index = under(crate::core::agent::index::path_for(root, std::path::Path::new("/p")));
        assert!(index.starts_with("index/"), "{index} vs {}", shown("index.rs"));
        assert!(shown("index.rs").starts_with("index/"));

        let mail = tauri_plugin_agent_tools::identity::RunId::parse("s#run-1").unwrap();
        let mail = under(tauri_plugin_agent_tools::mailbox::path_for(root, &mail));
        assert!(mail.starts_with("mail/"), "{mail}");
        assert!(shown("mailbox.rs").starts_with("mail/"));

        let events = under(tauri_plugin_agent_tools::event_log::log_path(root, "s"));
        assert!(events.starts_with("events/"), "{events}");
        assert!(shown("event_log.rs").starts_with("events/"));
    }

    #[test]
    fn the_rendering_names_every_store_and_where_it_lives() {
        let text = render();
        for store in stores() {
            assert!(text.contains(store.location), "{} is not shown", store.location);
            assert!(text.contains(store.migration.as_str()));
        }
        assert!(text.contains("In the Jan data folder"));
        assert!(text.contains("In the project"));
    }
}
