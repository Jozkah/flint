//! "Run when the app is closed": an entry in the operating system's own
//! scheduler that runs `flint cli schedule tick` every few minutes.
//!
//! Opt-in, per user, never installed by default. The entry does exactly what
//! the app's 30-second driver does once -- ask the engine what is due and start
//! it -- under the same tick lock, so the app and the OS entry never start the
//! same fire twice. Closing the app does not stop it; uninstalling removes
//! every file and registration this module made.
//!
//! * Windows: a per-user Task Scheduler task (`schtasks /Create /XML`). The
//!   CLI is a console program, which Task Scheduler would show in a window
//!   every few minutes, so where `conhost.exe --headless` exists the task runs
//!   the tick through it and no window opens.
//! * macOS: a LaunchAgent in `~/Library/LaunchAgents`.
//! * Linux: a `systemd --user` service and timer.
//!
//! What gets written is rendered by pure functions, and the calls that touch
//! the machine go through [`Installer`], so tests use a fake and install
//! nothing.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const DEFAULT_INTERVAL_MINUTES: u32 = 5;
pub const MIN_INTERVAL_MINUTES: u32 = 1;
pub const MAX_INTERVAL_MINUTES: u32 = 60;

/// The task name on Windows.
pub const WINDOWS_TASK: &str = "Flint Scheduled Tasks";
/// The launchd label, which is also the plist's file name.
pub const LAUNCHD_LABEL: &str = "ai.flint.schedule";
/// The systemd unit name, without the suffix.
pub const SYSTEMD_UNIT: &str = "flint-schedule";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Platform::Windows => "Windows Task Scheduler",
            Platform::MacOs => "launchd",
            Platform::Linux => "systemd (user)",
        }
    }
}

/// What gets installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    /// The `flint` command line program.
    pub exe: PathBuf,
    /// The data folder the tick works on; passed explicitly, because the OS
    /// scheduler does not carry the app's environment.
    pub data_folder: PathBuf,
    pub interval_minutes: u32,
    /// Windows only: the `conhost.exe` that runs the tick without a console
    /// window (`conhost.exe --headless <command>`). `None` runs the program
    /// directly, which is what hosts without it get.
    pub headless_host: Option<PathBuf>,
}

impl Install {
    pub fn new(exe: PathBuf, data_folder: PathBuf, interval_minutes: u32) -> Install {
        Install {
            exe,
            data_folder,
            interval_minutes: interval_minutes.clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
            headless_host: None,
        }
    }

    pub fn with_headless_host(mut self, host: Option<PathBuf>) -> Install {
        self.headless_host = host;
        self
    }

    /// The program the Windows task starts and its arguments: the tick itself,
    /// or the tick behind `conhost.exe --headless`.
    fn windows_command(&self) -> (String, Vec<String>) {
        match &self.headless_host {
            Some(host) => {
                let mut args = vec!["--headless".to_string(), quote(&self.exe.to_string_lossy())];
                args.extend(self.tick_args().iter().map(|a| quote(a)));
                (host.to_string_lossy().to_string(), args)
            }
            None => (
                self.exe.to_string_lossy().to_string(),
                self.tick_args().iter().map(|a| quote(a)).collect(),
            ),
        }
    }

    /// The arguments after the program.
    pub fn tick_args(&self) -> Vec<String> {
        vec![
            "cli".into(),
            "schedule".into(),
            "tick".into(),
            "--data".into(),
            self.data_folder.to_string_lossy().to_string(),
        ]
    }

    /// The tick as one line a person can read and run themselves. On Windows
    /// with a headless host this is the exact command the task runs.
    pub fn tick_command(&self) -> String {
        if self.headless_host.is_some() {
            let (program, args) = self.windows_command();
            return std::iter::once(quote(&program)).chain(args).collect::<Vec<_>>().join(" ");
        }
        let mut parts = vec![quote(&self.exe.to_string_lossy())];
        parts.extend(self.tick_args().iter().map(|a| quote(a)));
        parts.join(" ")
    }
}

