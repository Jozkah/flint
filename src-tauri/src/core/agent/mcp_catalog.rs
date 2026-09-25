//! MCP tools loaded on demand.
//!
//! Every connected MCP server's tool schemas used to go into every request.
//! A handful of servers is fine; a setup with a few large ones sent 142 tools
//! and 113,000 characters of JSON before the user typed anything, which fills a
//! small model's window and is paid again on every turn.
//!
//! Past [`DEFER_THRESHOLD_CHARS`] the MCP schemas are held back. The model gets
//! one small tool, [`TOOL_NAME`], whose description names the servers and how
//! many tools each offers. It searches the held-back tools by name and
//! description, and loads the ones it needs; a loaded tool's schema is added to
//! the request from the next step on. Loaded tools are only ever appended, in
//! the order they were loaded, so the tool array grows at its end and a
//! provider's prefix cache over everything before it still holds.
//!
//! Dispatch is untouched: a call is routed by the run's tool-to-server map,
//! which keeps every tool whether its schema was sent or not.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{json, Value};

/// The name of the search-and-load tool.
pub(crate) const TOOL_NAME: &str = "mcp_tools";

/// MCP schemas up to this size, in characters of JSON, are sent as they
/// always were. Past it they are held back and loaded on demand.
pub(crate) const DEFER_THRESHOLD_CHARS: usize = 20_000;

/// The most search results one call returns.
const MAX_RESULTS: usize = 15;

/// The MCP tools held back from this run's requests, and those loaded so far.
pub(crate) struct DeferredMcpTools {
    /// Every held-back schema, by advertised tool name.
    catalog: BTreeMap<String, Value>,
    /// The server each tool belongs to, for search results and the summary.
    servers: BTreeMap<String, String>,
    /// Names loaded so far, in load order.
    loaded: Mutex<Vec<String>>,
}

fn tool_name(schema: &Value) -> Option<&str> {
    schema["function"]["name"].as_str()
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max - 3).collect();
    format!("{}...", cut.trim_end())
}

impl DeferredMcpTools {
    /// Hold back the MCP schemas in `tools` when together they exceed
    /// [`DEFER_THRESHOLD_CHARS`]. `tool_to_server` names which entries of
    /// `tools` are MCP tools. Returns `None`, and leaves `tools` alone, when
    /// they fit.
    pub(crate) fn hold_back(
        tools: &mut Vec<Value>,
        tool_to_server: &std::collections::HashMap<String, String>,
    ) -> Option<Self> {
        let is_mcp = |schema: &Value| tool_name(schema).is_some_and(|n| tool_to_server.contains_key(n));
        let size: usize = tools
            .iter()
            .filter(|s| is_mcp(s))
            .map(|s| s.to_string().len())
            .sum();
        if size <= DEFER_THRESHOLD_CHARS {
            return None;
        }
        let mut catalog = BTreeMap::new();
        let mut servers = BTreeMap::new();
        tools.retain(|schema| {
            if !is_mcp(schema) {
                return true;
            }
            let name = tool_name(schema).unwrap_or_default().to_string();
            if let Some(server) = tool_to_server.get(&name) {
                servers.insert(name.clone(), server.clone());
            }
            catalog.insert(name, schema.clone());
            false
        });
        Some(Self { catalog, servers, loaded: Mutex::new(Vec::new()) })
    }

