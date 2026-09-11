//! Changes that need a closer look than a diff gives them. AH-154/155/156.
//!
//! Some lines matter more than their size: a new dependency brings in code
//! nobody in the project wrote, a lock file decides which bytes are actually
//! downloaded, and a migration changes data in a way a revert does not undo.
//! Each is flagged on the file it is in, from the file's own content, so a
//! reviewer is told what the diff means as well as what it says.
//!
//! The flags are worked out here, from the stored before and after, and again
//! when a change is applied. Nothing the renderer or a model says about a
//! file can add or remove one, and a flagged file is applied only when the
//! approval names it as acknowledged.
//!
//! This reads well-known manifest formats; it is not a package manager. A
//! manifest it cannot read is flagged as unreadable rather than passed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FlagKind {
    /// A dependency added, upgraded, downgraded or removed.
    Dependency,
    /// A lock file changed: which exact versions and sources get installed.
    Lockfile,
    /// A schema or data migration, which a revert of the file does not undo.
    Migration,
    /// Content that is not text, so no diff of it can be read. AH-169.
    Binary,
    /// A file removed. A rename arrives as a removal and an addition, so the
    /// removed half is reviewed as a deletion. AH-169.
    Deletion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFlag {
    pub kind: FlagKind,
    /// One line for the reviewer.
    pub summary: String,
    /// The specific entries, e.g. `left-pad added at ^1.3.0`.
    #[serde(default)]
    pub details: Vec<String>,
}

