//! A scheduled run end to end, through the real binary.
//!
//! The child a supervisor starts is `flint cli schedule run-spec`. What these
//! tests pin is what an unattended run promises: a prompt nobody can answer is
//! denied and written into the run's history rather than approved, a budget
//! stops the run with the right status, and the ending always lands in the run
//! record. The provider is a stub on a loopback port.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use app_lib::core::schedule::runner::{write_spec, RunSpec, SPEC_VERSION};
use app_lib::core::schedule::spec::{
    Budgets, CatchUp, OnBlock, Policy, Schedule, Task, TimeOfDay, WriteMode,
};
use app_lib::core::schedule::store::{RunRecord, RunStatus, Store, Trigger};

const WRITE_CALL: &str = concat!(
    "data: {\"id\":\"s-1\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",",
    "\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":",
    "{\"name\":\"write\",\"arguments\":\"{\\\"path\\\":\\\"out.txt\\\",\\\"content\\\":\\\"hello\\\"}\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"s-1\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{},",
    "\"finish_reason\":\"tool_calls\"}],",
    "\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n",
    "data: [DONE]\n\n",
);

const READ_CALL: &str = concat!(
    "data: {\"id\":\"s-2\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",",
    "\"tool_calls\":[{\"index\":0,\"id\":\"call-2\",\"type\":\"function\",\"function\":",
    "{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"notes.txt\\\"}\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"s-2\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{},",
    "\"finish_reason\":\"tool_calls\"}],",
    "\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n",
    "data: [DONE]\n\n",
);

const ANSWER: &str = concat!(
    "data: {\"id\":\"s-3\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",",
    "\"content\":\"nothing changed overnight\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"s-3\",\"object\":\"chat.completion.chunk\",\"created\":1,",
    "\"model\":\"stub-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],",
    "\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"total_tokens\":13}}\n\n",
    "data: [DONE]\n\n",
);

fn stub_provider(replies: &'static [&'static str], delay: Duration) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub provider");
    let addr = listener.local_addr().expect("stub address");
    let served = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&served);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let count = Arc::clone(&count);
            std::thread::spawn(move || {
                drain_request(&mut stream);
                let i = count.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(delay);
                let reply = replies[i.min(replies.len() - 1)];
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            });
        }
    });
    (format!("http://{addr}/v1"), served)
}

