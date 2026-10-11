# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | Yes       |
| < 0.9   | No        |

Security fixes land on `main` and ship in the next 0.9.x release.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Open https://github.com/Jozkah/flint/security/advisories/new
   (or go to the **Security** tab and click **Report a vulnerability**).
2. Describe the issue, the affected version and platform, and steps to reproduce.
   A minimal proof of concept helps.

You will get a reply in the advisory thread. Once a fix is available, the advisory
is published with credit to the reporter unless you ask to stay anonymous.

## Scope

Flint runs models and agent tools locally on your machine. Reports are especially
welcome for:

- ways an agent or tool call can escape the configured permissions or sandbox,
- ways a model, MCP server, extension or downloaded file can run code or read files
  without the user's approval,
- leaks of API keys or other secrets stored by the app.

## Design note: PowerShell scripts that stay inside the workspace

The command scan treats PowerShell as opaque, so a multi-line script used to ask
for approval even in the mode that lets the agent work inside its own folder.
`tools/pwsh_scan.rs` (in `tauri-plugin-agent-tools`) lifts that prompt for the
narrow case of a script that only creates, reads and removes files in the run's
own folders, and nothing else.

- **Verdict.** `Contained` only when a real tokenizer plus a small interpreter
  prove every statement. Everything else is `NotProven` and keeps the existing
  prompt. A false negative costs a click; a false positive would be a bypass, so
  doubt always resolves to asking.
- **What is proven.** Each statement is a call to an allowlisted cmdlet or alias
  (file listing, read, write, create, remove, `Test-Path`, `Join-Path`,
  `Split-Path`, `Write-Output`, `Select-String`, `Measure/Sort/Select/Where/
  ForEach-Object` with simple blocks, `Set-Location` inside the root, read-only
  `git`), an assignment of a literal, `if`, or `foreach` over literals (unrolled).
  Every path is a literal or a variable derived from a literal, `Join-Path` or
  `Get-Location`, resolves inside the project, scratch or granted write roots,
  and still does after links and junctions are followed on disk.
- **Refused outright.** `..`, drive roots, UNC and device paths, `~`, `%`,
  `$env:` and other scoped variables, provider paths (`HKLM:`, `Env:`, `Cert:`),
  alternate streams, 8.3 names, reserved device names, wildcards outside the last
  component, `.git`/`.jan` paths, credential-file names, bulk deletes at a root,
  deleting a root, recursive deletes over a tree holding links or junctions,
  symlink/junction creation, `&`, dot-sourcing, `Invoke-Expression`,
  `Start-Process`, web cmdlets, `Add-Type`, `[type]::` calls, `$(...)`, backticks,
  redirection, splatting, `-EncodedCommand`, alias/function definitions, curly
  quotes and other look-alike characters, scripts over 20 KB.
- **Where it applies.** The exec gate allows a contained script only when the
  session already holds the write grant (`SessionGrants::covers(Write)`); in
  plan/read-only mode exec is denied before this check. The auto-approval check
  (`forced_prompt_reason`) stops calling a contained script opaque, but the
  destructive-command rules, hidden-path and `.git` denies, and ask rules still
  run first.
- **Residual risk.** The scan cannot know which shell will run the text (Git
  Bash may be chosen when PowerShell is the usual choice). Contained scripts
  therefore use only forms that do not expand in POSIX shells the same way (no
  backticks, `$(` or redirection; wildcards stay in the last component of an in-project path), and the OS
  sandbox still confines whatever runs. Time-of-check/time-of-use races on links
  are not closed by this scan; the sandbox is the backstop.

### PowerShell scan: classes closed after adversarial review, and limits

- A script-block parameter (`ForEach-Object`, `Where-Object`) accepts only a
  `{ }` block; a bare word would bind `-MemberName` and call a method on every
  item (`ForEach-Object Delete`).
- A lone carriage return is a line break in PowerShell; it is refused, and `\r`
  also ends statements and comments in the tokenizer.
- Wildcards are tested as globs against the protected names (`.git`, `.jan`,
  `.env*`, key and keystore extensions, `id_*`) for content reads and deletes;
  `*` and `.g*` are refused, `*.txt` is not. A listing that feeds `Get-Content`
  or `Select-String`, and every recursive delete, is walked on disk and refused
  if it holds protected names or links. Recursive listings are refused over links
  or junctions (5.1 follows them).
- Deleting or writing at any root, or at a folder that holds a root, is refused
  even when another granted root contains it.
- `git` option abbreviations of the banned options (`--ext-d`, `--out=`) and
  `-O<file>` / `grep -f` are refused.

Known limits, left as asking is not possible to decide statically: the working
folder is assumed to be the project root (a managed worktree that differs only
changes where relative paths land, always inside a granted root); which shell
runs the text is unknown, so backslash escapes in Git Bash could spell a
different (still in-root) name; and a link planted between the scan and the run
is not detected. The OS sandbox is the backstop for all three.
