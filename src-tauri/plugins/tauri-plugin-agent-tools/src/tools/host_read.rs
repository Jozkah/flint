//! The `host_query` tool: read-only facts about this computer, answered by the
//! host because the sandbox cannot see them.
//!
//! The `bash` tool runs in an AppContainer. It cannot list other programs'
//! processes, see which ports are open, read most of the registry or ask the
//! Task Scheduler anything, so questions such as "what is using port 3000" or
//! "what starts with Windows" have no answer there.
//!
//! The model never writes a command. It names one query from a fixed list, and
//! each query is a fixed PowerShell script. The only inputs are a few typed
//! filters, passed to the script as environment variables rather than spliced
//! into its text, and checked here first. Output is redacted for credentials
//! and bounded.

use std::time::Duration;

use serde_json::Value;

/// Longest output handed back to the model, in bytes.
pub const OUTPUT_CAP: usize = 48 * 1024;
const TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX: u64 = 40;
const MAX_MAX: u64 = 200;

pub const QUERIES: &[&str] = &[
    "processes",
    "services",
    "ports",
    "disks",
    "system",
    "installed_programs",
    "registry",
    "crash_reports",
    "scheduled_tasks",
    "startup_items",
    "wsl_distros",
];

/// A value name that is never shown, whatever key it sits in.
const SECRET_NAMES: &str = "(?i)pass|secret|token|credential|api.?key|private|cookie|session|auth";

/// Registry keys a model may read, as prefixes after normalising the hive.
const REGISTRY_ROOTS: &[&str] = &[
    "HKLM\\SOFTWARE",
    "HKCU\\SOFTWARE",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control",
];

/// A key segment that holds credentials or keys, refused wherever it appears.
const REGISTRY_REFUSED: &[&str] = &["secret", "credential", "password", "vault", "sam", "security", "lsa"];

const PROCESSES: &str = r#"
$n=$env:HQ_NAME; $id=$env:HQ_PID; $m=[int]$env:HQ_MAX
@(Get-Process | Where-Object { (-not $n -or $_.ProcessName -like "*$n*") -and (-not $id -or $_.Id -eq [int]$id) } | Sort-Object WorkingSet64 -Descending | Select-Object -First $m Id,ProcessName,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}},@{n='CpuSec';e={[math]::Round($_.CPU,1)}},StartTime,Path) | ConvertTo-Json -Compress -Depth 3
"#;

const SERVICES: &str = r#"
$n=$env:HQ_NAME; $s=$env:HQ_STATUS; $m=[int]$env:HQ_MAX
@(Get-Service | Where-Object { (-not $n -or $_.Name -like "*$n*" -or $_.DisplayName -like "*$n*") -and (-not $s -or "$($_.Status)" -eq $s) } | Select-Object -First $m Name,DisplayName,@{n='Status';e={"$($_.Status)"}},@{n='StartType';e={"$($_.StartType)"}}) | ConvertTo-Json -Compress -Depth 3
"#;

const PORTS: &str = r#"
$p=$env:HQ_PORT; $m=[int]$env:HQ_MAX
$procs=@{}; Get-Process | ForEach-Object { $procs[[int]$_.Id]=$_.ProcessName }
@(Get-NetTCPConnection -State Listen | Where-Object { -not $p -or $_.LocalPort -eq [int]$p } | Sort-Object LocalPort | Select-Object -First $m LocalAddress,LocalPort,OwningProcess,@{n='Process';e={$procs[[int]$_.OwningProcess]}}) | ConvertTo-Json -Compress -Depth 3
"#;

const DISKS: &str = r#"
@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,FileSystem,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}}) | ConvertTo-Json -Compress -Depth 3
"#;

const SYSTEM: &str = r#"
$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
[pscustomobject]@{
  OS="$($os.Caption) $($os.Version) build $($os.BuildNumber)"
  Architecture=$os.OSArchitecture
  Uptime=((Get-Date)-$os.LastBootUpTime).ToString('d\.hh\:mm\:ss')
  Cpu=$cpu.Name; Cores=$cpu.NumberOfCores; LogicalProcessors=$cpu.NumberOfLogicalProcessors
  MemoryGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1)
  FreeMemoryGB=[math]::Round($os.FreePhysicalMemory/1MB,1)
  Model="$($cs.Manufacturer) $($cs.Model)"
} | ConvertTo-Json -Compress -Depth 3
"#;