/// Quote only what needs it, for display and for the Windows task arguments.
fn quote(text: &str) -> String {
    if text.is_empty() || text.contains(|c: char| c.is_whitespace() || c == '"') {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        text.to_string()
    }
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ---- rendering ----

/// The Task Scheduler definition. Per user, runs only while that user is
/// logged on, never overlaps itself, catches up a start missed while asleep.
pub fn windows_task_xml(i: &Install) -> String {
    let (program, args) = i.windows_command();
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts Flint scheduled tasks that are due, even when the app is closed.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT{minutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        minutes = i.interval_minutes,
        command = xml_escape(&program),
        arguments = xml_escape(&args.join(" ")),
    )
}

/// Task Scheduler reads UTF-16; this is the file's bytes, BOM first.
pub fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

pub fn launchd_plist(i: &Install, log: &Path) -> String {
    let mut args = vec![i.exe.to_string_lossy().to_string()];
    args.extend(i.tick_args());
    let items: String = args
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{items}  </array>
  <key>StartInterval</key>
  <integer>{seconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        seconds = i.interval_minutes * 60,
        log = xml_escape(&log.to_string_lossy()),
    )
}

/// One argument in a systemd `ExecStart=` line.
fn systemd_quote(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

pub fn systemd_service(i: &Install) -> String {
    let mut parts = vec![systemd_quote(&i.exe.to_string_lossy())];
    parts.extend(i.tick_args().iter().map(|a| systemd_quote(a)));
    format!(
        "[Unit]\nDescription=Start Flint scheduled tasks that are due\n\n[Service]\nType=oneshot\nExecStart={}\n",
        parts.join(" ")
    )
}

pub fn systemd_timer(i: &Install) -> String {
    format!(
        "[Unit]\nDescription=Check Flint scheduled tasks every {m} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec={m}min\nUnit={unit}.service\n\n[Install]\nWantedBy=timers.target\n",
        m = i.interval_minutes,
        unit = SYSTEMD_UNIT,
    )
}

// ---- where things go ----

pub fn windows_xml_path(data_folder: &Path) -> PathBuf {
    data_folder.join("schedules").join("os-task.xml")
}

pub fn launchd_path(home: &Path) -> PathBuf {
    home.join("Library").join("LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist"))
}

pub fn systemd_dir(home: &Path) -> PathBuf {
    home.join(".config").join("systemd").join("user")
}

pub fn systemd_paths(home: &Path) -> (PathBuf, PathBuf) {
    let dir = systemd_dir(home);
    (dir.join(format!("{SYSTEMD_UNIT}.service")), dir.join(format!("{SYSTEMD_UNIT}.timer")))
}

/// A command the installer will run, as `(program, args)`.
pub type Step = (String, Vec<String>);

fn step(program: &str, args: &[&str]) -> Step {
    (program.to_string(), args.iter().map(|a| a.to_string()).collect())
}

/// The commands that install, in order. `uid` is the macOS user id.
pub fn install_steps(platform: Platform, i: &Install, home: &Path, uid: &str) -> Vec<Step> {
    match platform {
        Platform::Windows => vec![step(
            "schtasks",
            &["/Create", "/TN", WINDOWS_TASK, "/XML", &windows_xml_path(&i.data_folder).to_string_lossy(), "/F"],
        )],
        Platform::MacOs => {
            let domain = format!("gui/{uid}");
            vec![
                // A stale registration would make bootstrap fail; ignoring its
                // absence is the point of doing this first.
                step("launchctl", &["bootout", &format!("{domain}/{LAUNCHD_LABEL}")]),
                step("launchctl", &["bootstrap", &domain, &launchd_path(home).to_string_lossy()]),
            ]
        }
        Platform::Linux => vec![
            step("systemctl", &["--user", "daemon-reload"]),
            step("systemctl", &["--user", "enable", "--now", &format!("{SYSTEMD_UNIT}.timer")]),
        ],
    }
}

/// The commands that uninstall, before the files are removed.
pub fn uninstall_steps(platform: Platform, uid: &str) -> Vec<Step> {
    match platform {
        Platform::Windows => vec![step("schtasks", &["/Delete", "/TN", WINDOWS_TASK, "/F"])],
        Platform::MacOs => vec![step("launchctl", &["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])],
        Platform::Linux => vec![step("systemctl", &["--user", "disable", "--now", &format!("{SYSTEMD_UNIT}.timer")])],
    }
}

fn status_step(platform: Platform, uid: &str) -> Step {
    match platform {
        Platform::Windows => step("schtasks", &["/Query", "/TN", WINDOWS_TASK]),
        Platform::MacOs => step("launchctl", &["print", &format!("gui/{uid}/{LAUNCHD_LABEL}")]),
        Platform::Linux => step("systemctl", &["--user", "is-enabled", &format!("{SYSTEMD_UNIT}.timer")]),
    }
}

/// Files the install writes, with their contents.
pub fn files(platform: Platform, i: &Install, home: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    match platform {
        Platform::Windows => vec![(windows_xml_path(&i.data_folder), utf16_with_bom(&windows_task_xml(i)))],
        Platform::MacOs => {
            let log = i.data_folder.join("schedules").join("os-tick.log");
            vec![(launchd_path(home), launchd_plist(i, &log).into_bytes())]
        }
        Platform::Linux => {
            let (service, timer) = systemd_paths(home);
            vec![(service, systemd_service(i).into_bytes()), (timer, systemd_timer(i).into_bytes())]
        }
    }
}

/// Everything a person should see before agreeing: what is written where, what
/// is run, and the line the scheduler will execute each time.
pub fn preview(platform: Platform, i: &Install, home: &Path, uid: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (path, _) in files(platform, i, home) {
        out.push(format!("write {}", path.display()));
    }
    for (program, args) in install_steps(platform, i, home, uid) {
        out.push(std::iter::once(program).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" "));
    }
    out.push(format!("every {} min: {}", i.interval_minutes, i.tick_command()));
    out
}

// ---- touching the machine ----

/// The calls an install makes. Real in the app; fake in tests.
pub trait Installer {
    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String>;
    fn remove_file(&self, path: &Path) -> Result<(), String>;
    fn file_exists(&self, path: &Path) -> bool;
    /// Run a program; `Ok` when it exited 0, `Err` with its output otherwise.
    fn run(&self, program: &str, args: &[String]) -> Result<String, String>;
}

pub struct SystemInstaller;

impl Installer for SystemInstaller {
    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn remove_file(&self, path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    fn file_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn run(&self, program: &str, args: &[String]) -> Result<String, String> {
        let mut command = std::process::Command::new(program);
        command.args(args);
        // No console window for the helper programs either.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let out = command
            .output()
            .map_err(|e| format!("{program} could not be run: {e}"))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim()
        .to_string();
        if out.status.success() {
            Ok(text)
        } else {
            Err(if text.is_empty() { format!("{program} exited with {}", out.status) } else { text })
        }
    }
}

/// The first Windows build that has `conhost.exe --headless` (version 1809).
const HEADLESS_MIN_BUILD: u32 = 17763;

/// The build number in `cmd /c ver` output, e.g.
/// `Microsoft Windows [Version 10.0.26100.1234]` gives 26100.
fn windows_build(ver_output: &str) -> Option<u32> {
    let version = ver_output.split("Version").nth(1)?;
    let version = version.trim_start().split(|c: char| c == ']' || c.is_whitespace()).next()?;
    version.split('.').nth(2)?.parse().ok()
}

/// The console host that can run the tick without a window, when this
/// Windows has one: 1809 or newer, with `conhost.exe` in System32. Anything
/// else (older Windows, an unreadable version, a missing file) gets `None` and
/// the task runs the program directly, which can show a console window.
pub fn headless_host(platform: Platform, installer: &dyn Installer, system_root: &Path) -> Option<PathBuf> {
    if platform != Platform::Windows {
        return None;
    }
    let build = windows_build(&installer.run("cmd", &["/c".to_string(), "ver".to_string()]).ok()?)?;
    if build < HEADLESS_MIN_BUILD {
        return None;
    }
    let host = system_root.join("System32").join("conhost.exe");
    installer.file_exists(&host).then_some(host)
}

/// The Windows folder, from the environment, as the installer sees it.
pub fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// The macOS user id, which launchd domains are named by.
pub fn user_id(installer: &dyn Installer) -> String {
    installer.run("id", &["-u".to_string()]).unwrap_or_else(|_| "501".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsStatus {
    pub platform: Platform,
    pub platform_label: &'static str,
    pub installed: bool,
    pub interval_minutes: u32,
    /// What installing would write and run; shown before it is switched on.
    pub preview: Vec<String>,
    /// The line the OS scheduler runs.
    pub tick_command: String,
    /// Why the last look or change did not work, if it did not.
    pub detail: Option<String>,
}

pub fn status(
    platform: Platform,
    i: &Install,
    home: &Path,
    installer: &dyn Installer,
    detail: Option<String>,
) -> OsStatus {
    let uid = user_id_for(platform, installer);
    let (program, args) = status_step(platform, &uid);
    let registered = installer.run(&program, &args).is_ok();
    let files_there = files(platform, i, home).iter().all(|(p, _)| installer.file_exists(p));
    // Registered with the OS is what makes it run; a leftover file alone does
    // not, and is cleaned up by uninstalling. Windows keeps the definition
    // inside Task Scheduler, so its XML file need not still be there.
    let installed = registered && (files_there || platform == Platform::Windows);
    OsStatus {
        platform,
        platform_label: platform.label(),
        installed,
        interval_minutes: i.interval_minutes,
        preview: preview(platform, i, home, &uid),
        tick_command: i.tick_command(),
        detail,
    }
}

fn user_id_for(platform: Platform, installer: &dyn Installer) -> String {
    if platform == Platform::MacOs {
        user_id(installer)
    } else {
        String::new()
    }
}

/// Write the files, then register them. On a failed registration the files are
/// removed again, so a failed install leaves nothing behind.
pub fn enable(platform: Platform, i: &Install, home: &Path, installer: &dyn Installer) -> Result<(), String> {
    let uid = user_id_for(platform, installer);
    let written = files(platform, i, home);
    for (path, bytes) in &written {
        installer.write_file(path, bytes)?;
    }
    for (program, args) in install_steps(platform, i, home, &uid) {
        let result = installer.run(&program, &args);
        // launchctl bootout fails when nothing is registered, which is fine.
        let ignorable = program == "launchctl" && args.first().map(String::as_str) == Some("bootout");
        if let Err(e) = result {
            if !ignorable {
                for (path, _) in &written {
                    let _ = installer.remove_file(path);
                }
                return Err(format!("{program} failed: {e}"));
            }
        }
    }
    Ok(())
}

/// Unregister, then remove every file. Not finding anything to unregister is
/// fine: the goal is that nothing is left.
pub fn disable(platform: Platform, i: &Install, home: &Path, installer: &dyn Installer) -> Result<(), String> {
    let uid = user_id_for(platform, installer);
    for (program, args) in uninstall_steps(platform, &uid) {
        let _ = installer.run(&program, &args);
    }
    for (path, _) in files(platform, i, home) {
        installer.remove_file(&path)?;
    }
    if platform == Platform::Linux {
        let _ = installer.run("systemctl", &["--user".to_string(), "daemon-reload".to_string()]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    fn install() -> Install {
        Install::new(PathBuf::from("/opt/Flint App/flint"), PathBuf::from("/home/u/Flint data"), 5)
    }

    #[test]
    fn the_interval_is_kept_within_bounds() {
        let at = |m| Install::new("f".into(), "d".into(), m).interval_minutes;
        assert_eq!(at(0), MIN_INTERVAL_MINUTES);
        assert_eq!(at(5), 5);
        assert_eq!(at(10_000), MAX_INTERVAL_MINUTES);
    }

    #[test]
    fn the_tick_command_quotes_only_what_needs_it() {
        assert_eq!(
            install().tick_command(),
            "\"/opt/Flint App/flint\" cli schedule tick --data \"/home/u/Flint data\""
        );
        let plain = Install::new("flint".into(), "data".into(), 5);
        assert_eq!(plain.tick_command(), "flint cli schedule tick --data data");
    }

    #[test]
    fn the_windows_task_repeats_per_user_and_never_overlaps() {
        let xml = windows_task_xml(&install());
        assert!(xml.contains("<Interval>PT5M</Interval>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<Command>/opt/Flint App/flint</Command>"));
        assert!(xml.contains("<Arguments>cli schedule tick --data &quot;/home/u/Flint data&quot;</Arguments>"));
        assert!(xml.starts_with("<?xml"));
    }

    fn headless() -> Install {
        install().with_headless_host(Some(PathBuf::from("C:/Windows/System32/conhost.exe")))
    }

    #[test]
    fn with_a_headless_host_the_task_runs_the_tick_through_conhost() {
        let xml = windows_task_xml(&headless());
        assert!(xml.contains("<Command>C:/Windows/System32/conhost.exe</Command>"), "{xml}");
        assert!(
            xml.contains(
                "<Arguments>--headless &quot;/opt/Flint App/flint&quot; cli schedule tick --data &quot;/home/u/Flint data&quot;</Arguments>"
            ),
            "{xml}"
        );
        // The rest of the task is unchanged.
        assert!(xml.contains("<Interval>PT5M</Interval>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
    }

    #[test]
    fn without_one_the_task_runs_the_program_directly() {
        let xml = windows_task_xml(&install());
        assert!(xml.contains("<Command>/opt/Flint App/flint</Command>"));
        assert!(!xml.contains("--headless"));
    }

    #[test]
    fn the_shown_command_is_exactly_what_the_task_runs() {
        assert_eq!(
            headless().tick_command(),
            "C:/Windows/System32/conhost.exe --headless \"/opt/Flint App/flint\" cli schedule tick --data \"/home/u/Flint data\""
        );
        let lines = preview(Platform::Windows, &headless(), Path::new("/h"), "");
        assert!(lines.last().unwrap().starts_with("every 5 min: C:/Windows/System32/conhost.exe --headless "));
        // Other platforms never get the host, even if one were set.
        let linux = Install::new("/x/flint".into(), "/d".into(), 5);
        assert_eq!(linux.tick_command(), "/x/flint cli schedule tick --data /d");
        assert!(!systemd_service(&headless()).contains("conhost"));
        assert!(!launchd_plist(&headless(), Path::new("/l")).contains("conhost"));
    }

    #[test]
    fn a_hostile_host_path_cannot_break_out_of_the_xml() {
        let i = install().with_headless_host(Some(PathBuf::from("C:/a&b/conhost.exe")));
        let xml = windows_task_xml(&i);
        assert!(xml.contains("<Command>C:/a&amp;b/conhost.exe</Command>"));
    }

    #[test]
    fn the_windows_build_is_read_from_ver_output() {
        assert_eq!(windows_build("
Microsoft Windows [Version 10.0.26100.1234]
"), Some(26100));
        assert_eq!(windows_build("Microsoft Windows [Version 10.0.17763.1]"), Some(17763));
        assert_eq!(windows_build("Microsoft Windows [Version 6.1.7601]"), Some(7601));
        assert_eq!(windows_build("Microsoft Windows [Version 10.0]"), None);
        assert_eq!(windows_build("nonsense"), None);
        assert_eq!(windows_build(""), None);
    }

    #[test]
    fn the_headless_host_is_used_only_where_it_exists() {
        let root = Path::new("C:/Windows");
        let host = root.join("System32").join("conhost.exe");
        let with = |ver: Option<&str>, has_conhost: bool| {
            let fake = Fake { ver: ver.map(str::to_string), ..Default::default() };
            if has_conhost {
                fake.files.borrow_mut().insert(host.clone(), Vec::new());
            }
            headless_host(Platform::Windows, &fake, root)
        };
        let win11 = "Microsoft Windows [Version 10.0.26100.1]";
        assert_eq!(with(Some(win11), true), Some(host.clone()));
        // 1809 is the first with --headless; 1803 is not.
        assert_eq!(with(Some("Microsoft Windows [Version 10.0.17763.1]"), true), Some(host.clone()));
        assert_eq!(with(Some("Microsoft Windows [Version 10.0.17134.1]"), true), None);
        // conhost missing, version unreadable, or `ver` itself failing: fall back.
        assert_eq!(with(Some(win11), false), None);
        assert_eq!(with(Some("garbage"), true), None);
        assert_eq!(with(None, true), None);
        // Never on another platform.
        let fake = Fake { ver: Some(win11.into()), ..Default::default() };
        fake.files.borrow_mut().insert(host, Vec::new());
        assert_eq!(headless_host(Platform::Linux, &fake, root), None);
        assert_eq!(headless_host(Platform::MacOs, &fake, root), None);
    }

    #[test]
    fn hostile_paths_cannot_break_out_of_the_xml() {
        let i = Install::new(PathBuf::from("C:/a&b/<x>/flint.exe"), PathBuf::from("D:/it's"), 5);
        let xml = windows_task_xml(&i);
        assert!(xml.contains("C:/a&amp;b/&lt;x&gt;/flint.exe"));
        assert!(xml.contains("it&apos;s"));
        assert!(!xml.contains("a&b"));
    }

    #[test]
    fn the_task_file_is_utf16_with_a_byte_order_mark() {
        let bytes = utf16_with_bom("a\u{e9}");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        assert_eq!(&bytes[2..], &[b'a', 0, 0xE9, 0]);
    }

    #[test]
    fn the_launch_agent_runs_the_tick_on_an_interval_and_at_load() {
        let plist = launchd_plist(&install(), Path::new("/home/u/Flint data/schedules/os-tick.log"));
        assert!(plist.contains("<string>ai.flint.schedule</string>"));
        assert!(plist.contains("<integer>300</integer>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        let order: Vec<&str> = ["/opt/Flint App/flint", "cli", "schedule", "tick", "--data", "/home/u/Flint data"].to_vec();
        let mut at = 0;
        for a in order {
            let found = plist[at..].find(&format!("<string>{a}</string>")).unwrap_or_else(|| panic!("{a}"));
            at += found;
        }
    }

    #[test]
    fn the_systemd_units_quote_arguments_and_repeat() {
        let service = systemd_service(&install());
        assert!(service.contains("Type=oneshot"));
        assert!(service.contains(
            "ExecStart=\"/opt/Flint App/flint\" \"cli\" \"schedule\" \"tick\" \"--data\" \"/home/u/Flint data\""
        ));
        let timer = systemd_timer(&install());
        assert!(timer.contains("OnUnitActiveSec=5min"));
        assert!(timer.contains("Unit=flint-schedule.service"));
        assert!(timer.contains("WantedBy=timers.target"));
        let odd = Install::new("/x/%h$HOME/flint".into(), "/d".into(), 5);
        assert!(systemd_service(&odd).contains("%%h$$HOME"));
    }

    #[test]
    fn each_platform_writes_its_own_files_under_the_right_roots() {
        let home = Path::new("/home/u");
        let i = install();
        let linux: Vec<PathBuf> = files(Platform::Linux, &i, home).into_iter().map(|f| f.0).collect();
        assert_eq!(
            linux,
            vec![
                PathBuf::from("/home/u/.config/systemd/user/flint-schedule.service"),
                PathBuf::from("/home/u/.config/systemd/user/flint-schedule.timer"),
            ]
        );
        let mac: Vec<PathBuf> = files(Platform::MacOs, &i, home).into_iter().map(|f| f.0).collect();
        assert_eq!(mac, vec![PathBuf::from("/home/u/Library/LaunchAgents/ai.flint.schedule.plist")]);
        let win: Vec<PathBuf> = files(Platform::Windows, &i, home).into_iter().map(|f| f.0).collect();
        assert_eq!(win, vec![PathBuf::from("/home/u/Flint data/schedules/os-task.xml")]);
    }

    #[test]
    fn the_preview_names_the_files_the_commands_and_the_tick() {
        let lines = preview(Platform::Linux, &install(), Path::new("/home/u"), "");
        assert!(lines.iter().any(|l| l.starts_with("write ") && l.ends_with("flint-schedule.timer")));
        assert!(lines.iter().any(|l| l == "systemctl --user enable --now flint-schedule.timer"));
        assert!(lines.last().unwrap().starts_with("every 5 min: "));
        let win = preview(Platform::Windows, &install(), Path::new("/h"), "");
        assert!(win.iter().any(|l| l.starts_with("schtasks /Create /TN \"Flint Scheduled Tasks\" /XML ")));
    }

    /// A machine that is only a list of files and registered names.
    #[derive(Default)]
    struct Fake {
        files: RefCell<BTreeMap<PathBuf, Vec<u8>>>,
        registered: RefCell<bool>,
        calls: RefCell<Vec<String>>,
        fail_register: bool,
        /// What `cmd /c ver` prints, if it works at all.
        ver: Option<String>,
    }

    impl Installer for Fake {
        fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
            self.files.borrow_mut().insert(path.to_path_buf(), bytes.to_vec());
            Ok(())
        }
        fn remove_file(&self, path: &Path) -> Result<(), String> {
            self.files.borrow_mut().remove(path);
            Ok(())
        }
        fn file_exists(&self, path: &Path) -> bool {
            self.files.borrow().contains_key(path)
        }
        fn run(&self, program: &str, args: &[String]) -> Result<String, String> {
            let line = format!("{program} {}", args.join(" "));
            self.calls.borrow_mut().push(line.clone());
            let registers = line.contains("/Create") || line.contains("bootstrap") || line.contains("enable --now");
            let removes = line.contains("/Delete") || line.contains("bootout") || line.contains("disable --now");
            let asks = line.contains("/Query") || line.contains(" print ") || line.contains("is-enabled");
            if registers {
                if self.fail_register {
                    return Err("access denied".into());
                }
                *self.registered.borrow_mut() = true;
            } else if removes {
                *self.registered.borrow_mut() = false;
            } else if asks && !*self.registered.borrow() {
                return Err("not found".into());
            } else if program == "id" {
                return Ok("501".into());
            } else if program == "cmd" {
                return self.ver.clone().ok_or_else(|| "no cmd".to_string());
            }
            Ok(String::new())
        }
    }

    #[test]
    fn enabling_then_disabling_leaves_nothing_behind_on_every_platform() {
        for platform in [Platform::Windows, Platform::MacOs, Platform::Linux] {
            let fake = Fake::default();
            let home = Path::new("/home/u");
            let i = install();
            assert!(!status(platform, &i, home, &fake, None).installed, "{platform:?} starts uninstalled");
            enable(platform, &i, home, &fake).unwrap();
            assert!(status(platform, &i, home, &fake, None).installed, "{platform:?} installed");
            assert!(!fake.files.borrow().is_empty());
            disable(platform, &i, home, &fake).unwrap();
            assert!(fake.files.borrow().is_empty(), "{platform:?} left files");
            assert!(!*fake.registered.borrow(), "{platform:?} left a registration");
            assert!(!status(platform, &i, home, &fake, None).installed);
        }
    }

    #[test]
    fn a_failed_registration_removes_the_files_it_wrote() {
        let fake = Fake { fail_register: true, ..Default::default() };
        let err = enable(Platform::Linux, &install(), Path::new("/home/u"), &fake).unwrap_err();
        assert!(err.contains("access denied"), "{err}");
        assert!(fake.files.borrow().is_empty());
    }

    #[test]
    fn disabling_when_nothing_is_installed_is_not_an_error() {
        let fake = Fake::default();
        disable(Platform::Windows, &install(), Path::new("/h"), &fake).unwrap();
    }

    #[test]
    fn macos_uses_the_user_domain_and_boots_out_any_stale_entry_first() {
        let fake = Fake::default();
        enable(Platform::MacOs, &install(), Path::new("/Users/u"), &fake).unwrap();
        // Paths join with the host's separator; the command is the same.
        let calls: Vec<String> = fake.calls.borrow().iter().map(|c| c.replace('\\', "/")).collect();
        let out = calls.iter().position(|c| c == "launchctl bootout gui/501/ai.flint.schedule").unwrap();
        let boot = calls
            .iter()
            .position(|c| c == "launchctl bootstrap gui/501 /Users/u/Library/LaunchAgents/ai.flint.schedule.plist")
            .unwrap();
        assert!(out < boot);
    }
}