    /// The schema of [`TOOL_NAME`]. Its description is the index: which
    /// servers are connected and how many tools each has.
    pub(crate) fn tool_schema(&self) -> Value {
        let mut per_server: BTreeMap<&str, usize> = BTreeMap::new();
        for server in self.servers.values() {
            *per_server.entry(server.as_str()).or_default() += 1;
        }
        let servers = per_server
            .iter()
            .map(|(s, n)| format!("{s} ({n})"))
            .collect::<Vec<_>>()
            .join(", ");
        json!({
            "type": "function",
            "function": {
                "name": TOOL_NAME,
                "description": format!(
                    "Find and load tools from the connected MCP servers. {} MCP tools are not in your tool \
                     list, to keep requests small: {servers}. Call with action `search` and a `query` to find \
                     tools by name or purpose, then action `load` with their `names`; a loaded tool can be \
                     called from your next step.",
                    self.catalog.len()
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["search", "load"] },
                        "query": { "type": "string", "description": "For `search`: words to match against tool names, servers and descriptions." },
                        "names": { "type": "array", "items": { "type": "string" }, "description": "For `load`: exact tool names from a search." }
                    },
                    "required": ["action"]
                }
            }
        })
    }

    /// Answer one call to [`TOOL_NAME`].
    pub(crate) fn handle(&self, args: &Value) -> String {
        match args["action"].as_str() {
            Some("search") => self.search(args["query"].as_str().unwrap_or("")),
            Some("load") => {
                let names: Vec<String> = args["names"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                self.load(&names)
            }
            _ => "ERROR: `action` must be `search` or `load`.".to_string(),
        }
    }

    fn search(&self, query: &str) -> String {
        let words: Vec<String> = query
            .split_whitespace()
            .map(str::to_lowercase)
            .filter(|w| !w.is_empty())
            .collect();
        let mut scored: Vec<(usize, &String)> = self
            .catalog
            .iter()
            .filter_map(|(name, schema)| {
                let server = self.servers.get(name).map(String::as_str).unwrap_or("");
                let hay = format!(
                    "{} {} {}",
                    name.to_lowercase(),
                    server.to_lowercase(),
                    schema["function"]["description"].as_str().unwrap_or("").to_lowercase()
                );
                let score = if words.is_empty() { 1 } else { words.iter().filter(|w| hay.contains(w.as_str())).count() };
                (score > 0).then_some((score, name))
            })
            .collect();
        if scored.is_empty() {
            return format!("No MCP tool matches `{query}`. Try other words, or a server name.");
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        let total = scored.len();
        let mut out: Vec<String> = scored
            .into_iter()
            .take(MAX_RESULTS)
            .map(|(_, name)| {
                let schema = &self.catalog[name];
                let server = self.servers.get(name).map(String::as_str).unwrap_or("?");
                let description = first_line(schema["function"]["description"].as_str().unwrap_or(""), 140);
                format!("{name} ({server}) — {description}")
            })
            .collect();
        if total > MAX_RESULTS {
            out.push(format!("...and {} more; narrow the query.", total - MAX_RESULTS));
        }
        out.push("Load the ones you need with action `load`.".to_string());
        out.join("\n")
    }

    fn load(&self, names: &[String]) -> String {
        if names.is_empty() {
            return "ERROR: `load` needs `names`, from a search.".to_string();
        }
        let mut loaded = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        let mut added = Vec::new();
        let mut unknown = Vec::new();
        for name in names {
            if !self.catalog.contains_key(name) {
                unknown.push(name.as_str());
            } else if !loaded.contains(name) {
                loaded.push(name.clone());
                added.push(name.as_str());
            }
        }
        let mut out = Vec::new();
        if !added.is_empty() {
            out.push(format!("Loaded: {}. They can be called from your next step.", added.join(", ")));
        }
        if added.is_empty() && unknown.is_empty() {
            out.push("Already loaded.".to_string());
        }
        if !unknown.is_empty() {
            out.push(format!("Not found: {}. Use exact names from a search.", unknown.join(", ")));
        }
        out.join(" ")
    }

    /// The loaded schemas, in load order, to append to the request's tools.
    pub(crate) fn loaded_schemas(&self) -> Vec<Value> {
        let loaded = self.loaded.lock().unwrap_or_else(|p| p.into_inner());
        loaded.iter().filter_map(|n| self.catalog.get(n).cloned()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn schema(name: &str, description: &str) -> Value {
        json!({ "type": "function", "function": { "name": name, "description": description, "parameters": { "type": "object", "properties": {} } } })
    }

    fn big_setup() -> (Vec<Value>, HashMap<String, String>) {
        let padding = "x".repeat(400);
        let mut tools = vec![schema("read", "Read a file")];
        let mut map = HashMap::new();
        for i in 0..60 {
            let name = format!("notes_tool_{i}");
            tools.push(schema(&name, &format!("Search notes page {i}. {padding}")));
            map.insert(name, "notes".to_string());
        }
        tools.push(schema("browser_click", "Click an element in the browser"));
        map.insert("browser_click".into(), "playwright".into());
        (tools, map)
    }

    #[test]
    fn small_setups_are_sent_as_before() {
        let mut tools = vec![schema("read", "Read"), schema("srv_tool", "Does a thing")];
        let map = HashMap::from([("srv_tool".to_string(), "srv".to_string())]);
        assert!(DeferredMcpTools::hold_back(&mut tools, &map).is_none());
        assert_eq!(tools.len(), 2);
    }

    #[test]
    fn a_large_setup_is_held_back_and_found_and_loaded_on_demand() {
        let (mut tools, map) = big_setup();
        let deferred = DeferredMcpTools::hold_back(&mut tools, &map).expect("held back");
        // Only the built-in is left; the index names both servers.
        assert_eq!(tools.len(), 1);
        let index = deferred.tool_schema()["function"]["description"].as_str().unwrap().to_string();
        assert!(index.contains("61 MCP tools") && index.contains("notes (60)") && index.contains("playwright (1)"), "{index}");

        let found = deferred.handle(&json!({"action": "search", "query": "click browser"}));
        assert!(found.starts_with("browser_click (playwright)"), "{found}");
        assert!(deferred.loaded_schemas().is_empty(), "search loads nothing");

        let loaded = deferred.handle(&json!({"action": "load", "names": ["browser_click", "nope"]}));
        assert!(loaded.contains("Loaded: browser_click") && loaded.contains("Not found: nope"), "{loaded}");
        // Append-only, in load order, no duplicates.
        deferred.handle(&json!({"action": "load", "names": ["notes_tool_3", "browser_click"]}));
        let names: Vec<_> = deferred.loaded_schemas().iter().map(|s| tool_name(s).unwrap().to_string()).collect();
        assert_eq!(names, ["browser_click", "notes_tool_3"]);
    }

    #[test]
    fn a_broad_search_is_capped_and_bad_calls_are_explained() {
        let (mut tools, map) = big_setup();
        let deferred = DeferredMcpTools::hold_back(&mut tools, &map).unwrap();
        let broad = deferred.handle(&json!({"action": "search", "query": "notes"}));
        assert!(broad.contains("more; narrow the query"), "{broad}");
        assert!(deferred.handle(&json!({"action": "search", "query": "zzz"})).starts_with("No MCP tool matches"));
        assert!(deferred.handle(&json!({"action": "fly"})).starts_with("ERROR"));
        assert!(deferred.handle(&json!({"action": "load"})).starts_with("ERROR"));
    }
}
