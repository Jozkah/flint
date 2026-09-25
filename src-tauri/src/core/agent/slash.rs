//! The desktop slash-command catalog: what the `/` menu of the Home, Cowork
//! and Rooms composers offers, filtered by the per-surface enablement matrix.
//!
//! Two kinds of entries:
//!   - plugin commands (`<plugin>/commands/**/*.md`, the Claude Code command
//!     format). The body and frontmatter travel with the entry so the web app
//!     expands `$ARGUMENTS` / `$1..$9` itself (`web-app/src/lib/slashCommands.ts`).
//!   - user-invocable skills. Invoking one goes back through
//!     [`invoke_skill`], which reuses the agent's own invocation message
//!     (`skills::build_invocation_message`) so a skill fired from the desktop
//!     reads exactly like one fired from the console.
//!
//! A surface with no project folder (Home, Rooms) sees only the user's own
//! global skills and plugins; a Cowork surface also sees its folder's.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::agent::extensions::{ItemKind, Matrix, Surface};
use crate::core::agent::{plugin_commands, skills};

/// One row of the slash menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashEntry {
    /// `"command"` or `"skill"`.
    pub kind: &'static str,
    /// Plain name: the command's file stem, or the skill name without its
    /// `<plugin>:` qualifier.
    pub name: String,
    /// The plugin that ships the entry, `None` for a standalone skill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub description: String,
    /// `"project"` when it comes from the folder's `.jan/agent/`, `"global"`
    /// for the user's own store.
    pub scope: &'static str,
    /// Frontmatter `argument-hint` (commands).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Frontmatter `model` (commands).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Frontmatter `allowed-tools` (commands), split into names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Placeholders the body uses (`$1`..`$9`, `$ARGUMENTS`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
    /// The command template with frontmatter stripped. `None` for skills,
    /// whose body is loaded on invocation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Claude Code command frontmatter. `allowed-tools` may be a string
/// (`Bash(git:*), Read`) or a list.
#[derive(Debug, Default, Deserialize)]
struct CommandFrontmatter {
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "argument-hint")]
    argument_hint: Option<serde_yaml::Value>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, rename = "allowed-tools")]
    allowed_tools: Option<serde_yaml::Value>,
}

fn yaml_text(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(s) => Some(s.trim().to_string()),
        // `argument-hint: [pr-number]` parses as a sequence; keep it readable.
        serde_yaml::Value::Sequence(items) => Some(format!(
            "[{}]",
            items
                .iter()
                .filter_map(yaml_text)
                .collect::<Vec<_>>()
                .join("] [")
        )),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty())
}

fn tool_list(value: &serde_yaml::Value) -> Vec<String> {
    match value {
        serde_yaml::Value::String(s) => split_tools(s),
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .filter_map(|v| v.as_str())
            .flat_map(split_tools)
            .collect(),
        _ => Vec::new(),
    }
}

/// Split `Bash(git add:*), Read` on the commas outside parentheses.
fn split_tools(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth <= 0 => {
                if !current.trim().is_empty() {
                    out.push(current.trim().to_string());
                }
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Parse one command file into a slash entry.
fn command_entry(entry: &plugin_commands::CommandEntry, scope: &'static str) -> SlashEntry {
    let raw = std::fs::read_to_string(&entry.file).unwrap_or_default();
    let (yaml, body) = skills::split_frontmatter(&raw);
    let fm = yaml
        .as_deref()
        .and_then(|y| serde_yaml::from_str::<CommandFrontmatter>(y).ok())
        .unwrap_or_default();
    SlashEntry {
        kind: "command",
        name: entry.name.clone(),
        plugin: Some(entry.plugin.clone()),
        description: fm
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| entry.description.clone()),
        scope,
        argument_hint: fm.argument_hint.as_ref().and_then(yaml_text),
        model: fm
            .model
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        allowed_tools: fm.allowed_tools.as_ref().map(tool_list).unwrap_or_default(),
        hints: entry.hints.clone(),
        body: Some(body),
    }
}

fn is_under(path: &Path, dir: Option<PathBuf>) -> bool {
    dir.is_some_and(|d| path.starts_with(d))
}

fn command_scope(entry: &plugin_commands::CommandEntry) -> &'static str {
    if is_under(&entry.file, skills::user_plugins_dir()) {
        "global"
    } else {
        "project"
    }
}