const INSTALLED_PROGRAMS: &str = r#"
$n=$env:HQ_NAME; $m=[int]$env:HQ_MAX
$paths='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
@(Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and (-not $n -or $_.DisplayName -like "*$n*") } | Sort-Object DisplayName | Select-Object -First $m DisplayName,DisplayVersion,Publisher,InstallDate) | ConvertTo-Json -Compress -Depth 3
"#;

const REGISTRY: &str = r#"
$m=[int]$env:HQ_MAX
$item=Get-Item -LiteralPath ("Registry::" + $env:HQ_KEY)
$vals=@()
foreach($name in $item.GetValueNames()){
  if($name -match $env:HQ_SECRET){ $text='[hidden]' } else { $text="$($item.GetValue($name))"; if($text.Length -gt 300){ $text=$text.Substring(0,300)+'...' } }
  $vals += [pscustomobject]@{Name=$name;Kind="$($item.GetValueKind($name))";Value=$text}
}
[pscustomobject]@{Key=$item.Name;SubKeys=@($item.GetSubKeyNames() | Select-Object -First $m);Values=@($vals | Select-Object -First $m)} | ConvertTo-Json -Compress -Depth 4
"#;

const CRASH_REPORTS: &str = r#"
$m=[int]$env:HQ_MAX
$ev=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001,1002} -MaxEvents $m -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,ProviderName,@{n='Message';e={$t="$($_.Message)"; if($t.Length -gt 600){$t.Substring(0,600)+'...'}else{$t}}})
$dumps=@()
foreach($d in @("$env:LOCALAPPDATA\CrashDumps","$env:ProgramData\Microsoft\Windows\WER\ReportArchive")){
  if(Test-Path $d){ $dumps += Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 FullName,@{n='SizeMB';e={[math]::Round($_.Length/1MB,1)}},LastWriteTime }
}
[pscustomobject]@{Events=$ev;Dumps=$dumps} | ConvertTo-Json -Compress -Depth 4
"#;

