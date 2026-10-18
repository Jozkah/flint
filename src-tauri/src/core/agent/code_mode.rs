//! Code mode: one script instead of many round trips (`[tools] code_mode`).
//!
//! Exploring a repository usually means a dozen small reads, each one a model
//! turn. With `code_mode = true` the model also gets a `code` tool: it writes
//! one short script that calls a few read-only tools and returns the combined
//! result.
//!
//! ```text
//! let hits = grep("TODO", "src");
//! let manifest = read("Cargo.toml");
//! `${hits}\n---\n${manifest}`
//! ```
//!
//! The interpreter is [Rhai], embedded and pure Rust. That is the safety
//! argument, not a convenience: a Rhai engine has no file, process, network or
//! environment access of its own, so the script can do exactly what the host
//! registers and nothing else -- there is no shell to escape to and no
//! interpreter on `PATH` to depend on. The host registers one capability, a
//! call back into the agent's own tools, and:
//!
//! - **no extra privilege.** Each inner call is dispatched through the same
//!   tool invoker as a call the model made itself, so the permission gate, the
//!   path jail, `[tools]` allow/deny and `[[tool_rules]]` all apply to it. A
//!   gate that would prompt still prompts; one that denies still denies, and the
//!   script sees the refusal as an error string;
//! - **a short list of tools.** Only [`ALLOWED`] -- reads and searches -- can
//!   be called. A write, `bash`, a subagent or `code` itself is refused before
//!   it reaches the invoker, so the script cannot recurse or mutate;
//! - **bounded.** Operations, wall-clock time, the number of inner calls, the
//!   size of each inner result and of the final output are all capped
//!   ([`Limits`]). A cap that is hit stops the script with an error naming it;
//! - **opt-in.** Without `code_mode = true` the tool is neither offered nor
//!   executable.
//!
//! [Rhai]: https://rhai.rs

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rhai::{Dynamic, Engine, EvalAltResult, ImmutableString, Map};
use serde_json::Value;
use tokio::sync::mpsc;

/// The tool's name.
pub(crate) const TOOL_NAME: &str = "code";

/// The tools a script may call: reads and searches over the project. Anything
/// else -- a write, a shell, a subagent, `code` itself -- is refused.
pub(crate) const ALLOWED: &[&str] = &["read", "ls", "grep", "find"];

#[derive(Debug, Clone)]
pub(crate) struct Limits {
    /// Inner tool calls one script may make.
    pub max_calls: usize,
    /// Rhai operations (roughly, evaluation steps) before the script is stopped.
    pub max_operations: u64,
    /// Wall-clock time for the whole script, inner calls included.
    pub timeout: Duration,
    /// Characters of one inner call's result handed to the script.
    pub max_call_chars: usize,
    /// Characters of the script itself.
    pub max_script_chars: usize,
    /// Characters of output returned to the model.
    pub max_output_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_calls: 25,
            max_operations: 200_000,
            timeout: Duration::from_secs(60),
            max_call_chars: 64_000,
            max_script_chars: 8_000,
            max_output_chars: 24_000,
        }
    }
}

/// What a finished script produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Outcome {
    /// Printed text, then the script's final value.
    pub output: String,
    /// Inner tool calls made.
    pub calls: usize,
    /// Whether the output was cut at [`Limits::max_output_chars`].
    pub truncated: bool,
}

/// The `code` tool's schema.
pub(crate) fn schema() -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": "Run one short script that calls several read-only tools and returns a combined result, instead of making each call as a separate step. Use it when you already know you need several reads or searches (open three files and grep for a symbol). The script is Rhai (JavaScript-like: let, if, for, functions, string interpolation with backticks, arrays, maps). Available functions: read(path), ls(path), grep(pattern), grep(pattern, path), find(pattern), find(pattern, path), and tool(name, #{ ...args }) for the full argument set of read, ls, grep or find. Each returns the tool's text result as a string, or throws if the tool refused or failed (wrap in try { } catch (e) { } to continue). The value of the last expression is returned; print() output comes first. Calls go through the normal permission checks. Writing, running commands and anything else is not available here. Limits: 25 tool calls, 60 seconds, 24000 characters of output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "script": { "type": "string", "description": "The Rhai script. Keep it short." }
                },
                "required": ["script"]
            }
        }
    })
}

