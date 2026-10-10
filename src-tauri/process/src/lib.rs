//! One decision, made once: does a child process get a console window?
//!
//! Flint's desktop binary is a GUI-subsystem program. It owns no console. On
//! Windows that has a consequence that is easy to get wrong one call site at a
//! time: every console-subsystem program it starts (`git`, `cmd.exe`,
//! `where.exe`, `powershell.exe`, the `flint` CLI, ...) is given a *new*
//! console by the kernel, and a new console comes with a visible window,
//! unless the creation flags say otherwise. The window lives exactly as long as
//! the process does, which for a `git status` is a black rectangle that flashes
//! for a few dozen milliseconds.
//!
//! The rule that this crate encodes:
//!
//! * A process that does Flint's work in the background is spawned with
//!   `CREATE_NO_WINDOW`. It still receives a console -- it needs one to be a
//!   console program at all -- but the console has no window. Everything that
//!   process starts in turn *inherits* that hidden console, so a helper that
//!   forgets the flag one level down still opens nothing.
//! * A process that must survive the app is spawned the same way. It is
//!   **not** spawned with `DETACHED_PROCESS`. A detached process has no console
//!   to hand down, so every console program *it* starts allocates a fresh one --
//!   with a window. That is precisely what put a `where.exe` and a `bash.exe`
//!   window on screen for every cowork background job (see
//!   [`CommandConsole::background_in_new_group`]).
//! * A terminal the user asked to see is spawned with `CREATE_NEW_CONSOLE`, and
//!   nothing else in Flint does that. Hidden and visible are distinct methods
//!   with distinct names, so a reader can tell from the call site which one
//!   was meant.
//!
//! The same trait is implemented for `std::process::Command` and
//! `tokio::process::Command`, so a caller does not have to know which flag
//! constant goes where. On Unix the console methods are no-ops and the group
//! method puts the child in its own process group, which is what the Windows
//! flag does on that side.

pub mod appimage;
pub use appimage::{host_env_var, HostProcessEnv};
pub mod app_secrets;
pub use app_secrets::{WithoutAppSecrets, APP_SECRET_ENV};

use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// `CREATE_NO_WINDOW`: a console with no window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_NEW_PROCESS_GROUP`: a Ctrl-C to the parent's group does not reach the child.
#[cfg(windows)]
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// `CREATE_NEW_CONSOLE`: a console with a window, for a terminal the user asked to see.
#[cfg(windows)]
pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// The creation flags a background process is started with on Windows. Exposed
/// for the one place that calls `CreateProcess` directly and cannot go through
/// a `Command`.
#[cfg(windows)]
pub const BACKGROUND_FLAGS: u32 = CREATE_NO_WINDOW;
/// [`BACKGROUND_FLAGS`] plus its own process group.
#[cfg(windows)]
pub const BACKGROUND_GROUP_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;

/// How a child relates to the screen.
pub trait CommandConsole {
    /// A helper that does Flint's work and is never shown: `git`, `cmd /C`,
    /// `where`, `powershell`, a formatter, an MCP server, a hook. On Windows
    /// it gets a console with no window; anything it starts inherits that
    /// hidden console. On Unix this changes nothing.
    ///
    /// Use this for a one-shot `.output()` / `.status()`.
    fn background(&mut self) -> &mut Self;

    /// [`background`](Self::background), and the child leads its own process
    /// group so it can be stopped as a tree and so a Ctrl-C aimed at the
    /// parent does not reach it. This is what a long-lived worker, a job
    /// supervisor, a shell the agent drives, or an LSP server wants.
    ///
    /// This is also the right flag set for a process that must outlive the
    /// app. `DETACHED_PROCESS` is the wrong tool for that on Windows: the
    /// detached child has no console, so every console program it starts is
    /// given a new, visible one. A hidden console it can hand down is what
    /// keeps its descendants off the screen.
    fn background_in_new_group(&mut self) -> &mut Self;

