//! Screenshots of HTML: the headless browser `screenshot` and the
//! app's page renderer launch, and the confined document they load.

use super::*;

pub(super) const SCREENSHOT_MAX_PNG_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

/// The browser `screenshot` launches. One resolver serves this and the app's
/// "Verify in browser" (`browser_discovery`), so a browser the user chose in
/// the app is the one used here.
pub(super) fn chrome_binary() -> Option<PathBuf> {
    crate::browser_discovery::find_browser_path()
}

/// Content-Security-Policy put in front of every page `screenshot` renders
/// (Jozkah/jan#236). `default-src 'none'` blocks every script and every
/// subresource fetch, so a page can pull in neither `file://` frames/images
/// (host files outside the workspace, including ones the jail hides) nor
/// `http(s)://` ones (network egress regardless of `allow_network`). Only
/// inline styles and `data:` assets render.
pub(super) const SCREENSHOT_CSP: &str = "default-src 'none'; style-src 'unsafe-inline' data:; \
     img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

/// Build the self-contained document headless Chrome actually loads for a
/// model-supplied `.html`/`.htm`/`.svg` file (Jozkah/jan#236).
///
/// HTML gets [`SCREENSHOT_CSP`] as the first element of its head (after a
/// leading doctype, so standards mode is kept). Every `http-equiv` attribute
/// name in the original is renamed first: attribute names cannot be spelled
/// with character references, so this reliably disarms `<meta http-equiv=
/// "refresh">`, the one way a script-less page can navigate itself (CSP does
/// not govern navigation) to a `file://` URL. It also drops any CSP the page
/// ships itself, which could only have been stricter-or-equal once ours is in
/// place. A UTF-16 file is refused, since the byte-level rewrite can't see it.
///
/// SVG is not rendered as a document at all: it is embedded as a `data:`
/// image, which runs in Chrome's secure image mode (no script, no external
/// loads).
pub(super) fn confined_screenshot_document(bytes: &[u8], svg: bool) -> Result<Vec<u8>, String> {
    let meta = format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{SCREENSHOT_CSP}\">"
    );
    if svg {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(format!(
            "<!DOCTYPE html><html><head>{meta}<style>html,body{{margin:0}}</style></head>\
             <body><img src=\"data:image/svg+xml;base64,{b64}\"></body></html>"
        )
        .into_bytes());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) || bytes.starts_with(&[0xFF, 0xFE]) {
        return Err("screenshot does not render UTF-16 encoded HTML".to_string());
    }
    const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
    let (bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (BOM, rest),
        None => (&[][..], bytes),
    };
    // Rename every `http-equiv` (ASCII case-insensitive) to a same-length inert
    // name, so nothing else in the document shifts.
    const NEEDLE: &[u8] = b"http-equiv";
    let mut body = body.to_vec();
    let mut i = 0;
    while i + NEEDLE.len() <= body.len() {
        if body[i..i + NEEDLE.len()].eq_ignore_ascii_case(NEEDLE) {
            body[i..i + NEEDLE.len()].copy_from_slice(b"data-inert");
            i += NEEDLE.len();
        } else {
            i += 1;
        }
    }
    // Keep a leading `<!doctype ...>` first so the page stays in standards
    // mode; the meta then lands in the implied head.
    let lead = body
        .iter()
        .take_while(|b| b.is_ascii_whitespace())
        .count();
    let split = if body[lead..]
        .get(..9)
        .is_some_and(|p| p.eq_ignore_ascii_case(b"<!doctype"))
    {
        body[lead..]
            .iter()
            .position(|&b| b == b'>')
            .map(|end| lead + end + 1)
            .unwrap_or(0)
    } else {
        0
    };
    let mut out = Vec::with_capacity(bom.len() + meta.len() + body.len());
    out.extend_from_slice(bom);
    out.extend_from_slice(&body[..split]);
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(&body[split..]);
    Ok(out)
}