const SCHEDULED_TASKS: &str = r#"
$n=$env:HQ_NAME; $m=[int]$env:HQ_MAX
@(Get-ScheduledTask | Where-Object { (-not $n -or $_.TaskName -like "*$n*") -and $_.TaskPath -notlike '\Microsoft\*' } | Select-Object -First $m TaskName,TaskPath,@{n='State';e={"$($_.State)"}},@{n='Runs';e={ (@($_.Actions) | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; ' }}) | ConvertTo-Json -Compress -Depth 3
"#;

const STARTUP_ITEMS: &str = r#"
$m=[int]$env:HQ_MAX
@(Get-CimInstance Win32_StartupCommand | Select-Object -First $m Name,Command,Location,User) | ConvertTo-Json -Compress -Depth 3
"#;

/// What to run for a query: the script, and the environment it reads.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub script: &'static str,
    pub env: Vec<(&'static str, String)>,
}

/// Letters, digits, space, dot, dash, underscore: no wildcard, quote or `$`, so
/// the value is safe inside a `-like "*...*"` comparison.
fn plain(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

fn name_filter(args: &Value) -> Result<Option<String>, String> {
    match args.get("name") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if plain(s.trim()) => Ok(Some(s.trim().to_string())),
        Some(_) => Err("ERROR: host_query 'name' may hold letters, digits, spaces, dots, dashes and underscores (up to 64).".into()),
    }
}

/// Normalise a registry path to `HKLM\...` / `HKCU\...` and vet it.
pub fn vet_registry_key(key: &str) -> Result<String, String> {
    let key = key.trim().trim_end_matches('\\');
    let refuse = || {
        format!(
            "ERROR: host_query 'key' must start with one of {} and name no credential store.",
            REGISTRY_ROOTS.join(", ")
        )
    };
    if key.is_empty()
        || key.len() > 240
        || !key.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | '\\' | '{' | '}' | '(' | ')')
        })
        || key.contains("..")
        || key.contains("\\\\")
    {
        return Err(refuse());
    }
    let (hive, rest) = key.split_once('\\').unwrap_or((key, ""));
    let hive = match hive.to_ascii_uppercase().as_str() {
        "HKLM" | "HKEY_LOCAL_MACHINE" | "HKLM:" => "HKLM",
        "HKCU" | "HKEY_CURRENT_USER" | "HKCU:" => "HKCU",
        _ => return Err(refuse()),
    };
    let full = if rest.is_empty() { hive.to_string() } else { format!("{hive}\\{rest}") };
    let upper = full.to_ascii_uppercase();
    let rooted = REGISTRY_ROOTS.iter().any(|root| {
        let root = root.to_ascii_uppercase();
        upper == root || upper.starts_with(&format!("{root}\\"))
    });
    if !rooted {
        return Err(refuse());
    }
    let hidden = full
        .split('\\')
        .any(|segment| REGISTRY_REFUSED.iter().any(|bad| segment.to_ascii_lowercase() == *bad));
    if hidden {
        return Err(refuse());
    }
    Ok(full)
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ERROR: host_query needs a 'query': one of {}.", QUERIES.join(", ")))?;
    let max = match args.get("max_results") {
        None | Some(Value::Null) => DEFAULT_MAX,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: host_query 'max_results' must be a whole number.")?
            .clamp(1, MAX_MAX),
    };
    let mut env: Vec<(&'static str, String)> = vec![("HQ_MAX", max.to_string())];
    let script = match query {
        "processes" => {
            env.push(("HQ_NAME", name_filter(args)?.unwrap_or_default()));
            let pid = match args.get("pid") {
                None | Some(Value::Null) => String::new(),
                Some(v) => v
                    .as_u64()
                    .filter(|p| *p >= 1 && *p <= u32::MAX as u64)
                    .ok_or("ERROR: host_query 'pid' must be a whole number.")?
                    .to_string(),
            };
            env.push(("HQ_PID", pid));
            PROCESSES
        }
        "services" => {
            env.push(("HQ_NAME", name_filter(args)?.unwrap_or_default()));
            let status = match args.get("status").and_then(Value::as_str) {
                None => String::new(),
                Some(s) if s.eq_ignore_ascii_case("running") => "Running".into(),
                Some(s) if s.eq_ignore_ascii_case("stopped") => "Stopped".into(),
                Some(_) => return Err("ERROR: host_query 'status' must be running or stopped.".into()),
            };
            env.push(("HQ_STATUS", status));
            SERVICES
        }
        "ports" => {
            let port = match args.get("port") {
                None | Some(Value::Null) => String::new(),
                Some(v) => v
                    .as_u64()
                    .filter(|p| (1..=65_535).contains(p))
                    .ok_or("ERROR: host_query 'port' must be a number from 1 to 65535.")?
                    .to_string(),
            };
            env.push(("HQ_PORT", port));
            PORTS
        }
        "disks" => DISKS,
        "system" => SYSTEM,
        "installed_programs" => {
            env.push(("HQ_NAME", name_filter(args)?.unwrap_or_default()));
            INSTALLED_PROGRAMS
        }
        "registry" => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .ok_or("ERROR: host_query 'registry' needs a 'key', such as HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion.")?;
            env.push(("HQ_KEY", vet_registry_key(key)?));
            env.push(("HQ_SECRET", SECRET_NAMES.to_string()));
            REGISTRY
        }
        "crash_reports" => CRASH_REPORTS,
        "scheduled_tasks" => {
            env.push(("HQ_NAME", name_filter(args)?.unwrap_or_default()));
            SCHEDULED_TASKS
        }
        "startup_items" => STARTUP_ITEMS,
        "wsl_distros" => "",
        other => {
            return Err(format!(
                "ERROR: host_query has no query '{other}'. Use one of {}.",
                QUERIES.join(", ")
            ))
        }
    };
    Ok(Plan { script, env })
}

/// Cut to the output cap on a character boundary, saying so.
pub(crate) fn bounded(text: &str) -> String {
    if text.len() <= OUTPUT_CAP {
        return text.to_string();
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output cut at {} KB; narrow it with name, port or max_results]", &text[..end], OUTPUT_CAP / 1024)
}

/// `wsl --list` prints UTF-16; drop the NULs and the byte-order mark.
fn decode_wsl(bytes: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(bytes).chars().filter(|c| !matches!(*c, '\0' | '\u{feff}' | '\u{fffd}')).collect();
    text.trim().to_string()
}

#[cfg(windows)]
pub async fn host_query(args: &Value) -> String {
    use std::process::Stdio;
    let plan = match plan(args) {
        Ok(plan) => plan,
        Err(message) => return message,
    };
    let is_wsl = plan.script.is_empty();
    let mut cmd = if is_wsl {
        let mut c = tokio::process::Command::new("wsl.exe");
        c.args(["--list", "--verbose"]);
        c
    } else {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", plan.script]);
        c
    };
    for (key, value) in &plan.env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).creation_flags(0x0800_0000);
    let run = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await;
    match run {
        Err(_) => format!("ERROR: host_query did not finish in {TIMEOUT_SECS} seconds and was stopped."),
        Ok(Err(e)) => format!("ERROR: could not run the query: {e}"),
        Ok(Ok(out)) => {
            let (stdout, stderr) = if is_wsl {
                (decode_wsl(&out.stdout), decode_wsl(&out.stderr))
            } else {
                (String::from_utf8_lossy(&out.stdout).trim().to_string(), String::from_utf8_lossy(&out.stderr).trim().to_string())
            };
            if !out.status.success() {
                let reason = if stderr.is_empty() { stdout } else { stderr };
                return format!("ERROR: the query failed: {}", bounded(&crate::secrets::redact_secrets(&reason)));
            }
            if stdout.is_empty() || stdout == "null" {
                return "No results.".to_string();
            }
            bounded(&crate::secrets::redact_secrets(&stdout))
        }
    }
}