/// One inner tool call, sent from the interpreter's thread to the async side.
struct Request {
    name: String,
    args: Value,
    reply: std::sync::mpsc::Sender<Result<String, String>>,
}

fn clip(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    let kept: String = text.chars().take(max_chars).collect();
    (kept, true)
}

fn args_of(pairs: &[(&str, Dynamic)]) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert((*key).into(), value.clone());
    }
    rhai::serde::from_dynamic::<Value>(&Dynamic::from_map(map)).unwrap_or(Value::Null)
}

/// The blocking half: build the engine, run the script. Runs on a blocking
/// thread; its only way out to the world is `requests`.
fn run_engine(
    script: String,
    limits: Limits,
    requests: mpsc::UnboundedSender<Request>,
) -> Result<(String, usize), String> {
    let started = Instant::now();
    let deadline = started + limits.timeout;
    let calls = Arc::new(AtomicUsize::new(0));
    let printed = Arc::new(std::sync::Mutex::new(String::new()));

    let mut engine = Engine::new();
    engine.set_max_operations(limits.max_operations);
    engine.set_max_call_levels(24);
    engine.set_max_expr_depths(48, 24);
    engine.set_max_string_size(limits.max_call_chars.saturating_mul(2).max(1024));
    engine.set_max_array_size(10_000);
    engine.set_max_map_size(1_000);
    // `eval` would run a string the script built: nothing the model could not
    // have written directly, but there is no reason to offer it.
    engine.disable_symbol("eval");
    engine.on_progress(move |_ops| (Instant::now() >= deadline).then(|| Dynamic::from("time limit")));
    {
        let printed = printed.clone();
        let cap = limits.max_output_chars.saturating_mul(2);
        engine.on_print(move |text| {
            if let Ok(mut buf) = printed.lock() {
                if buf.len() < cap {
                    buf.push_str(text);
                    buf.push('\n');
                }
            }
        });
    }
    engine.on_debug(|_, _, _| {});

    #[allow(clippy::type_complexity)]
    let call: Arc<dyn Fn(&str, Value) -> Result<String, Box<EvalAltResult>> + Send + Sync> = {
        let calls = calls.clone();
        let max_calls = limits.max_calls;
        let max_chars = limits.max_call_chars;
        Arc::new(move |name: &str, args: Value| {
            if !ALLOWED.contains(&name) {
                return Err(format!(
                    "{name:?} is not available in code mode; only {} can be called",
                    ALLOWED.join(", ")
                )
                .into());
            }
            if calls.fetch_add(1, Ordering::SeqCst) >= max_calls {
                return Err(format!("too many tool calls (limit {max_calls})").into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("time limit reached".to_string().into());
            }
            let (reply, answer) = std::sync::mpsc::channel();
            requests
                .send(Request { name: name.to_string(), args, reply })
                .map_err(|_| Box::<EvalAltResult>::from("the run ended".to_string()))?;
            match answer.recv_timeout(remaining) {
                Ok(Ok(text)) => Ok(clip(&text, max_chars).0),
                Ok(Err(message)) => Err(message.into()),
                Err(_) => Err("time limit reached waiting for a tool".to_string().into()),
            }
        })
    };

    {
        let call = call.clone();
        engine.register_fn("tool", move |name: ImmutableString, args: Map| {
            let args = rhai::serde::from_dynamic::<Value>(&Dynamic::from_map(args))
                .map_err(|e| Box::<EvalAltResult>::from(format!("bad arguments: {e}")))?;
            call(name.as_str(), args)
        });
    }
    {
        let call = call.clone();
        engine.register_fn("read", move |path: ImmutableString| {
            call("read", args_of(&[("path", path.into())]))
        });
    }
    {
        let call = call.clone();
        engine.register_fn("ls", move |path: ImmutableString| {
            call("ls", args_of(&[("path", path.into())]))
        });
    }
    {
        let call = call.clone();
        engine.register_fn("grep", move |pattern: ImmutableString| {
            call("grep", args_of(&[("pattern", pattern.into())]))
        });
    }
    {
        let call = call.clone();
        engine.register_fn("grep", move |pattern: ImmutableString, path: ImmutableString| {
            call("grep", args_of(&[("pattern", pattern.into()), ("path", path.into())]))
        });
    }
    {
        let call = call.clone();
        engine.register_fn("find", move |pattern: ImmutableString| {
            call("find", args_of(&[("pattern", pattern.into())]))
        });
    }
    {
        let call = call.clone();
        engine.register_fn("find", move |pattern: ImmutableString, path: ImmutableString| {
            call("find", args_of(&[("pattern", pattern.into()), ("path", path.into())]))
        });
    }

    let value = engine
        .eval::<Dynamic>(&script)
        .map_err(|e| describe(&e, &limits))?;
    let mut output = printed.lock().map(|b| b.clone()).unwrap_or_default();
    if !value.is_unit() {
        let rendered = match rhai::serde::from_dynamic::<Value>(&value) {
            Ok(Value::String(s)) => s,
            Ok(other) => other.to_string(),
            Err(_) => value.to_string(),
        };
        output.push_str(&rendered);
    }
    Ok((output, calls.load(Ordering::SeqCst)))
}

/// A script failure as the model should read it: what stopped it, in words.
fn describe(error: &EvalAltResult, limits: &Limits) -> String {
    match error {
        EvalAltResult::ErrorTooManyOperations(_) => format!(
            "script error: stopped after {} operations (the limit); do less work per script",
            limits.max_operations
        ),
        EvalAltResult::ErrorTerminated(_, _) => format!(
            "script error: stopped at the {}-second time limit",
            limits.timeout.as_secs()
        ),
        other => format!("script error: {other}"),
    }
}

/// Run `script`, answering each inner tool call with `call`. `call` receives
/// the tool name and its arguments and returns the tool's text result or its
/// failure text; it is where the host applies the gate.
pub(crate) async fn run<F, Fut>(script: &str, limits: Limits, mut call: F) -> Result<Outcome, String>
where
    F: FnMut(String, Value) -> Fut + Send,
    Fut: Future<Output = Result<String, String>> + Send,
{
    if script.trim().is_empty() {
        return Err("script is empty".to_string());
    }
    if script.chars().count() > limits.max_script_chars {
        return Err(format!(
            "script is too long ({} characters, limit {}); split the work or shorten it",
            script.chars().count(),
            limits.max_script_chars
        ));
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Request>();
    let max_output = limits.max_output_chars;
    let owned = script.to_string();
    let engine = tokio::task::spawn_blocking(move || run_engine(owned, limits, tx));
    tokio::pin!(engine);
    loop {
        tokio::select! {
            joined = &mut engine => {
                let (output, calls) = joined.map_err(|e| format!("script error: interpreter stopped ({e})"))??;
                let (output, truncated) = clip(&output, max_output);
                return Ok(Outcome { output, calls, truncated });
            }
            Some(request) = rx.recv() => {
                // Re-checked here, outside the interpreter: the allowlist is
                // enforced where the call is dispatched, not only where it is made.
                let answer = if ALLOWED.contains(&request.name.as_str()) {
                    call(request.name, request.args).await
                } else {
                    Err(format!("{:?} is not available in code mode", request.name))
                };
                let _ = request.reply.send(answer);
            }
        }
    }
}

/// The model-facing text of an outcome.
pub(crate) fn render(outcome: &Outcome) -> String {
    let mut text = outcome.output.clone();
    if outcome.truncated {
        text.push_str("\n[output truncated]");
    }
    if text.trim().is_empty() {
        text = format!("(script finished with no output after {} tool calls)", outcome.calls);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type Log = Arc<Mutex<Vec<(String, Value)>>>;

    /// A host that answers `read` with the path, and records every call.
    async fn run_with(script: &str, limits: Limits) -> (Result<Outcome, String>, Vec<(String, Value)>) {
        let log: Log = Arc::default();
        let seen = log.clone();
        let result = run(script, limits, move |name, args| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push((name.clone(), args.clone()));
                match name.as_str() {
                    "read" => Ok(format!("contents of {}", args["path"].as_str().unwrap_or("?"))),
                    "grep" => Ok(format!("hit for {}", args["pattern"].as_str().unwrap_or("?"))),
                    "ls" => Ok("a.txt\nb.txt".to_string()),
                    "find" => Err("ERROR [sandbox_denied]: outside the project".to_string()),
                    other => Ok(other.to_string()),
                }
            }
        })
        .await;
        let calls = log.lock().unwrap().clone();
        (result, calls)
    }

    #[tokio::test]
    async fn a_script_combines_several_reads_into_one_result() {
        let (out, calls) = run_with(
            r#"let a = read("one.txt"); let b = read("two.txt"); let g = grep("TODO", "src"); `${a} | ${b} | ${g}`"#,
            Limits::default(),
        )
        .await;
        let out = out.expect("runs");
        assert_eq!(out.output, "contents of one.txt | contents of two.txt | hit for TODO");
        assert_eq!(out.calls, 3);
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[2], ("grep".to_string(), serde_json::json!({ "pattern": "TODO", "path": "src" })));
    }

    #[tokio::test]
    async fn loops_and_print_work_and_print_comes_first() {
        let (out, _) = run_with(
            r#"for f in ["a", "b"] { print(read(f)); } "done""#,
            Limits::default(),
        )
        .await;
        assert_eq!(out.unwrap().output, "contents of a\ncontents of b\ndone");
    }

    #[tokio::test]
    async fn the_generic_tool_function_passes_the_full_argument_set() {
        let (out, calls) = run_with(r#"tool("read", #{ path: "x.rs", offset: 10, limit: 5 })"#, Limits::default()).await;
        assert!(out.is_ok());
        assert_eq!(calls[0].1, serde_json::json!({ "path": "x.rs", "offset": 10, "limit": 5 }));
    }

    // Refusal tests first: what a script must not be able to do.

    #[tokio::test]
    async fn a_write_a_shell_and_code_itself_are_refused_and_never_reach_the_host() {
        for name in ["write", "edit", "bash", "code", "dispatch_subagent", "browser"] {
            let script = format!(r#"tool("{name}", #{{ command: "whoami" }})"#);
            let (out, calls) = run_with(&script, Limits::default()).await;
            let err = out.expect_err(name);
            assert!(err.contains("not available in code mode"), "{name}: {err}");
            assert!(calls.is_empty(), "{name} reached the host: {calls:?}");
        }
    }

    #[tokio::test]
    async fn the_script_has_no_ambient_access_to_files_processes_or_modules() {
        for script in [
            r#"import "os" as os; 1"#,
            r#"eval("read(\"x\")")"#,
            r#"open("C:/Windows/win.ini")"#,
            r#"system("whoami")"#,
            r#"File::read("x")"#,
        ] {
            let (out, calls) = run_with(script, Limits::default()).await;
            assert!(out.is_err(), "{script} must not run");
            assert!(calls.is_empty());
        }
    }

    #[tokio::test]
    async fn a_host_refusal_reaches_the_script_as_an_error_it_can_catch() {
        let (out, _) = run_with(
            r#"let r = "none"; try { r = find("*.rs"); } catch (e) { r = "caught: " + e; } r"#,
            Limits::default(),
        )
        .await;
        let text = out.unwrap().output;
        assert!(text.starts_with("caught: "), "{text}");
        assert!(text.contains("sandbox_denied"), "{text}");
    }

    #[tokio::test]
    async fn an_uncaught_host_refusal_ends_the_script_with_that_text() {
        let (out, _) = run_with(r#"find("*.rs")"#, Limits::default()).await;
        assert!(out.unwrap_err().contains("sandbox_denied"));
    }

    #[tokio::test]
    async fn the_call_budget_is_enforced() {
        let limits = Limits { max_calls: 3, ..Limits::default() };
        let (out, calls) = run_with(r#"for i in 0..10 { read("f" + i); }"#, limits).await;
        assert!(out.unwrap_err().contains("too many tool calls"));
        assert_eq!(calls.len(), 3, "the fourth call never reached the host");
    }

    #[tokio::test]
    async fn an_infinite_loop_is_stopped_by_the_operation_limit() {
        let limits = Limits { max_operations: 5_000, ..Limits::default() };
        let (out, _) = run_with("let n = 0; loop { n += 1; }", limits).await;
        let err = out.unwrap_err();
        assert!(err.contains("operations"), "{err}");
    }

    #[tokio::test]
    async fn a_slow_script_is_stopped_by_the_time_limit() {
        let limits = Limits { timeout: Duration::from_millis(150), max_operations: u64::MAX, ..Limits::default() };
        let (out, _) = run_with("let n = 0; loop { n += 1; }", limits).await;
        let err = out.unwrap_err();
        assert!(err.contains("time limit"), "{err}");
    }

    #[tokio::test]
    async fn output_is_capped() {
        let limits = Limits { max_output_chars: 50, ..Limits::default() };
        let (out, _) = run_with(r#"let s = ""; for i in 0..200 { s += "abcdefghij"; } s"#, limits).await;
        let out = out.unwrap();
        assert_eq!(out.output.chars().count(), 50);
        assert!(out.truncated);
        assert!(render(&out).ends_with("[output truncated]"));
    }

    #[tokio::test]
    async fn one_inner_result_is_capped_before_the_script_sees_it() {
        let limits = Limits { max_call_chars: 10, ..Limits::default() };
        let (out, _) = run_with(r#"read("a_very_long_path_name.txt")"#, limits).await;
        assert_eq!(out.unwrap().output, "contents o");
    }

    #[tokio::test]
    async fn a_long_or_empty_script_is_refused_up_front() {
        let limits = Limits { max_script_chars: 20, ..Limits::default() };
        let (out, calls) = run_with(&"1 + 1; ".repeat(10), limits).await;
        assert!(out.unwrap_err().contains("too long"));
        assert!(calls.is_empty());
        let (out, _) = run_with("   ", Limits::default()).await;
        assert!(out.unwrap_err().contains("empty"));
    }

    #[tokio::test]
    async fn a_syntax_error_is_reported_not_swallowed() {
        let (out, _) = run_with("let = ;", Limits::default()).await;
        assert!(out.unwrap_err().starts_with("script error:"));
    }

    #[tokio::test]
    async fn a_script_returning_a_map_or_array_comes_back_as_json() {
        let (out, _) = run_with(r#"#{ files: ls("."), n: 2 }"#, Limits::default()).await;
        let text = out.unwrap().output;
        let parsed: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(parsed["n"], 2);
    }

    #[tokio::test]
    async fn a_script_with_no_output_says_so() {
        let (out, _) = run_with("let x = 1;", Limits::default()).await;
        assert!(render(&out.unwrap()).contains("no output"));
    }

    #[test]
    fn the_schema_names_the_tool_and_requires_a_script() {
        let s = schema();
        assert_eq!(s["function"]["name"], TOOL_NAME);
        assert_eq!(s["function"]["parameters"]["required"][0], "script");
    }

    #[test]
    fn the_allowlist_is_reads_and_searches_only() {
        assert_eq!(ALLOWED, ["read", "ls", "grep", "find"]);
        for forbidden in ["write", "edit", "bash", "code"] {
            assert!(!ALLOWED.contains(&forbidden));
        }
    }
}