fn drain_request(stream: &mut TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        let Some(head) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let headers = String::from_utf8_lossy(&buf[..head]).to_ascii_lowercase();
        let want = headers
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buf.len() >= head + 4 + want {
            return;
        }
    }
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("flint-sched-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("project")).expect("project dir");
        std::fs::create_dir_all(root.join("home")).expect("home dir");
        std::fs::write(root.join("project").join("notes.txt"), "alpha\n").expect("notes");
        Self { root }
    }

    fn data(&self) -> PathBuf {
        self.root.join("jan-data")
    }

    fn project(&self) -> PathBuf {
        self.root.join("project")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_flint"));
        cmd.args(args)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("FLINT_HOME", self.root.join("home"))
            .env("JAN_HOME", self.root.join("home"))
            .env("JAN_DATA_FOLDER", self.data())
            .env_remove("JAN_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY");
        cmd
    }

    fn configure(&self, base_url: &str) {
        let out = self
            .command(&[
                "config", "set", "--provider", "stub", "--api-key", "test-key", "--base-url", base_url, "--model",
                "stub-model",
            ])
            .output()
            .expect("run `flint config set`");
        assert!(out.status.success(), "config set failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn task(&self, budgets: Budgets, on_block: OnBlock, write: WriteMode) -> Task {
        Task {
            id: "nightly".into(),
            name: "Nightly digest".into(),
            prompt: "Look at notes.txt and tell me what changed.".into(),
            schedule: Schedule::Daily { times: vec![TimeOfDay { hour: 3, minute: 0 }] },
            timezone: "UTC".into(),
            model: "stub/stub-model".into(),
            project: self.project().to_string_lossy().to_string(),
            profile: None,
            policy: Policy { allow_tools: vec!["read".into(), "write".into()], write },
            budgets,
            on_block,
            catch_up: CatchUp::Once,
            enabled: true,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    /// Save the task, write its record and spec, run the child, and return the
    /// record as the child left it.
    fn run(&self, task: Task) -> (RunRecord, Output) {
        let store = Store::new(&self.data());
        let task = store.save_task(task).expect("task is valid");
        let record = store.begin_run(&task, Trigger::Manual, chrono::Utc::now()).expect("begin run");
        let spec = RunSpec {
            v: SPEC_VERSION,
            run_id: record.id.clone(),
            task: task.clone(),
            trigger: Trigger::Manual,
            scheduled_for: record.scheduled_for,
            data_folder: self.data().to_string_lossy().to_string(),
        };
        let path = write_spec(&store, &spec).expect("write spec");
        let out = self
            .command(&["cli", "schedule", "run-spec", "--spec", path.to_str().expect("utf-8 path")])
            .output()
            .expect("run the child");
        let after = store.get_run(&task.id, &record.id).expect("read run").expect("the record exists");
        (after, out)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn budgets(turns: u32, wall: u64) -> Budgets {
    Budgets { max_turns: turns, max_tokens: 100_000, max_wall_clock_secs: wall }
}

#[test]
fn a_run_answers_and_its_record_says_so() {
    let s = Scratch::new("answer");
    let (url, served) = stub_provider(&[ANSWER], Duration::ZERO);
    s.configure(&url);
    let (r, out) = s.run(s.task(budgets(6, 60), OnBlock::Continue, WriteMode::ReadOnly));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(r.status, RunStatus::Succeeded, "{r:?}");
    assert_eq!(r.summary.as_deref(), Some("nothing changed overnight"));
    let session = r.session_id.clone().expect("the transcript is linked");
    let thread = std::fs::read_to_string(s.data().join("threads").join(&session).join("thread.json"))
        .expect("the app can list the run as a conversation");
    assert!(thread.contains("Nightly digest"), "titled for the task: {thread}");
    assert!(thread.contains("\"scheduled\""), "marked as scheduled: {thread}");
    assert!(r.ended_at_ms.is_some());
    assert_eq!(r.spend.input_tokens, 9);
    assert_eq!(r.spend.output_tokens, 4);
    assert_eq!(served.load(Ordering::SeqCst), 1);
}

#[test]
fn a_write_prompt_is_denied_recorded_and_the_run_goes_on() {
    let s = Scratch::new("deny");
    let (url, served) = stub_provider(&[WRITE_CALL, ANSWER], Duration::ZERO);
    s.configure(&url);
    let (r, out) = s.run(s.task(budgets(6, 60), OnBlock::Continue, WriteMode::ReadOnly));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(r.status, RunStatus::Succeeded, "{r:?}");
    assert_eq!(r.blocked_on.len(), 1, "{:?}", r.blocked_on);
    assert!(r.blocked_on[0].starts_with("write"), "{:?}", r.blocked_on);
    assert!(!s.project().join("out.txt").exists(), "the denied write must not have happened");
    assert_eq!(served.load(Ordering::SeqCst), 2, "the model got to see the denial and answer");
}

#[test]
fn on_block_end_stops_the_run_at_the_first_denied_prompt() {
    let s = Scratch::new("end");
    let (url, served) = stub_provider(&[WRITE_CALL, ANSWER], Duration::ZERO);
    s.configure(&url);
    let (r, _out) = s.run(s.task(budgets(6, 60), OnBlock::End, WriteMode::ReadOnly));
    assert_eq!(r.status, RunStatus::Blocked, "{r:?}");
    assert_eq!(r.blocked_on.len(), 1);
    assert!(!s.project().join("out.txt").exists());
    assert_eq!(served.load(Ordering::SeqCst), 1, "no second request after the block");
}

#[test]
fn the_turn_budget_stops_a_run_that_keeps_calling_tools() {
    let s = Scratch::new("turns");
    let (url, _served) = stub_provider(&[READ_CALL], Duration::ZERO);
    s.configure(&url);
    let (r, _out) = s.run(s.task(budgets(2, 60), OnBlock::Continue, WriteMode::ReadOnly));
    assert_eq!(r.status, RunStatus::BudgetStopped, "{r:?}");
    assert!(r.error.as_deref().unwrap_or("").contains("turn"), "{:?}", r.error);
    assert!(r.session_id.is_some());
}

#[test]
fn the_wall_clock_budget_stops_a_slow_run() {
    let s = Scratch::new("wall");
    let (url, _served) = stub_provider(&[ANSWER], Duration::from_secs(6));
    s.configure(&url);
    let (r, _out) = s.run(s.task(budgets(6, 1), OnBlock::Continue, WriteMode::ReadOnly));
    assert_eq!(r.status, RunStatus::BudgetStopped, "{r:?}");
    assert!(r.error.as_deref().unwrap_or("").contains("time limit"), "{:?}", r.error);
}

#[test]
fn a_run_with_an_unknown_model_fails_into_its_record() {
    let s = Scratch::new("nomodel");
    let (url, _served) = stub_provider(&[ANSWER], Duration::ZERO);
    s.configure(&url);
    let mut t = s.task(budgets(6, 60), OnBlock::Continue, WriteMode::ReadOnly);
    t.model = "nowhere/none".into();
    let (r, _out) = s.run(t);
    assert!(r.status.is_ended(), "{r:?}");
    assert_ne!(r.status, RunStatus::Running);
}