/// Render a local HTML/SVG file to PNG bytes with headless Chrome.
///
/// Shared by the model-facing `screenshot` tool and the `agent_render_preview`
/// command the annotation overlay calls, so both agree on Chrome discovery,
/// viewport clamping and the output cap. `width`/`height` are the viewport in
/// CSS pixels; the caller picks them (the overlay passes its own stage size so
/// the PNG lines up pixel-for-pixel with what the user drew on).
///
/// `scale` is the device pixel ratio: the PNG comes out `width*scale` pixels
/// wide with the layout unchanged. The overlay passes the webview's own ratio
/// so a HiDPI screen doesn't composite crisp marks over an upscaled blur.
/// A `file:` URL for a local path. On Windows a drive path needs three
/// slashes and forward slashes (`file:///C:/...`); `file://C:\...` names a
/// host, which Chrome can't load (Jozkah/jan#242). `%`, spaces and `#` are
/// escaped so the path survives as one URL.
/// Whether the screenshot's headless Chrome is started with `--no-sandbox`:
/// only when it runs as root (Chrome refuses to start sandboxed there) or the
/// user set `FLINT_BROWSER_NO_SANDBOX`.
pub(super) fn screenshot_needs_no_sandbox(as_root: bool, opted_out: bool) -> bool {
    as_root || opted_out
}

pub(super) fn local_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let escaped = raw.replace('%', "%25").replace(' ', "%20").replace('#', "%23");
    if cfg!(windows) {
        format!("file:///{}", escaped.replace('\\', "/"))
    } else {
        format!("file://{escaped}")
    }
}

pub async fn render_html_png(
    target: &Path,
    width: u64,
    height: u64,
    scale: f64,
) -> Result<Vec<u8>, String> {
    render_html_png_noted(target, width, height, scale)
        .await
        .map(|(png, _)| png)
}

/// Why Chrome was rerun without its own sandbox, for the tool result.
pub(super) const NO_SANDBOX_RETRY_NOTE: &str =
    "note: Chrome could not start with its sandbox here, so this render was retried without it (the page is still confined: no script, no network).";

/// [`render_html_png`], retrying once with `--no-sandbox` when a sandboxed
/// Chrome fails to start for a sandbox reason, and saying so in the note.
pub async fn render_html_png_noted(
    target: &Path,
    width: u64,
    height: u64,
    scale: f64,
) -> Result<(Vec<u8>, Option<&'static str>), String> {
    let already = screenshot_needs_no_sandbox(
        crate::browser::confine::running_as_root(),
        std::env::var_os("FLINT_BROWSER_NO_SANDBOX").is_some(),
    );
    match render_html_png_opts(target, width, height, scale, false).await {
        Ok(png) => Ok((png, None)),
        Err(e) if !already && screenshot_failed_on_sandbox(&e) => {
            render_html_png_opts(target, width, height, scale, true)
                .await
                .map(|png| (png, Some(NO_SANDBOX_RETRY_NOTE)))
        }
        Err(e) => Err(e),
    }
}

/// Whether a failed render's error says Chrome could not start its sandbox.
pub(super) fn screenshot_failed_on_sandbox(error: &str) -> bool {
    error.starts_with("screenshot not produced") && error.to_ascii_lowercase().contains("sandbox")
}