/// Everything about this change that needs acknowledging, in a fixed order.
pub fn flags_for(path: &str, base: Option<&[u8]>, proposed: Option<&[u8]>) -> Vec<ReviewFlag> {
    let text = |b: Option<&[u8]>| b.map(|b| String::from_utf8_lossy(b).into_owned());
    let (before, after) = (text(base), text(proposed));
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let mut out = Vec::new();
    if let Some(flag) = dependency_flag(&name, before.as_deref(), after.as_deref()) {
        out.push(flag);
    }
    if is_lockfile(&name) {
        out.push(ReviewFlag {
            kind: FlagKind::Lockfile,
            summary: format!(
                "{name} is a lock file: it decides the exact versions and sources that get installed"
            ),
            details: Vec::new(),
        });
    }
    if let Some(flag) = migration_flag(path, after.as_deref(), proposed.is_none()) {
        out.push(flag);
    }
    let not_text = |b: Option<&[u8]>| b.is_some_and(|b| b.contains(&0) || std::str::from_utf8(b).is_err());
    if not_text(base) || not_text(proposed) {
        out.push(ReviewFlag {
            kind: FlagKind::Binary,
            summary: format!("{name} is not text, so its change cannot be shown as a diff"),
            details: Vec::new(),
        });
    }
    if base.is_some() && proposed.is_none() {
        out.push(ReviewFlag {
            kind: FlagKind::Deletion,
            summary: format!("{name} is deleted"),
            details: Vec::new(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/// Manifests whose dependency lists are read and compared.
fn is_parsed_manifest(name: &str) -> bool {
    matches!(name, "package.json" | "cargo.toml" | "go.mod" | "pyproject.toml")
        || (name.starts_with("requirements") && name.ends_with(".txt"))
        || (name.starts_with("constraints") && name.ends_with(".txt"))
}

/// Manifests flagged whenever they change, since their dependency lists are
/// not read here.
fn is_other_manifest(name: &str) -> bool {
    matches!(
        name,
        "gemfile"
            | "composer.json"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "pipfile"
            | "setup.py"
            | "setup.cfg"
            | "packages.config"
            | "directory.packages.props"
            | "pubspec.yaml"
            | "mix.exs"
            | "deno.json"
    ) || name.ends_with(".csproj")
        || name.ends_with(".fsproj")
        || name.ends_with(".vbproj")
        || name.ends_with(".gemspec")
}

pub fn is_lockfile(name: &str) -> bool {
    matches!(
        name,
        "package-lock.json"
            | "npm-shrinkwrap.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lockb"
            | "bun.lock"
            | "cargo.lock"
            | "poetry.lock"
            | "pipfile.lock"
            | "uv.lock"
            | "pdm.lock"
            | "go.sum"
            | "composer.lock"
            | "gemfile.lock"
            | "packages.lock.json"
            | "pubspec.lock"
            | "mix.lock"
            | "deno.lock"
    )
}

type Deps = BTreeMap<String, String>;

fn dependency_flag(name: &str, before: Option<&str>, after: Option<&str>) -> Option<ReviewFlag> {
    if is_other_manifest(name) {
        return Some(ReviewFlag {
            kind: FlagKind::Dependency,
            summary: format!("{name} declares dependencies; its entries are not read here, so review them by hand"),
            details: Vec::new(),
        });
    }
    if !is_parsed_manifest(name) {
        return None;
    }
    let read = |t: Option<&str>| -> Result<Deps, ()> {
        match t {
            None => Ok(Deps::new()),
            Some(t) => parse_manifest(name, t).ok_or(()),
        }
    };
    let (old, new) = match (read(before), read(after)) {
        (Ok(o), Ok(n)) => (o, n),
        _ => {
            return Some(ReviewFlag {
                kind: FlagKind::Dependency,
                summary: format!("{name} could not be read as a manifest, so its dependencies could not be checked"),
                details: Vec::new(),
            })
        }
    };
    let mut details = Vec::new();
    for (dep, version) in &new {
        match old.get(dep) {
            None => details.push(format!("{dep} added at {version}")),
            Some(was) if was != version => details.push(format!("{dep} changed from {was} to {version}")),
            _ => {}
        }
    }
    for (dep, was) in &old {
        if !new.contains_key(dep) {
            details.push(format!("{dep} removed (was {was})"));
        }
    }
    if details.is_empty() {
        return None;
    }
    Some(ReviewFlag {
        kind: FlagKind::Dependency,
        summary: format!("{} dependency change(s) in {name}", details.len()),
        details,
    })
}

/// `name@section` to its version or source, for the formats read here.
fn parse_manifest(name: &str, text: &str) -> Option<Deps> {
    let mut deps = Deps::new();
    match name {
        "package.json" => {
            let doc: Value = serde_json::from_str(text).ok()?;
            for section in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                if let Some(map) = doc.get(section).and_then(Value::as_object) {
                    for (dep, v) in map {
                        deps.insert(format!("{dep} ({section})"), v.as_str().unwrap_or("?").to_string());
                    }
                }
            }
        }
        "cargo.toml" => {
            let doc: toml::Value = text.parse().ok()?;
            let mut read_tables = |prefix: &str, table: &toml::Value| {
                for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
                    if let Some(t) = table.get(section).and_then(toml::Value::as_table) {
                        for (dep, v) in t {
                            deps.insert(format!("{dep} ({prefix}{section})"), cargo_source(v));
                        }
                    }
                }
            };
            read_tables("", &doc);
            if let Some(ws) = doc.get("workspace") {
                read_tables("workspace.", ws);
            }
            if let Some(targets) = doc.get("target").and_then(toml::Value::as_table) {
                for (cfg, t) in targets {
                    read_tables(&format!("target.{cfg}."), t);
                }
            }
        }
        "pyproject.toml" => {
            let doc: toml::Value = text.parse().ok()?;
            if let Some(list) = doc.get("project").and_then(|p| p.get("dependencies")).and_then(toml::Value::as_array) {
                for spec in list.iter().filter_map(toml::Value::as_str) {
                    let (dep, version) = split_requirement(spec);
                    deps.insert(format!("{dep} (project)"), version);
                }
            }
            if let Some(groups) = doc
                .get("project")
                .and_then(|p| p.get("optional-dependencies"))
                .and_then(toml::Value::as_table)
            {
                for (group, list) in groups {
                    for spec in list.as_array().into_iter().flatten().filter_map(toml::Value::as_str) {
                        let (dep, version) = split_requirement(spec);
                        deps.insert(format!("{dep} ({group})"), version);
                    }
                }
            }
            if let Some(t) = doc
                .get("tool")
                .and_then(|t| t.get("poetry"))
                .and_then(|p| p.get("dependencies"))
                .and_then(toml::Value::as_table)
            {
                for (dep, v) in t {
                    deps.insert(format!("{dep} (poetry)"), cargo_source(v));
                }
            }
        }
        "go.mod" => {
            let mut in_block = false;
            for line in text.lines().map(str::trim) {
                let line = line.split("//").next().unwrap_or("").trim();
                if line.starts_with("require (") {
                    in_block = true;
                    continue;
                }
                if in_block && line == ")" {
                    in_block = false;
                    continue;
                }
                let spec = if in_block {
                    line
                } else if let Some(rest) = line.strip_prefix("require ") {
                    rest.trim()
                } else {
                    continue;
                };
                let mut parts = spec.split_whitespace();
                if let (Some(module), Some(version)) = (parts.next(), parts.next()) {
                    deps.insert(module.to_string(), version.to_string());
                }
            }
        }
        _ => {
            // requirements*.txt and constraints*.txt
            for line in text.lines() {
                let line = line.split('#').next().unwrap_or("").trim();
                if line.is_empty() || line.starts_with('-') {
                    continue;
                }
                let (dep, version) = split_requirement(line);
                deps.insert(dep, version);
            }
        }
    }
    Some(deps)
}

/// A Cargo or Poetry dependency's version, or where it comes from.
fn cargo_source(v: &toml::Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    let Some(t) = v.as_table() else {
        return "?".into();
    };
    let mut parts = Vec::new();
    for key in ["version", "git", "branch", "tag", "rev", "path", "registry"] {
        if let Some(value) = t.get(key).and_then(toml::Value::as_str) {
            parts.push(format!("{key} {value}"));
        }
    }
    if t.get("workspace").and_then(toml::Value::as_bool) == Some(true) {
        parts.push("workspace".into());
    }
    if parts.is_empty() {
        "?".into()
    } else {
        parts.join(", ")
    }
}

/// `requests>=2.31` into its name and what it asks for.
fn split_requirement(spec: &str) -> (String, String) {
    let spec = spec.split(';').next().unwrap_or(spec).trim();
    let at = spec
        .find(|c: char| matches!(c, '=' | '<' | '>' | '~' | '!' | '@' | ' ' | '['))
        .unwrap_or(spec.len());
    let name = spec[..at].trim().to_ascii_lowercase().replace('_', "-");
    let rest = spec[at..].trim();
    (name, if rest.is_empty() { "any version".into() } else { rest.to_string() })
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

fn in_migration_directory(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let parts: Vec<&str> = lower.split('/').collect();
    let dirs = &parts[..parts.len().saturating_sub(1)];
    dirs.iter().any(|d| matches!(*d, "migrations" | "migration" | "migrate" | "alembic" | "flyway"))
        || lower.contains("db/migrate/")
        || lower.contains("prisma/migrations/")
        || parts
            .last()
            .is_some_and(|f| f.starts_with('v') && f.contains("__") && f.ends_with(".sql"))
}

fn migration_flag(path: &str, after: Option<&str>, deleted: bool) -> Option<ReviewFlag> {
    let is_sql = path.to_ascii_lowercase().ends_with(".sql");
    let sql = after.map(sql_effects).unwrap_or_default();
    let in_dir = in_migration_directory(path);
    if !in_dir && !(is_sql && (sql.schema || sql.data)) {
        return None;
    }
    if deleted {
        return Some(ReviewFlag {
            kind: FlagKind::Migration,
            summary: "a migration is deleted: databases that already ran it keep its effects, and new ones will not get them".into(),
            details: Vec::new(),
        });
    }
    let what = match (sql.schema, sql.data) {
        (true, true) => "schema and data",
        (true, false) => "schema",
        (false, true) => "data",
        (false, false) => "a",
    };
    let mut details = sql.statements;
    details.truncate(12);
    Some(ReviewFlag {
        kind: FlagKind::Migration,
        summary: format!(
            "{what} migration: once it runs against a database, reverting this file does not undo it"
        ),
        details,
    })
}

#[derive(Default)]
struct SqlEffects {
    schema: bool,
    data: bool,
    statements: Vec<String>,
}

fn sql_effects(text: &str) -> SqlEffects {
    let mut out = SqlEffects::default();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("--") {
            continue;
        }
        let upper = trimmed.to_ascii_uppercase();
        let schema = ["CREATE TABLE", "ALTER TABLE", "DROP TABLE", "DROP COLUMN", "RENAME ", "CREATE INDEX", "DROP INDEX", "TRUNCATE", "DROP SCHEMA", "CREATE TYPE", "DROP TYPE"]
            .iter()
            .any(|k| upper.contains(k));
        let data = ["INSERT INTO", "UPDATE ", "DELETE FROM"].iter().any(|k| upper.starts_with(k) || upper.contains(&format!(" {k}")));
        if schema || data {
            out.schema |= schema;
            out.data |= data;
            let mut shown: String = trimmed.chars().take(120).collect();
            if trimmed.chars().count() > 120 {
                shown.push('…');
            }
            out.statements.push(shown);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(path: &str, before: Option<&str>, after: Option<&str>) -> Vec<FlagKind> {
        flags_for(path, before.map(str::as_bytes), after.map(str::as_bytes))
            .into_iter()
            .map(|f| f.kind)
            .collect()
    }

    fn details(path: &str, before: Option<&str>, after: Option<&str>) -> Vec<String> {
        flags_for(path, before.map(str::as_bytes), after.map(str::as_bytes))
            .into_iter()
            .flat_map(|f| f.details)
            .collect()
    }

    #[test]
    fn a_package_added_upgraded_or_removed_is_flagged_with_what_changed() {
        let before = r#"{"name":"x","dependencies":{"react":"^18.0.0","lodash":"^4.17.0"}}"#;
        let after = r#"{"name":"x","dependencies":{"react":"^19.0.0","left-pad":"1.3.0"},"devDependencies":{"vitest":"^3"}}"#;
        let d = details("web/package.json", Some(before), Some(after));
        assert!(d.contains(&"left-pad (dependencies) added at 1.3.0".to_string()), "{d:?}");
        assert!(d.contains(&"react (dependencies) changed from ^18.0.0 to ^19.0.0".to_string()), "{d:?}");
        assert!(d.contains(&"vitest (devDependencies) added at ^3".to_string()), "{d:?}");
        assert!(d.contains(&"lodash (dependencies) removed (was ^4.17.0)".to_string()), "{d:?}");
    }

    #[test]
    fn a_manifest_change_that_leaves_dependencies_alone_is_not_flagged() {
        let before = r#"{"name":"x","version":"1.0.0","dependencies":{"a":"1"}}"#;
        let after = r#"{"version":"1.0.1","name":"x","dependencies":{"a":"1"}}"#;
        assert!(kinds("package.json", Some(before), Some(after)).is_empty());
        assert!(kinds("src/main.rs", Some("a"), Some("b")).is_empty());
    }

    #[test]
    fn cargo_dependencies_in_every_table_are_compared() {
        let before = "[package]\nname='x'\n[dependencies]\nserde = \"1\"\n";
        let after = "[package]\nname='x'\n[dependencies]\nserde = \"1\"\nevil = { git = \"https://example.com/evil\" }\n[target.'cfg(windows)'.dependencies]\nwinapi = \"0.3\"\n[workspace.dependencies]\ntokio = { version = \"1\", features = [\"full\"] }\n";
        let d = details("Cargo.toml", Some(before), Some(after));
        assert!(d.iter().any(|x| x.starts_with("evil (dependencies) added at git https://example.com/evil")), "{d:?}");
        assert!(d.iter().any(|x| x.starts_with("winapi (target.cfg(windows).dependencies)")), "{d:?}");
        assert!(d.iter().any(|x| x.starts_with("tokio (workspace.dependencies) added at version 1")), "{d:?}");
    }

    #[test]
    fn python_and_go_requirements_are_compared() {
        let d = details("requirements.txt", Some("requests==2.31\n# c\n"), Some("requests==2.32\nurllib3>=2\n"));
        assert!(d.contains(&"requests changed from ==2.31 to ==2.32".to_string()), "{d:?}");
        assert!(d.contains(&"urllib3 added at >=2".to_string()), "{d:?}");
        let before = "module m\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n";
        let after = "module m\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.1.0\n\tgithub.com/c/d v0.1.0 // indirect\n)\n";
        let d = details("go.mod", Some(before), Some(after));
        assert!(d.contains(&"github.com/a/b changed from v1.0.0 to v1.1.0".to_string()), "{d:?}");
        assert!(d.contains(&"github.com/c/d added at v0.1.0".to_string()), "{d:?}");
        let d = details("pyproject.toml", None, Some("[project]\nname='x'\ndependencies=['httpx>=0.27']\n"));
        assert!(d.contains(&"httpx (project) added at >=0.27".to_string()), "{d:?}");
    }

    #[test]
    fn an_unreadable_manifest_is_flagged_not_passed() {
        let flags = flags_for("package.json", Some(b"{}"), Some(b"{ not json"));
        assert_eq!(flags.len(), 1);
        assert!(flags[0].summary.contains("could not be read"), "{}", flags[0].summary);
    }

    #[test]
    fn binary_content_and_deletions_are_flagged() {
        let k = |p: &str, b: Option<&[u8]>, n: Option<&[u8]>| -> Vec<FlagKind> {
            flags_for(p, b, n).into_iter().map(|f| f.kind).collect()
        };
        assert_eq!(k("logo.png", None, Some(&[0x89, 0, 1])), vec![FlagKind::Binary]);
        assert_eq!(k("logo.png", Some(&[0x89, 0, 1]), None), vec![FlagKind::Binary, FlagKind::Deletion]);
        assert_eq!(k("notes.txt", Some(b"a\n"), None), vec![FlagKind::Deletion]);
        assert_eq!(k("latin1.txt", Some(b"a"), Some(&[0xE9])), vec![FlagKind::Binary]);
        assert!(k("notes.txt", Some(b"a\n"), Some(b"b\n")).is_empty());
    }

    #[test]
    fn lock_files_are_flagged_on_their_own() {
        assert_eq!(kinds("Cargo.lock", Some("a"), Some("b")), vec![FlagKind::Lockfile]);
        assert_eq!(kinds("web/yarn.lock", None, Some("b")), vec![FlagKind::Lockfile]);
        assert_eq!(kinds("go.sum", Some("a"), None), vec![FlagKind::Lockfile, FlagKind::Deletion]);
        assert!(kinds("notes/lock.md", Some("a"), Some("b")).is_empty());
    }

    #[test]
    fn migrations_are_flagged_as_irreversible_by_what_they_do() {
        let schema = flags_for(
            "db/migrations/0002_users.sql",
            None,
            Some(b"-- add\nALTER TABLE users ADD COLUMN email text;\n"),
        );
        assert_eq!(schema[0].kind, FlagKind::Migration);
        assert!(schema[0].summary.starts_with("schema migration"), "{}", schema[0].summary);
        assert!(schema[0].details[0].contains("ALTER TABLE users"));

        let data = flags_for("scripts/backfill.sql", None, Some(b"UPDATE users SET plan = 'free';\n"));
        assert!(data[0].summary.starts_with("data migration"), "{}", data[0].summary);

        let py = flags_for("app/migrations/0003_auto.py", None, Some(b"operations = []\n"));
        assert_eq!(py[0].kind, FlagKind::Migration);

        let gone = flags_for("migrations/0001.sql", Some(b"CREATE TABLE a(x int);"), None);
        assert!(gone[0].summary.contains("deleted"), "{}", gone[0].summary);

        assert!(kinds("docs/schema.sql", None, Some("-- nothing here\nSELECT 1;\n")).is_empty());
        assert!(kinds("src/migrate.rs", None, Some("fn main() {}")).is_empty());
    }
}