/// The matrix id a skill is toggled under: its plugin, or its own name.
fn skill_item(meta: &skills::SkillMeta) -> (ItemKind, String) {
    match &meta.plugin {
        Some(p) => (ItemKind::Plugin, p.clone()),
        None => (ItemKind::Skill, meta.name.clone()),
    }
}

fn plain_skill_name(meta: &skills::SkillMeta) -> String {
    match &meta.plugin {
        Some(p) => meta
            .name
            .strip_prefix(&format!("{p}:"))
            .unwrap_or(&meta.name)
            .to_string(),
        None => meta.name.clone(),
    }
}

/// User-invocable skills visible on the surface, before the matrix filter.
fn surface_skills(project: Option<&Path>) -> Vec<skills::SkillMeta> {
    match project {
        Some(root) => {
            let enabled = crate::core::agent::project::enabled_skills(root);
            skills::user_catalog(root, &enabled)
        }
        None => skills::global_user_catalog(),
    }
}

fn skill_scope(project: Option<&Path>, meta: &skills::SkillMeta) -> &'static str {
    let Some(root) = project else {
        return "global";
    };
    match skills::resolve_readable(root, &meta.name) {
        Ok(entry)
            if is_under(&entry.file, skills::user_skills_dir())
                || is_under(&entry.file, skills::user_plugins_dir()) =>
        {
            "global"
        }
        Ok(_) => "project",
        // The built-in Flint skill ships with the app.
        Err(_) => "global",
    }
}

/// Everything the `/` menu offers on `surface`: plugin commands first, then
/// skills, each honoring `[plugins].disabled`, the project's `[skills].enabled`
/// whitelist and the per-surface enablement matrix.
pub(crate) fn catalog(surface: &Surface, project: Option<&Path>) -> Vec<SlashEntry> {
    let matrix = Matrix::load();
    let mut out = Vec::new();

    let commands = match project {
        Some(root) => {
            let enabled = crate::core::agent::project::enabled_skills(root);
            plugin_commands::catalog(root, &enabled)
        }
        None => {
            let mut global = Vec::new();
            if let Some(dir) = skills::user_plugins_dir() {
                plugin_commands::scan_dir(&dir, &[], &mut global);
            }
            global.sort_by(|a, b| (&a.plugin, &a.name).cmp(&(&b.plugin, &b.name)));
            global
        }
    };
    for entry in &commands {
        if matrix.is_enabled(ItemKind::Plugin, &entry.plugin, surface) {
            out.push(command_entry(entry, command_scope(entry)));
        }
    }

    for meta in surface_skills(project) {
        let (kind, id) = skill_item(&meta);
        if !matrix.is_enabled(kind, &id, surface) {
            continue;
        }
        out.push(SlashEntry {
            kind: "skill",
            name: plain_skill_name(&meta),
            plugin: meta.plugin.clone(),
            description: meta.description.clone(),
            scope: skill_scope(project, &meta),
            argument_hint: None,
            model: None,
            allowed_tools: Vec::new(),
            hints: Vec::new(),
            body: None,
        });
    }
    out
}

/// The user message that invokes skill `name` (plain or `<plugin>:<name>`)
/// with `args` as the task. Refuses a skill the surface does not offer, so a
/// toggle in the enablement grid cannot be bypassed by typing the name.
pub(crate) fn invoke_skill(
    surface: &Surface,
    project: Option<&Path>,
    name: &str,
    args: &str,
) -> Result<String, String> {
    let offered = catalog(surface, project);
    let matches: Vec<&SlashEntry> = offered
        .iter()
        .filter(|e| e.kind == "skill")
        .filter(|e| {
            let qualified = match &e.plugin {
                Some(p) => format!("{p}:{}", e.name),
                None => e.name.clone(),
            };
            qualified == name || e.name == name
        })
        .collect();
    let entry = match matches.as_slice() {
        [one] => *one,
        [] => return Err(format!("skill '{name}' is not available here")),
        _ => {
            return Err(format!(
                "skill '{name}' is ambiguous; qualify it with its plugin"
            ))
        }
    };
    let qualified = match &entry.plugin {
        Some(p) => format!("{p}:{}", entry.name),
        None => entry.name.clone(),
    };
    match project {
        Some(root) => skills::build_invocation_message(root, &qualified, args).map(|(m, _)| m),
        None => global_invocation(&qualified, args),
    }
}