pub(super) async fn render_html_png_opts(
    target: &Path,
    width: u64,
    height: u64,
    scale: f64,
    force_no_sandbox: bool,
) -> Result<Vec<u8>, String> {
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "html" && ext != "htm" && ext != "svg" {
        return Err(format!(
            "screenshot only renders .html/.htm/.svg files, got .{ext}"
        ));
    }
    if !target.is_file() {
        return Err(format!("file not found: {}", target.display()));
    }

    let Some(chrome) = chrome_binary() else {
        return Err(
            "no Chrome, Edge, Brave or other Chromium-based browser was found. Install one, or set \
             FLINT_BROWSER_PATH (or CHROME_PATH) to its full executable path; Flint does not \
             download a browser"
                .to_string(),
        );
    };

    let width = width.clamp(320, 4096);
    let height = height.clamp(240, 4096);
    let scale = if scale.is_finite() {
        scale.clamp(1.0, 3.0)
    } else {
        1.0
    };
    // A per-call profile (pid + nanos) keeps headless Chrome from colliding
    // with a running browser or a leftover from a previous call; `--screenshot`
    // exits after writing, but the wait below is bounded in case it lingers.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let shot = std::env::temp_dir().join(format!("jan-shot-{}-{nanos}.png", std::process::id()));
    let profile = std::env::temp_dir().join(format!("jan-chrome-{}-{nanos}", std::process::id()));
    let page = std::env::temp_dir().join(format!("jan-shot-{}-{nanos}.html", std::process::id()));

    // Chrome never loads the model's file directly: it loads a confined copy
    // (CSP, no script, no subresources; see `confined_screenshot_document`),
    // so a page cannot read host files through file:// frames or reach the
    // network (Jozkah/jan#236). The price is that relative assets and script-
    // drawn content no longer render; only inline styles and data: assets do.
    let original = tokio::fs::read(target)
        .await
        .map_err(|e| format!("failed to read {}: {e}", target.display()))?;
    let confined = confined_screenshot_document(&original, ext == "svg")?;
    tokio::fs::write(&page, &confined)
        .await
        .map_err(|e| format!("failed to stage the page for rendering: {e}"))?;
    let file_url = local_file_url(&page);
    // Chrome is spawned through the shell (`sh -c`): on macOS, a Chrome
    // headless-new process spawned directly by a non-bundled parent fails its
    // singleton/TCC check with "Multiple targets are not supported in headless
    // mode", while the same invocation via the shell succeeds. The `bash` tool
    // already relies on this property, so we inherit it here.
    let profile_quoted = shell_quote(profile.to_str().unwrap_or_default());
    let shot_quoted = shell_quote(shot.to_str().unwrap_or_default());
    let url_quoted = shell_quote(&file_url);
    let chrome_quoted = shell_quote(chrome.to_str().unwrap_or_default());
    // Defense in depth behind the CSP: every request sent to a dead proxy
    // (loopback included, via `<-loopback>`), every hostname resolving to
    // nothing, and Chrome's own background traffic disabled. Script is left
    // to the CSP (no script-src): `--blink-settings=scriptEnabled=false`
    // stops headless Chrome from writing the screenshot at all.
    let resolver_quoted = shell_quote("--host-resolver-rules=MAP * ~NOTFOUND");
    let bypass_quoted = shell_quote("--proxy-bypass-list=<-loopback>");
    // Chrome keeps its own sandbox unless it cannot start with one (running as
    // root, typically a container) or the user opted out.
    let no_sandbox = force_no_sandbox
        || screenshot_needs_no_sandbox(
            crate::browser::confine::running_as_root(),
            std::env::var_os("FLINT_BROWSER_NO_SANDBOX").is_some(),
        );
    let no_sandbox_flag = if no_sandbox { " --no-sandbox" } else { "" };
    let cmd = format!(
        "{chrome_quoted} --headless=new --disable-gpu --hide-scrollbars{no_sandbox_flag} \
         --disable-dev-shm-usage --no-first-run --user-data-dir={profile_quoted} \
         --proxy-server=127.0.0.1:9 {bypass_quoted} {resolver_quoted} \
         --disable-background-networking --disable-component-update --no-pings \
         --force-device-scale-factor={scale} \
         --window-size={width},{height} --screenshot={shot_quoted} {url_quoted}"
    );
    use jan_process::CommandConsole;
    // Windows: Chrome is started directly with an argument vector. The shell
    // detour exists only for the macOS singleton check above, and on Windows
    // the shell may be PowerShell or cmd, which do not understand the POSIX
    // quoting in `cmd` (Jozkah/jan#242).
    #[cfg(windows)]
    let mut command = {
        let _ = &cmd;
        let mut c = tokio::process::Command::new(&chrome);
        c.args([
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--proxy-server=127.0.0.1:9",
            "--proxy-bypass-list=<-loopback>",
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--disable-background-networking",
            "--disable-component-update",
            "--no-pings",
        ])
        .arg(format!("--user-data-dir={}", profile.display()));
        if no_sandbox {
            c.arg("--no-sandbox");
        }
        c.arg(format!("--force-device-scale-factor={scale}"))
        .arg(format!("--window-size={width},{height}"))
        .arg(format!("--screenshot={}", shot.display()))
        .arg(&file_url);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let shell = proc::shell();
        let mut c = tokio::process::Command::new(shell.program.clone());
        c.args(shell.args.clone()).arg(&cmd);
        c
    };
    let mut child = match command
        .background()
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = tokio::fs::remove_file(&page).await;
            return Err(format!("failed to launch Chrome: {e}"));
        }
    };
    // Bounded: headless Chrome can linger after writing the PNG. Give it a
    // generous window, then reap whatever is left and proceed if the file
    // exists. stderr is drained on a background task so a chatty Chrome never
    // fills the pipe and deadlocks.
    let stderr_pipe = child.stderr.take();
    let mut drain = tokio::spawn(async move {
        use tokio::io::AsyncReadExt as _;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let waited = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await;
    if waited.is_err() {
        // Chrome starts helper processes; `kill` below reaches only the parent.
        if let Some(pid) = child.id() {
            let _ = proc::kill_tree(pid);
        }
    }
    let _ = child.kill().await;
    // A helper that kept the pipe open must not hold the call past the render.
    let stderr = match tokio::time::timeout(std::time::Duration::from_secs(2), &mut drain).await {
        Ok(joined) => joined.unwrap_or_default(),
        Err(_) => {
            drain.abort();
            String::new()
        }
    };
    let _ = tokio::fs::remove_dir_all(&profile).await;
    let _ = tokio::fs::remove_file(&page).await;

    let png = match tokio::fs::read(&shot).await {
        Ok(b) => b,
        Err(e) => {
            let mut lines: Vec<&str> = stderr.lines().take(3).collect();
            if let Some(l) = stderr
                .lines()
                .skip(3)
                .find(|l| l.to_ascii_lowercase().contains("sandbox"))
            {
                lines.push(l);
            }
            let detail = lines.join(" | ");
            return Err(format!("screenshot not produced: {e} (chrome: {detail})"));
        }
    };
    let _ = tokio::fs::remove_file(&shot).await;

    if png.is_empty() {
        return Err("Chrome produced an empty screenshot (page may be blank)".to_string());
    }
    if png.len() > SCREENSHOT_MAX_PNG_BYTES {
        return Err(format!(
            "screenshot is {} KiB, over the {}-MiB cap; try a smaller viewport",
            png.len() / 1024,
            SCREENSHOT_MAX_PNG_BYTES / 1024 / 1024
        ));
    }
    Ok(png)
}

/// Render a local HTML/SVG file and hand the model the image.
///
/// Returns an `ImageContentPart` rather than a data URL pasted into the text,
/// matching what `read` does for images: that is the form a vision model
/// actually consumes, and it keeps a megabyte of base64 out of the transcript.
pub(super) async fn screenshot(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
) -> (String, Option<Vec<ImageContentPart>>) {
    let Some(path) = arg_str(args, "path") else {
        return ("ERROR: missing required argument 'path'".to_string(), None);
    };
    let width = arg_u64(args, "width").unwrap_or(1280).clamp(320, 4096);
    let height = arg_u64(args, "height").unwrap_or(960).clamp(240, 4096);
    let target = resolve_path(root, scratch, path);
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return (
            format!("ERROR: refused to screenshot through a symlink out of the workspace: {path}"),
            None,
        );
    }
    let (png, note) = match render_html_png_noted(&target, width, height, 1.0).await {
        Ok(b) => b,
        Err(e) => return (format!("ERROR: {e}"), None),
    };
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    (
        match note {
            Some(n) => format!("Screenshot of {path} ({width}x{height})\n{n}"),
            None => format!("Screenshot of {path} ({width}x{height})"),
        },
        Some(vec![ImageContentPart {
            data_url: format!("data:image/png;base64,{b64}"),
            name,
        }]),
    )
}