#[cfg(not(windows))]
pub async fn host_query(args: &Value) -> String {
    let _ = (args, Duration::from_secs(TIMEOUT_SECS), decode_wsl);
    "ERROR: host_query reads Windows system state and only works on Windows.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env_of(plan: &Plan, key: &str) -> Option<String> {
        plan.env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
    }

    #[test]
    fn every_listed_query_has_a_plan() {
        for query in QUERIES {
            let args = if *query == "registry" {
                json!({ "query": query, "key": "HKLM\\SOFTWARE\\Microsoft" })
            } else {
                json!({ "query": query })
            };
            assert!(plan(&args).is_ok(), "{query}");
        }
        assert!(plan(&json!({ "query": "format c:" })).is_err());
        assert!(plan(&json!({})).is_err());
    }

    #[test]
    fn filters_travel_as_environment_not_script_text() {
        let p = plan(&json!({ "query": "processes", "name": "chrome", "max_results": 5 })).unwrap();
        assert_eq!(env_of(&p, "HQ_NAME").as_deref(), Some("chrome"));
        assert_eq!(env_of(&p, "HQ_MAX").as_deref(), Some("5"));
        assert!(!p.script.contains("chrome"));
    }

    #[test]
    fn a_name_cannot_carry_a_wildcard_quote_or_variable() {
        for name in ["a*", "a\"; Remove-Item x", "$env:X", "a[b]", "x`y", ""] {
            assert!(plan(&json!({ "query": "processes", "name": name })).is_err(), "{name}");
        }
    }

    #[test]
    fn a_process_can_be_looked_up_by_number() {
        let p = plan(&json!({ "query": "processes", "pid": 4321 })).unwrap();
        assert_eq!(env_of(&p, "HQ_PID").as_deref(), Some("4321"));
        assert!(plan(&json!({ "query": "processes", "pid": "x" })).is_err());
        assert!(plan(&json!({ "query": "processes", "pid": 0 })).is_err());
    }

    #[test]
    fn port_status_and_count_are_checked() {
        assert!(plan(&json!({ "query": "ports", "port": 0 })).is_err());
        assert!(plan(&json!({ "query": "ports", "port": 70000 })).is_err());
        assert_eq!(env_of(&plan(&json!({ "query": "ports", "port": 3000 })).unwrap(), "HQ_PORT").as_deref(), Some("3000"));
        assert!(plan(&json!({ "query": "services", "status": "paused" })).is_err());
        assert_eq!(env_of(&plan(&json!({ "query": "services", "status": "RUNNING" })).unwrap(), "HQ_STATUS").as_deref(), Some("Running"));
        assert_eq!(env_of(&plan(&json!({ "query": "disks", "max_results": 100000 })).unwrap(), "HQ_MAX").as_deref(), Some("200"));
    }

    #[test]
    fn registry_keys_are_limited_to_the_allowed_roots() {
        assert_eq!(
            vet_registry_key("hkey_local_machine\\software\\Microsoft\\Windows NT\\CurrentVersion").unwrap(),
            "HKLM\\software\\Microsoft\\Windows NT\\CurrentVersion"
        );
        assert!(vet_registry_key("HKCU\\Software\\Flint").is_ok());
        assert!(vet_registry_key("HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache").is_ok());
        for bad in [
            "HKLM\\SAM",
            "HKLM\\SECURITY\\Policy",
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa",
            "HKLM\\SOFTWARE\\..\\SAM",
            "HKLM\\SOFTWARE\\Vendor\\Secret",
            "HKCU\\Environment",
            "HKU\\.DEFAULT",
            "HKLM",
            "",
            "HKLM\\SOFTWARE\\x;calc",
            "HKLM\\SOFTWARE\\x'y",
        ] {
            assert!(vet_registry_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn wsl_listing_is_decoded_from_utf16() {
        let utf16: Vec<u8> = "\u{feff}  NAME  STATE\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_wsl(&utf16), "NAME  STATE");
    }
}