/// `build_invocation_message` for a folderless surface: the same message,
/// read from the user's own skills and plugins only.
fn global_invocation(qualified: &str, args: &str) -> Result<String, String> {
    let mut entries = skills::discover_user(&[]);
    entries.extend(skills::discover_user_plugins(&[]));
    let body = match entries
        .iter()
        .find(|e| skills::qualified_name(e) == qualified)
    {
        Some(entry) => {
            let raw = std::fs::read_to_string(&entry.file).map_err(|e| format!("ERROR: {e}"))?;
            let mut body = skills::parse(&raw).body;
            if entry.is_folder {
                let base = entry.file.parent().unwrap_or(Path::new(""));
                body.push_str(&format!(
                    "\n\n---\n[Skill directory: {}]\nResolve relative paths in the skill against that directory.\n",
                    base.display()
                ));
            }
            body
        }
        // The built-in skill has no file; the project path serves it from
        // the embedded copy, and any path works for that.
        None => {
            return skills::build_invocation_message(&std::env::temp_dir(), qualified, args)
                .map(|(m, _)| m)
        }
    };
    let mut msg = format!(
        "{}\n\n{body}",
        skills::invocation_wrapper(qualified, "skill")
    );
    let args = args.trim();
    if !args.is_empty() {
        if !msg.ends_with('\n') {
            msg.push('\n');
        }
        msg.push_str(&format!("User: {args}\n"));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::extensions::set_test_extensions_root;
    use crate::core::agent::skills::{plugins_dir, set_test_user_plugins, set_test_user_skills};

    fn temp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "jan_slash_{tag}_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ))
    }

    fn write(path: PathBuf, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// Isolate the user stores and the matrix for one test.
    struct Env {
        dirs: Vec<PathBuf>,
    }
    impl Env {
        fn new(tag: &str) -> (Env, PathBuf, PathBuf) {
            let user = temp(&format!("{tag}_user"));
            let ext = temp(&format!("{tag}_ext"));
            std::fs::create_dir_all(&user).unwrap();
            std::fs::create_dir_all(&ext).unwrap();
            set_test_user_skills(Some(user.clone()));
            set_test_user_plugins(Some(user.clone()));
            set_test_extensions_root(Some(ext.clone()));
            (
                Env {
                    dirs: vec![user.clone(), ext],
                },
                user,
                temp(&format!("{tag}_proj")),
            )
        }
    }
    impl Drop for Env {
        fn drop(&mut self) {
            set_test_user_skills(None);
            set_test_user_plugins(None);
            set_test_extensions_root(None);
            for d in &self.dirs {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    }

    #[test]
    fn command_frontmatter_is_carried_to_the_menu() {
        let (_env, _user, root) = Env::new("fm");
        write(
            plugins_dir(&root).join("git").join("commands").join("commit.md"),
            "---\ndescription: Make a commit\nargument-hint: [message]\nmodel: claude-haiku\nallowed-tools: Bash(git add:*, git commit:*), Read\n---\n\nCommit with $ARGUMENTS\n",
        );
        let entries = catalog(&Surface::Cowork("p".into()), Some(&root));
        let commit = entries.iter().find(|e| e.name == "commit").unwrap();
        assert_eq!(commit.kind, "command");
        assert_eq!(commit.plugin.as_deref(), Some("git"));
        assert_eq!(commit.description, "Make a commit");
        assert_eq!(commit.argument_hint.as_deref(), Some("[message]"));
        assert_eq!(commit.model.as_deref(), Some("claude-haiku"));
        assert_eq!(
            commit.allowed_tools,
            vec![
                "Bash(git add:*, git commit:*)".to_string(),
                "Read".to_string()
            ]
        );
        assert_eq!(commit.scope, "project");
        assert_eq!(commit.body.as_deref(), Some("Commit with $ARGUMENTS"));
        assert_eq!(commit.hints, vec!["$ARGUMENTS"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn matrix_filters_commands_and_skills_per_surface() {
        let (_env, user, _root) = Env::new("matrix");
        let plugins = tauri_plugin_agent_tools::skills::plugins_dir(&user);
        write(
            plugins.join("rel").join("commands").join("ship.md"),
            "Ship $1\n",
        );
        write(
            plugins
                .join("rel")
                .join("skills")
                .join("prep")
                .join("SKILL.md"),
            "---\ndescription: Prep\n---\nPrep steps.\n",
        );
        write(
            tauri_plugin_agent_tools::skills::skills_dir(&user)
                .join("notes")
                .join("SKILL.md"),
            "---\ndescription: Notes\n---\nTake notes.\n",
        );

        let home = catalog(&Surface::Home, None);
        let names: Vec<_> = home.iter().map(|e| (e.kind, e.name.as_str())).collect();
        assert!(names.contains(&("command", "ship")), "{names:?}");
        assert!(names.contains(&("skill", "prep")), "{names:?}");
        assert!(names.contains(&("skill", "notes")), "{names:?}");
        assert!(home.iter().all(|e| e.scope == "global"));

        // Restrict the plugin to Rooms: Home loses its command and skill.
        let mut matrix = Matrix::load();
        matrix.set_item(ItemKind::Plugin, "rel", vec!["rooms".into()]);
        matrix.save();
        let home = catalog(&Surface::Home, None);
        assert!(!home.iter().any(|e| e.plugin.as_deref() == Some("rel")));
        assert!(home.iter().any(|e| e.name == "notes"));
        let rooms = catalog(&Surface::Rooms, None);
        assert!(rooms.iter().any(|e| e.name == "ship"));
        // A skill the surface does not offer cannot be invoked by name.
        assert!(invoke_skill(&Surface::Home, None, "rel:prep", "").is_err());
        assert!(invoke_skill(&Surface::Rooms, None, "prep", "").is_ok());
    }

    #[test]
    fn disabled_project_plugin_offers_no_commands() {
        let (_env, _user, root) = Env::new("disabled");
        write(
            plugins_dir(&root)
                .join("rel")
                .join("commands")
                .join("ship.md"),
            "Ship\n",
        );
        write(
            root.join(".jan").join("agent").join("agent.toml"),
            "[plugins]\ndisabled = [\"rel\"]\n",
        );
        let entries = catalog(&Surface::Cowork("x".into()), Some(&root));
        assert!(!entries.iter().any(|e| e.name == "ship"), "{entries:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn global_skill_invocation_loads_the_body_with_args() {
        let (_env, user, _root) = Env::new("invoke");
        write(
            tauri_plugin_agent_tools::skills::skills_dir(&user)
                .join("deploy")
                .join("SKILL.md"),
            "---\ndescription: Ship it\n---\n# Deploy\n\nRun the script.\n",
        );
        let msg = invoke_skill(&Surface::Home, None, "deploy", "staging").unwrap();
        assert!(
            msg.contains("You have invoked the \"deploy\" skill"),
            "{msg}"
        );
        assert!(msg.contains("Run the script."), "{msg}");
        assert!(msg.contains("[Skill directory:"), "{msg}");
        assert!(msg.ends_with("User: staging\n"), "{msg}");
        assert!(invoke_skill(&Surface::Home, None, "nope", "").is_err());
    }

    #[test]
    fn project_skill_invocation_reuses_the_agent_message() {
        let (_env, _user, root) = Env::new("proj");
        write(
            crate::core::agent::skills::skills_dir(&root)
                .join("review")
                .join("SKILL.md"),
            "---\ndescription: Review\n---\nReview the diff.\n",
        );
        let entries = catalog(&Surface::Cowork("x".into()), Some(&root));
        let review = entries.iter().find(|e| e.name == "review").unwrap();
        assert_eq!(review.scope, "project");
        let msg =
            invoke_skill(&Surface::Cowork("x".into()), Some(&root), "review", "main").unwrap();
        assert!(msg.contains("Review the diff."), "{msg}");
        assert!(msg.contains("User: main"), "{msg}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn split_tools_respects_parentheses() {
        assert_eq!(
            split_tools("Bash(a:*, b:*), Read ,Edit"),
            vec!["Bash(a:*, b:*)", "Read", "Edit"]
        );
        assert!(split_tools("  ").is_empty());
    }
}