    /// A terminal the user asked to see. On Windows the child gets a new
    /// console *with* a window. Nothing that runs on Flint's behalf should
    /// call this; it exists so that the intent is spelled out where a
    /// terminal really is meant to appear, rather than left to the default.
    fn user_terminal(&mut self) -> &mut Self;
}

impl CommandConsole for StdCommand {
    fn background(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(BACKGROUND_FLAGS);
        }
        self
    }

    fn background_in_new_group(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(BACKGROUND_GROUP_FLAGS);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            self.process_group(0);
        }
        self
    }

    fn user_terminal(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NEW_CONSOLE);
        }
        self
    }
}

impl CommandConsole for TokioCommand {
    fn background(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(BACKGROUND_FLAGS);
        self
    }

    fn background_in_new_group(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(BACKGROUND_GROUP_FLAGS);
        #[cfg(unix)]
        self.process_group(0);
        self
    }

    fn user_terminal(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NEW_CONSOLE);
        self
    }
}

/// Watching the screen for console windows, so a test can say "nothing
/// appeared" about the real thing rather than about a flag it saw in source.
///
/// A test binary runs under `cargo test`, which has a console of its own; a
/// child it spawns without any flag simply inherits that console and opens
/// nothing, so a naive test passes for the wrong reason. [`headless_case`]
/// re-runs the test binary as a *detached* process -- the same console-less
/// situation the desktop app is in -- and runs the case there, while the outer
/// test polls for console windows owned by that process tree.
#[cfg(windows)]
pub mod console_watch {
    use std::collections::HashSet;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible,
    };

    /// The environment variable that tells a re-run test binary which case it is.
    pub const CASE_ENV: &str = "JAN_PROCESS_HEADLESS_CASE";

    /// What the watcher should have seen.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Expect {
        /// No console window from the case's process tree, ever.
        NoWindow,
        /// At least one visible console window from the case's process tree.
        Window,
    }

    /// One visible console window and who owns it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Seen {
        pub pid: u32,
        pub class: String,
        pub hwnd: isize,
        /// The console program the window belongs to: `conhost.exe` owns the
        /// window, its parent is the program, so this is that parent's image
        /// name -- what a failure needs to say to be acted on.
        pub owner: String,
    }

    /// Every process right now: `(pid, parent pid, image name)`.
    pub fn snapshot() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                    out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        out
    }

    /// The pids of `root` and everything under it, right now.
    pub fn process_tree(root: u32) -> HashSet<u32> {
        let parent_of: Vec<(u32, u32)> = snapshot().into_iter().map(|(p, pp, _)| (p, pp)).collect();
        let mut tree = HashSet::from([root]);
        loop {
            let before = tree.len();
            for (pid, ppid) in &parent_of {
                if tree.contains(ppid) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        tree
    }

    /// Every visible console window on this desktop, with its owner's pid.
    pub fn visible_console_windows() -> Vec<Seen> {
        unsafe extern "system" fn each(hwnd: HWND, out: isize) -> i32 {
            let out = &mut *(out as *mut Vec<Seen>);
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if class != "ConsoleWindowClass" && !class.contains("CASCADIA") {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            out.push(Seen { pid, class, hwnd: hwnd as isize, owner: String::new() });
            1
        }
        let mut out: Vec<Seen> = Vec::new();
        unsafe { EnumWindows(Some(each), &mut out as *mut _ as isize) };
        out
    }

    /// The console windows that belong to `root`'s process tree. A console
    /// window is owned by `conhost.exe`, whose parent is the console program,
    /// so the tree is what makes the attribution work.
    pub fn windows_of_tree(root: u32) -> Vec<Seen> {
        let procs = snapshot();
        let parent_of: Vec<(u32, u32)> = procs.iter().map(|(p, pp, _)| (*p, *pp)).collect();
        let mut tree = HashSet::from([root]);
        loop {
            let before = tree.len();
            for (pid, ppid) in &parent_of {
                if tree.contains(ppid) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        let name_of = |pid: u32| procs.iter().find(|(p, _, _)| *p == pid).map(|(_, _, n)| n.clone());
        visible_console_windows()
            .into_iter()
            .filter(|w| tree.contains(&w.pid))
            .map(|mut w| {
                // conhost's parent is the console program; if the window is
                // owned by the program itself (legacy console), that is it.
                let parent = procs.iter().find(|(p, _, _)| *p == w.pid).map(|(_, pp, _)| *pp);
                let owner_pid = match name_of(w.pid) {
                    Some(n) if n.eq_ignore_ascii_case("conhost.exe") => parent.unwrap_or(w.pid),
                    _ => w.pid,
                };
                w.owner = name_of(owner_pid).unwrap_or_default();
                w
            })
            .collect()
    }

    /// Run `case` in a console-less copy of this test binary and report every
    /// visible console window its process tree put on screen while it ran.
    ///
    /// `name` is the test's own name as `cargo test` filters it (its full
    /// path, e.g. `tests::a_background_cmd_opens_nothing`); pass
    /// `std::thread::current().name()` from inside the test. The inner run is
    /// started with `DETACHED_PROCESS`, which is the desktop app's situation:
    /// no console at all, so whatever `case` spawns is judged on its own flags.
    pub fn headless_case(name: &str, case: impl FnOnce(), expect: Expect) {
        if std::env::var(CASE_ENV).as_deref() == Ok(name) {
            case();
            return;
        }
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let exe = std::env::current_exe().expect("this test binary has a path");
        let mut child = Command::new(exe)
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env(CASE_ENV, name)
            .creation_flags(DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the headless copy of this test binary starts");
        let pid = child.id();
        let mut seen: Vec<Seen> = Vec::new();
        let started = Instant::now();
        let status = loop {
            for w in windows_of_tree(pid) {
                if !seen.contains(&w) {
                    seen.push(w);
                }
            }
            if let Some(status) = child.try_wait().expect("the headless run can be waited on") {
                break status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(120),
                "the headless run of {name} did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        // One last look: a window that outlived the case by a tick.
        for w in windows_of_tree(pid) {
            if !seen.contains(&w) {
                seen.push(w);
            }
        }
        let output = child.wait_with_output().ok();
        let stderr = output
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
            .unwrap_or_default();
        let stdout = output
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        assert!(
            status.success(),
            "the headless run of {name} failed ({status}):\n{stdout}\n{stderr}"
        );
        match expect {
            Expect::NoWindow => assert!(
                seen.is_empty(),
                "{name}: a console window appeared: {seen:?}\n{stdout}\n{stderr}"
            ),
            Expect::Window => assert!(
                !seen.is_empty(),
                "{name}: no console window was seen, so the watcher proves nothing\n{stdout}\n{stderr}"
            ),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::console_watch::{headless_case, Expect};
    use super::CommandConsole;
    use std::process::{Command, Stdio};

    fn me() -> String {
        std::thread::current().name().expect("tests are named").to_string()
    }

    /// Long enough for a 5 ms poll to see a window, short enough for a test.
    const LINGER: &str = "ping -n 2 127.0.0.1 >NUL";

    #[test]
    fn a_background_cmd_opens_no_window() {
        headless_case(
            &me(),
            || {
                let s = Command::new("cmd")
                    .args(["/C", LINGER])
                    .background()
                    .status()
                    .expect("cmd runs");
                assert!(s.success());
            },
            Expect::NoWindow,
        );
    }

    #[test]
    fn a_background_powershell_opens_no_window() {
        headless_case(
            &me(),
            || {
                let s = Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 800"])
                    .background()
                    .status()
                    .expect("powershell runs");
                assert!(s.success());
            },
            Expect::NoWindow,
        );
    }

    #[test]
    fn a_background_git_opens_no_window() {
        if Command::new("git").arg("--version").background().output().is_err() {
            eprintln!("git is not installed here; nothing to observe");
            return;
        }
        headless_case(
            &me(),
            || {
                // Several short git calls back to back, the shape a session
                // restore has, so a window with a lifetime of milliseconds
                // still gets many chances to be caught.
                for _ in 0..20 {
                    let o = Command::new("git")
                        .args(["--version"])
                        .background()
                        .output()
                        .expect("git runs");
                    assert!(o.status.success());
                }
            },
            Expect::NoWindow,
        );
    }

    #[test]
    fn a_background_child_that_starts_another_console_program_opens_no_window() {
        headless_case(
            &me(),
            || {
                // cmd starts cmd starts ping: the grandchildren carry no flag
                // of their own and must inherit the hidden console.
                let s = Command::new("cmd")
                    .args(["/C", &format!("cmd /C cmd /C {LINGER}")])
                    .background()
                    .status()
                    .expect("cmd runs");
                assert!(s.success());
            },
            Expect::NoWindow,
        );
    }

    #[test]
    fn a_background_group_child_that_starts_a_plain_console_program_opens_no_window() {
        headless_case(
            &me(),
            || {
                // The cowork worker shape: a supervisor started for the
                // background in its own group, which then starts a console
                // program with no flags at all. With a hidden console to
                // inherit, the grandchild opens nothing. (Started with
                // DETACHED_PROCESS instead, this exact tree put a window on
                // screen -- see the test below.)
                let s = Command::new("cmd")
                    .args(["/C", &format!("cmd /C {LINGER}")])
                    .background_in_new_group()
                    .status()
                    .expect("cmd runs");
                assert!(s.success());
            },
            Expect::NoWindow,
        );
    }

    #[test]
    fn a_detached_parent_lets_its_plain_child_open_a_window() {
        // The root cause, kept as a test so the watcher is known to see what
        // it is there to see: a DETACHED_PROCESS parent has no console, so a
        // plain console child allocates a visible one.
        headless_case(
            &me(),
            || {
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                let s = Command::new("cmd")
                    .args(["/C", &format!("cmd /C {LINGER}")])
                    .creation_flags(DETACHED_PROCESS)
                    .status()
                    .expect("cmd runs");
                assert!(s.success());
            },
            Expect::Window,
        );
    }

    #[test]
    fn a_user_terminal_is_visible() {
        headless_case(
            &me(),
            || {
                let s = Command::new("cmd")
                    .args(["/C", LINGER])
                    .user_terminal()
                    .status()
                    .expect("cmd runs");
                assert!(s.success());
            },
            Expect::Window,
        );
    }

    #[test]
    fn a_background_command_keeps_its_streams_and_exit_code() {
        let o = Command::new("cmd")
            .args(["/C", "echo to-stdout& echo to-stderr 1>&2& exit 3"])
            .background()
            .output()
            .expect("cmd runs");
        assert_eq!(o.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "to-stdout");
        assert_eq!(String::from_utf8_lossy(&o.stderr).trim(), "to-stderr");
    }

    #[test]
    fn a_background_command_keeps_paths_and_arguments_with_spaces() {
        let dir = std::env::temp_dir().join(format!("jan process {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("say it.cmd");
        std::fs::write(&script, "@echo off\r\necho [%~1] in [%CD%]\r\n").unwrap();
        let o = Command::new(&script)
            .arg("two words")
            .current_dir(&dir)
            .background()
            .output()
            .expect("the script runs");
        let text = String::from_utf8_lossy(&o.stdout);
        assert!(o.status.success(), "{text}");
        assert!(text.contains("[two words]"), "{text}");
        assert!(text.contains(&format!("[{}]", dir.display())), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_background_group_child_is_stopped_on_cancel() {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .background_in_new_group()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("cmd runs");
        let pid = child.id().expect("running");
        assert!(alive(pid), "the child is running");
        child.kill().await.expect("kill");
        let status = child.wait().await.expect("wait");
        assert!(!status.success());
        assert!(!alive(pid), "the child is gone after cancel");
    }

    fn alive(pid: u32) -> bool {
        // A snapshot lookup rather than OpenProcess: a zombie handle would
        // still open.
        super::console_watch::process_tree(pid).len() > 0 && {
            let o = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .background()
                .output()
                .expect("tasklist");
            String::from_utf8_lossy(&o.stdout).contains(&format!(",\"{pid}\","))
        }
    }
}
