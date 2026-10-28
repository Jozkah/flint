#[cfg(windows)]
fn window_chrome_hwnd(ctx: &Ctx) -> Result<isize, Failure> {
    ctx.window
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| Failure(format!("no native window handle: {e}")))
}

/// A point on the native caption, found by asking the window rather than by
/// assuming a title-bar height, and away from the caption buttons.
#[cfg(windows)]
fn caption_point(hwnd: isize) -> Result<(i32, i32), Failure> {
    let r = win32::rect(hwnd);
    let x = r.left + (r.right - r.left) / 3;
    for dy in 1..80 {
        if win32::hit_test(hwnd, x, r.top + dy) == win32::HTCAPTION {
            // Aim at the middle of the caption band rather than its top edge.
            let mut last = r.top + dy;
            while last < r.top + 80 && win32::hit_test(hwnd, x, last + 1) == win32::HTCAPTION {
                last += 1;
            }
            return Ok((x, (r.top + dy + last) / 2));
        }
    }
    bail!("the window reports no native caption in its top 80px (rect {r:?})")
}

/// The centre of a caption button as it is drawn: DWM's button band split
/// into minimise, maximise and close. The hit-test code only confirms the
/// window has such a button at all (see [`win32::caption_button_band`] for why
/// its geometry is not used to aim).
#[cfg(windows)]
fn caption_button(hwnd: isize, code: isize, _y: i32) -> Option<(i32, i32)> {
    let r = win32::rect(hwnd);
    let row = (r.top + 1..r.top + 80).find(|&y| {
        (r.left..r.right)
            .step_by(4)
            .any(|x| win32::hit_test(hwnd, x, y) == code)
    })?;
    let band = win32::caption_button_band(hwnd)?;
    let third = (band.right - band.left) / 3;
    let slot = match code {
        win32::HTMINBUTTON => 0,
        win32::HTMAXBUTTON => 1,
        win32::HTCLOSE => 2,
        _ => return None,
    };
    let x = band.left + third * slot + third / 2;
    let y = (band.top.max(row) + band.bottom) / 2;
    Some((x, y))
}

#[cfg(windows)]
fn real_click(x: i32, y: i32) -> bool {
    let ok = win32::move_to(x, y);
    std::thread::sleep(Duration::from_millis(60));
    let ok = ok && win32::down(x, y);
    std::thread::sleep(Duration::from_millis(40));
    ok && win32::up(x, y)
}

#[cfg(windows)]
fn real_double_click(x: i32, y: i32) -> bool {
    let gap = (win32::double_click_ms() / 4).clamp(30, 120);
    let mut ok = win32::move_to(x, y);
    std::thread::sleep(Duration::from_millis(80));
    for _ in 0..2 {
        ok = ok && win32::down(x, y);
        std::thread::sleep(Duration::from_millis(20));
        ok = ok && win32::up(x, y);
        std::thread::sleep(Duration::from_millis(gap));
    }
    ok
}

#[cfg(windows)]
fn wait_for<F: Fn() -> bool>(hwnd: isize, what: &str, f: F) -> ScenarioResult {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if f() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!("timed out waiting for: {what} ({})", win32::input_context(hwnd))
}

/// Where the first run leaves its expectation for the restarted process.
#[cfg(windows)]
fn window_chrome_expectation(ctx: &Ctx) -> PathBuf {
    ctx.workspace.join("window-chrome-expected.json")
}

#[cfg(windows)]
fn real_input_allowed() -> bool {
    std::env::var("COWORK_SMOKE_REAL_INPUT").is_ok_and(|v| v == "1")
}

/// The native title bar, pressed with the real mouse.
///
/// Starts unmaximised, drags the window by its title bar, double-clicks to
/// maximise and restore, uses the maximise and minimise caption buttons, then
/// clicks a page control right under the title bar and checks it received a
/// trusted click while the window stayed put. Leaves the window maximised over
/// a known normal frame, which the restarted process must bring back.
#[cfg(windows)]
fn scenario_window_chrome(ctx: &Ctx) -> ScenarioResult {
    if !real_input_allowed() {
        println!("      skipped: set COWORK_SMOKE_REAL_INPUT=1 (moves the real pointer)");
        return Ok(());
    }
    let hwnd = window_chrome_hwnd(ctx)?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the header",
        "return document.querySelectorAll('button').length > 2;",
        Duration::from_secs(30),
    )?;

    // Real input goes to whatever is under the pointer, so keep this window
    // on top while it is being pressed.
    let _ = ctx.window.set_always_on_top(true);
    struct Unpin<'a>(&'a WebviewWindow);
    impl Drop for Unpin<'_> {
        fn drop(&mut self) {
            let _ = self.0.set_always_on_top(false);
        }
    }
    let _unpin = Unpin(&ctx.window);

    // 1. Unmaximised, at a known place.
    let _ = ctx.window.unmaximize();
    let _ = ctx.window.set_position(tauri::PhysicalPosition::new(120, 90));
    let _ = ctx.window.set_size(LogicalSize::new(1280.0, 860.0));
    let _ = ctx.window.set_focus();
    std::thread::sleep(Duration::from_millis(500));
    ensure!(!win32::zoomed(hwnd), "the window did not start unmaximised");
    let start = win32::rect(hwnd);
    println!("      start rect {start:?}");

    // The window has a native caption, with the platform's own buttons.
    let (cx, cy) = caption_point(hwnd)?;
    let min_btn = caption_button(hwnd, win32::HTMINBUTTON, cy);
    let max_btn = caption_button(hwnd, win32::HTMAXBUTTON, cy);
    let close_btn = caption_button(hwnd, win32::HTCLOSE, cy);
    println!("      caption at ({cx},{cy}); min {min_btn:?} max {max_btn:?} close {close_btn:?}");
    ensure!(
        min_btn.is_some() && max_btn.is_some() && close_btn.is_some(),
        "the native caption is missing a button: min {min_btn:?} max {max_btn:?} close {close_btn:?}"
    );

    // Nothing of the page's may pretend to be a title bar any more.
    let drag_regions = ctx.eval(
        "return [...document.querySelectorAll('[data-tauri-drag-region]')]
           .filter(e => e.id !== 'initial-loader' && !e.closest('#initial-loader')).length;",
    )?;
    ensure!(
        drag_regions.as_u64() == Some(0),
        "the page still declares {drag_regions} drag region(s) under a native title bar"
    );

    // 2-3. Drag by the title bar; the frame moves by the pointer's travel and
    // keeps its size.
    let (dx, dy) = (180, 110);
    ensure!(win32::move_to(cx, cy), "SendInput refused the pointer move");
    std::thread::sleep(Duration::from_millis(120));
    ensure!(win32::down(cx, cy), "SendInput refused the button press");
    for i in 1..=12 {
        std::thread::sleep(Duration::from_millis(25));
        win32::move_to(cx + dx * i / 12, cy + dy * i / 12);
    }
    std::thread::sleep(Duration::from_millis(80));
    win32::up(cx + dx, cy + dy);
    wait_for(hwnd, "the dragged window to settle", || win32::rect(hwnd) != start)?;
    std::thread::sleep(Duration::from_millis(300));
    let moved = win32::rect(hwnd);
    println!("      after drag {moved:?}");
    let (mx, my) = (moved.left - start.left, moved.top - start.top);
    ensure!(
        (mx - dx).abs() <= 4 && (my - dy).abs() <= 4,
        "dragging the title bar by ({dx},{dy}) moved the window by ({mx},{my}); expected the \
         pointer at ({},{}) ({})",
        cx + dx,
        cy + dy,
        win32::input_context(hwnd)
    );
    ensure!(
        moved.right - moved.left == start.right - start.left
            && moved.bottom - moved.top == start.bottom - start.top,
        "dragging resized the window: {start:?} -> {moved:?}"
    );

    // 5. Minimise with the caption button; restore as the taskbar would.
    let (_, cy4) = caption_point(hwnd)?;
    let (bx, by) = caption_button(hwnd, win32::HTMINBUTTON, cy4)
        .ok_or_else(|| Failure("no minimise button".into()))?;
    let code = win32::hit_test(hwnd, bx, by);
    println!(
        "      minimise button at ({bx},{by}) hit-tests {code}; rect {:?}",
        win32::rect(hwnd)
    );
    // Pressed in three visible steps -- arrive, press, release -- with the
    // window's state read after each, so a failure says which of them did it.
    let state_now = || {
        format!(
            "hit {} iconic {} zoomed {} {:?}",
            win32::hit_test(hwnd, bx, by),
            win32::iconic(hwnd),
            win32::zoomed(hwnd),
            win32::rect(hwnd)
        )
    };
    ensure!(win32::move_to(bx, by), "SendInput refused the pointer move");
    std::thread::sleep(Duration::from_millis(300));
    let arrived = state_now();
    ensure!(win32::down(bx, by), "SendInput refused the press");
    std::thread::sleep(Duration::from_millis(150));
    let pressed = state_now();
    ensure!(win32::up(bx, by), "SendInput refused the release");
    println!("      minimise press: arrived [{arrived}] pressed [{pressed}]");
    // Every state the window passes through, so a failure says whether it
    // never minimised or minimised and came back as something else.
    let mut trace: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let started = Instant::now();
    let mut minimised = false;
    while Instant::now() < deadline {
        let state = format!(
            "iconic={} zoomed={} {:?}",
            win32::iconic(hwnd),
            win32::zoomed(hwnd),
            win32::rect(hwnd)
        );
        if trace.last().map(|l| !l.ends_with(&state)).unwrap_or(true) {
            trace.push(format!("+{}ms {state}", started.elapsed().as_millis()));
        }
        if win32::iconic(hwnd) {
            minimised = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    ensure!(
        minimised,
        "the minimise button did not minimise; states after the click: {}",
        trace.join(" | ")
    );
    std::thread::sleep(Duration::from_millis(300));
    win32::restore(hwnd);
    wait_for(hwnd, "the minimised window to restore", || !win32::iconic(hwnd))?;
    std::thread::sleep(Duration::from_millis(500));
    let back = win32::rect(hwnd);
    ensure!(back == moved, "minimise and restore came back to {back:?}, not {moved:?}");

    // 4. Double-click the title bar: maximise, then restore to the same frame.
    let (cx, cy) = caption_point(hwnd)?;
    ensure!(real_double_click(cx, cy), "SendInput refused the double-click");
    wait_for(hwnd, "a double-click on the title bar to maximise", || win32::zoomed(hwnd))?;
    std::thread::sleep(Duration::from_millis(400));
    let (cx2, cy2) = caption_point(hwnd)?;
    ensure!(real_double_click(cx2, cy2), "SendInput refused the double-click");
    wait_for(hwnd, "a second double-click to restore", || !win32::zoomed(hwnd))?;
    std::thread::sleep(Duration::from_millis(400));
    let restored = win32::rect(hwnd);
    ensure!(
        restored == moved,
        "restoring from maximised came back to {restored:?}, not {moved:?}"
    );


    // Minimise again straight after a double-click restore: the window must
    // not be left in a state where its next caption press means something
    // else, and the restored frame must survive a second round trip.
    {
        let (_, cyd) = caption_point(hwnd)?;
        let (mx2, my2) = caption_button(hwnd, win32::HTMINBUTTON, cyd)
            .ok_or_else(|| Failure("no minimise button after the restore".into()))?;
        ensure!(real_click(mx2, my2), "SendInput refused the click");
        wait_for(hwnd, "minimise after a double-click restore", || win32::iconic(hwnd))?;
        ensure!(
            !win32::zoomed(hwnd),
            "minimising after a double-click restore left the window maximised"
        );
        win32::restore(hwnd);
        wait_for(hwnd, "the window to come back", || !win32::iconic(hwnd))?;
        std::thread::sleep(Duration::from_millis(500));
        let again = win32::rect(hwnd);
        ensure!(again == moved, "the second round trip came back to {again:?}, not {moved:?}");
    }

    // The maximise caption button maximises and restores too. Last among the
    // caption buttons: hovering it opens the Windows 11 Snap Layouts flyout,
    // which outlives the click, so the pointer is parked over the page
    // afterwards rather than left where the flyout can catch the next press.
    let (_, cy2) = caption_point(hwnd)?;
    let (bx, by) = caption_button(hwnd, win32::HTMAXBUTTON, cy2)
        .ok_or_else(|| Failure("no maximise button".into()))?;
    ensure!(real_click(bx, by), "SendInput refused the click");
    wait_for(hwnd, "the maximise button to maximise", || win32::zoomed(hwnd))?;
    std::thread::sleep(Duration::from_millis(400));
    let (_, cy3) = caption_point(hwnd)?;
    let (bx, by) = caption_button(hwnd, win32::HTMAXBUTTON, cy3)
        .ok_or_else(|| Failure("no restore button".into()))?;
    ensure!(real_click(bx, by), "SendInput refused the click");
    wait_for(hwnd, "the restore button to restore", || !win32::zoomed(hwnd))?;
    let r = win32::rect(hwnd);
    win32::move_to((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    std::thread::sleep(Duration::from_millis(900));
    let back = win32::rect(hwnd);
    ensure!(back == moved, "the restore button came back to {back:?}, not {moved:?}");

    // 6. A page control just under the title bar takes a real, trusted click,
    // and pressing it does not move the window.
    let target = ctx.eval_string(
        r#"window.__chromeClicks = [];
           const hits = [...document.querySelectorAll('button')].filter(b => {
             const r = b.getBoundingClientRect();
             return r.width > 0 && r.height > 0 && r.top < 60;
           });
           const b = hits[0];
           if (!b) return JSON.stringify(null);
           b.setAttribute('data-chrome-target', '1');
           // Capture on window: runs before React's root listener, so the
           // click is recorded and goes no further.
           if (!window.__chromeTrap) {
             window.__chromeTrap = true;
             window.addEventListener('click', (e) => {
               const t = e.target.closest && e.target.closest('[data-chrome-target]');
               if (!t) return;
               window.__chromeClicks.push({ trusted: e.isTrusted });
               e.stopPropagation(); e.preventDefault();
             }, true);
           }
           const r = b.getBoundingClientRect();
           const s = window.devicePixelRatio;
           const x = Math.round((r.left + r.width / 2) * s);
           const y = Math.round((r.top + r.height / 2) * s);
           const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
           return JSON.stringify({ x, y,
             label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40),
             reachable: !!hit && (hit === b || b.contains(hit)) });"#,
    )?;
    let t: Value = serde_json::from_str(&target).unwrap_or(Value::Null);
    ensure!(!t.is_null(), "no button in the band under the title bar to click");
    let (tx, ty) = (
        t["x"].as_i64().unwrap_or(0) as i32,
        t["y"].as_i64().unwrap_or(0) as i32,
    );
    ensure!(
        t["reachable"].as_bool() == Some(true),
        "the control under the title bar is covered: {target}"
    );
    let (sx, sy) = win32::client_to_screen(hwnd, tx, ty);
    ensure!(
        win32::hit_test(hwnd, sx, sy) == win32::HTCLIENT,
        "the control at ({sx},{sy}) is not in the client area: the title bar covers it ({target})"
    );
    let before_click = win32::rect(hwnd);
    ensure!(real_click(sx, sy), "SendInput refused the click");
    ctx.wait_until(
        "the control to receive a trusted click",
        "return (window.__chromeClicks || []).some(c => c.trusted);",
        Duration::from_secs(5),
    )?;
    ensure!(
        win32::rect(hwnd) == before_click,
        "clicking a page control moved the window"
    );
    println!("      trusted click reached {}", t["label"]);

    // 8. The band under the title bar is client area end to end: no overlay
    // can be answering for it.
    let r = win32::rect(hwnd);
    let (_, top_client) = win32::client_to_screen(hwnd, 0, 4);
    for x in (r.left + 40..r.right - 40).step_by(60) {
        let code = win32::hit_test(hwnd, x, top_client);
        ensure!(
            code == win32::HTCLIENT,
            "({x},{top_client}) under the title bar hit-tests as {code}, not client"
        );
    }

    // Across monitors, by the title bar, when there is another one: the frame
    // lands on it with the same logical size (so a different scale would not
    // shrink or grow it), and comes back the same way.
    let monitors = ctx.window.available_monitors().unwrap_or_default();
    let here = ctx.window.current_monitor().ok().flatten();
    let other = monitors.iter().find(|m| {
        here.as_ref()
            .map(|h| h.position() != m.position())
            .unwrap_or(false)
    });
    match other {
        None => println!("      one monitor: moving between monitors not exercised"),
        Some(target) => {
            let before_logical = ctx
                .window
                .inner_size()
                .ok()
                .zip(ctx.window.scale_factor().ok())
                .map(|(s, f)| ((s.width as f64 / f).round(), (s.height as f64 / f).round()));
            let area = target.work_area();
            let (cx6, cy6) = caption_point(hwnd)?;
            let tx = area.position.x + area.size.width as i32 / 3;
            let ty = area.position.y + 120;
            ensure!(win32::move_to(cx6, cy6), "SendInput refused the pointer move");
            std::thread::sleep(Duration::from_millis(120));
            ensure!(win32::down(cx6, cy6), "SendInput refused the press");
            for i in 1..=20 {
                std::thread::sleep(Duration::from_millis(25));
                win32::move_to(cx6 + (tx - cx6) * i / 20, cy6 + (ty - cy6) * i / 20);
            }
            std::thread::sleep(Duration::from_millis(120));
            win32::up(tx, ty);
            std::thread::sleep(Duration::from_millis(800));
            let now_on = ctx.window.current_monitor().ok().flatten();
            let landed = now_on
                .as_ref()
                .is_some_and(|m| m.position() == target.position());
            let after_logical = ctx
                .window
                .inner_size()
                .ok()
                .zip(ctx.window.scale_factor().ok())
                .map(|(s, f)| ((s.width as f64 / f).round(), (s.height as f64 / f).round()));
            println!(
                "      across monitors: target scale {} landed {landed}; logical size {before_logical:?} -> {after_logical:?}",
                target.scale_factor()
            );
            ensure!(
                landed,
                "dragging the title bar to another monitor left the window on {:?} ({})",
                now_on.map(|m| *m.position()),
                win32::input_context(hwnd)
            );
            ensure!(
                before_logical == after_logical,
                "moving to another monitor changed the logical size: {before_logical:?} -> {after_logical:?}"
            );
            // And back, to the frame the rest of the scenario expects.
            let _ = ctx.window.set_position(tauri::PhysicalPosition::new(moved.left, moved.top));
            wait_for(hwnd, "the window to come back to its frame", || win32::rect(hwnd) == moved)?;
        }
    }

    // 7 (first half). Leave a known normal frame, maximised over it, and wait
    // for the record to be written.
    let (cx5, cy5) = caption_point(hwnd)?;
    ensure!(real_double_click(cx5, cy5), "SendInput refused the double-click");
    wait_for(hwnd, "the final maximise", || win32::zoomed(hwnd))?;
    std::thread::sleep(Duration::from_millis(1500));
    let data =
        std::env::var("JAN_DATA_FOLDER").map_err(|_| Failure("JAN_DATA_FOLDER unset".into()))?;
    let record: Value = std::fs::read(Path::new(&data).join("window-state.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| Failure("window-state.json was not written".into()))?;
    let main = &record["main"];
    println!("      recorded {main}");
    ensure!(
        main["maximized"].as_bool() == Some(true),
        "the record does not say maximised: {main}"
    );
    ensure!(
        main["x"].as_i64() == Some(moved.left as i64) && main["y"].as_i64() == Some(moved.top as i64),
        "the record kept {main}, not the normal frame at ({}, {})",
        moved.left,
        moved.top
    );
    let expected = serde_json::json!({
        "left": moved.left, "top": moved.top, "right": moved.right, "bottom": moved.bottom,
        "maximized": true,
    });
    std::fs::write(window_chrome_expectation(ctx), expected.to_string())
        .map_err(|e| Failure(format!("could not leave the expectation: {e}")))?;
    Ok(())
}

/// The restarted process: a new process, the same profile. The window comes
/// back maximised, on a monitor, and restoring it returns the normal frame the
/// first process left.
#[cfg(windows)]
fn scenario_window_chrome_restart(ctx: &Ctx) -> ScenarioResult {
    if !real_input_allowed() {
        println!("      skipped: set COWORK_SMOKE_REAL_INPUT=1 (moves the real pointer)");
        return Ok(());
    }
    let path = window_chrome_expectation(ctx);
    let Some(expected) = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        bail!(
            "no expectation at {} -- run `window-chrome` first with the same COWORK_SMOKE_KEEP",
            path.display()
        );
    };
    let hwnd = window_chrome_hwnd(ctx)?;
    let _ = ctx.window.set_always_on_top(true);
    std::thread::sleep(Duration::from_millis(800));
    let checks = (|| -> ScenarioResult {
        ensure!(win32::visible(hwnd), "the restarted window is not visible");
        ensure!(win32::on_a_monitor(hwnd), "the restarted window is on no monitor");
        ensure!(win32::zoomed(hwnd), "the restarted window did not come back maximised");
        let (cx, cy) = caption_point(hwnd)?;
        ensure!(real_double_click(cx, cy), "SendInput refused the double-click");
        wait_for(hwnd, "the restarted window to restore", || !win32::zoomed(hwnd))?;
        std::thread::sleep(Duration::from_millis(500));
        Ok(())
    })();
    let _ = ctx.window.set_always_on_top(false);
    checks?;
    let r = win32::rect(hwnd);
    let want = win32::RECT {
        left: expected["left"].as_i64().unwrap_or(0) as i32,
        top: expected["top"].as_i64().unwrap_or(0) as i32,
        right: expected["right"].as_i64().unwrap_or(0) as i32,
        bottom: expected["bottom"].as_i64().unwrap_or(0) as i32,
    };
    println!("      restored normal frame {r:?}, expected {want:?}");
    ensure!(
        (r.left - want.left).abs() <= 2
            && (r.top - want.top).abs() <= 2
            && (r.right - want.right).abs() <= 2
            && (r.bottom - want.bottom).abs() <= 2,
        "the restarted window's normal frame is {r:?}, not {want:?}"
    );
    Ok(())
}

#[cfg(not(windows))]
fn scenario_window_chrome(_ctx: &Ctx) -> ScenarioResult {
    println!("      skipped: the native title-bar scenario is Windows-only");
    Ok(())
}

#[cfg(not(windows))]
fn scenario_window_chrome_restart(_ctx: &Ctx) -> ScenarioResult {
    println!("      skipped: the native title-bar scenario is Windows-only");
    Ok(())
}

// ---------------------------------------------------------------------------
// Background shell jobs through the real backend (AH-102)
// ---------------------------------------------------------------------------

/// How many processes on the machine carry `needle` in their command line.
/// Asked of the kernel through PowerShell, so a surviving child of the killed
/// shell is counted even though the app no longer tracks it.
#[cfg(windows)]
fn processes_matching(needle: &str) -> Option<usize> {
    let script = format!(
        "@(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{needle}*' -and $_.ProcessId -ne $PID }}).Count"
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(windows))]
fn processes_matching(_needle: &str) -> Option<usize> {
    None
}

/// A backgrounded command belongs to the conversation that started it, is
/// killed with every process it started, and is collected exactly once.
///
/// Over real IPC into the real plugin: `execute_tool` with the same arguments
/// the Cowork dispatcher sends, then the `bash_jobs_list` / `bash_job_kill`
/// commands the Background Tasks panel calls. Another conversation must see
/// nothing and stop nothing.
fn scenario_background_job_isolation(ctx: &Ctx) -> ScenarioResult {
    let data = std::env::var("JAN_DATA_FOLDER").map_err(|_| Failure("JAN_DATA_FOLDER unset".into()))?;
    let (a, b) = ("smoke-bg-owner", "smoke-bg-other");
    // A unique sleep marks this job's processes on the machine. Not `ping`:
    // inside the AppContainer it can fail at once ("Unable to contact IP
    // driver") when the run has no network, which ends the job before the
    // kill it exists to test.
    let marker = "Start-Sleep -Seconds 67";
    // `;`, not `&&`: the confined shell on Windows is PowerShell 5.1, which has
    // no `&&`, and `;` separates statements in every shell the tool may pick.
    let command = format!("{marker}; echo token=sk-live_abcdefghijklmnop0123456789");
    let (ok, started) = ipc(
        ctx,
        "plugin:agent-tools|execute_tool",
        &format!(
            "{{ dataFolder: {data:?}, threadId: {a:?}, name: 'bash', \
               args: {{ command: {command:?}, background: true }}, callId: 'bg-call-1' }}"
        ),
    )?;
    let content = started.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    println!("      started: {}", content.chars().take(160).collect::<String>());
    if !ok || content.contains("bash is unavailable") {
        bail!("BLOCKED: this host starts no sandboxed shell for the desktop, so no background job can run: {started}");
    }
    let job = content
        .split("job_id=")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(str::to_string)
        .ok_or_else(|| Failure(format!("no job id in: {content}")))?;
    ensure!(
        content.contains("started as a background job"),
        "background: true did not background at once: {content}"
    );

    let list = |session: &str| -> Result<Vec<Value>, Failure> {
        let (ok, v) = ipc(ctx, "plugin:agent-tools|bash_jobs_list", &format!("{{ session: {session:?} }}"))?;
        ensure!(ok, "bash_jobs_list failed: {v}");
        Ok(v.as_array().cloned().unwrap_or_default())
    };
    let mine = |jobs: &[Value]| jobs.iter().find(|j| j["jobId"] == job.as_str()).cloned();

    // Another conversation sees nothing of it.
    ensure!(mine(&list(b)?).is_none(), "another session lists the job");
    let owned = mine(&list(a)?).ok_or_else(|| Failure("the owner does not list its job".into()))?;
    ensure!(owned["finished"] == false, "the job is not running: {owned}");
    let shown = owned["command"].as_str().unwrap_or("");
    ensure!(!shown.contains("sk-live_"), "the listed command carries the credential: {shown}");

    // Another conversation cannot stop it, and learns nothing by trying.
    let (ok, refused) = ipc(
        ctx,
        "plugin:agent-tools|bash_job_kill",
        &format!("{{ jobId: {job:?}, session: {b:?} }}"),
    )?;
    ensure!(ok && refused["outcome"] == "unknown", "another session's kill was not refused as unknown: {refused}");
    ensure!(mine(&list(a)?).is_some_and(|j| j["finished"] == false), "a refused kill stopped the job");
    let running = processes_matching(marker);
    println!("      processes carrying the marker while running: {running:?}");

    // Its own conversation stops it, with everything it started.
    let (ok, killed) = ipc(
        ctx,
        "plugin:agent-tools|bash_job_kill",
        &format!("{{ jobId: {job:?}, session: {a:?} }}"),
    )?;
    if killed["outcome"] == "alreadyFinished" {
        // The command ended on its own before it could be stopped: say what it
        // printed, which is the only way to tell a sandbox refusal from a bug.
        let (_, v) = ipc(
            ctx,
            "plugin:agent-tools|execute_tool",
            &format!("{{ dataFolder: {data:?}, threadId: {a:?}, name: 'bash', args: {{ job_id: {job:?} }} }}"),
        )?;
        bail!("the background command finished by itself before the kill; it printed: {v}");
    }
    ensure!(ok && killed["outcome"] == "killed", "the owner's kill did not report killed: {killed}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut after = None;
    while Instant::now() < deadline {
        if let Some(j) = mine(&list(a)?) {
            if j["finished"] == true {
                after = Some(j);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let after = after.ok_or_else(|| Failure("the killed job never reported finished".into()))?;
    ensure!(after["stoppedByRequest"] == true, "the job does not say it was stopped: {after}");
    std::thread::sleep(Duration::from_millis(500));
    let left = processes_matching(marker);
    println!("      processes carrying the marker after the kill: {left:?}");
    if let (Some(before), Some(now)) = (running, left) {
        ensure!(before > 0, "the marker matched no process while the job ran; the check proves nothing");
        ensure!(now == 0, "{now} process(es) of the killed job are still alive");
    }

    // Collected exactly once, by its owner only.
    let collect = |session: &str| -> Result<String, Failure> {
        let (_, v) = ipc(
            ctx,
            "plugin:agent-tools|execute_tool",
            &format!("{{ dataFolder: {data:?}, threadId: {session:?}, name: 'bash', args: {{ job_id: {job:?} }} }}"),
        )?;
        Ok(v.get("content").and_then(Value::as_str).unwrap_or(&v.to_string()).to_string())
    };
    let stolen = collect(b)?;
    ensure!(stolen.contains("unknown or already-collected"), "another session collected it: {stolen}");
    let first = collect(a)?;
    ensure!(!first.contains("unknown or already-collected"), "the owner could not collect: {first}");
    let second = collect(a)?;
    ensure!(second.contains("unknown or already-collected"), "a second collection returned output again: {second}");
    println!("      job {job}: refused across sessions, killed with its tree, collected once");
    Ok(())
}

// ---------------------------------------------------------------------------
// The execution record through the real backend (AH-050 v2 / AH-200)
// ---------------------------------------------------------------------------

const RECORD_SESSION: &str = "smoke-record-session";
const RECORD_OTHER: &str = "smoke-record-other";

/// Write the events a Cowork edit and a failed command produce, the way the
/// renderer does, over real IPC.
fn record_events(ctx: &Ctx) -> ScenarioResult {
    let events = serde_json::json!([
        { "call": "rec-edit", "tool": "edit", "phase": "requested",
          "input": "{\"path\":\"src/lib.rs\",\"new_string\":\"token=sk-live_abcdefghijklmnop0123\"}" },
        { "call": "rec-edit", "tool": "edit", "phase": "running" },
        { "call": "rec-edit", "tool": "edit", "phase": "succeeded", "resource": "src/lib.rs",
          "output": "Edited src/lib.rs",
          "diff": "@@ edit 1/1 @@\n-   1 | old line\n+   1 | new line\n+   2 | token=sk-live_abcdefghijklmnop0123\n" },
        { "call": "rec-compact", "tool": "compaction", "phase": "succeeded",
          "event_type": "lifecycle", "lifecycle": "compaction", "summary": "Compacted 12 messages into a summary" },
        { "call": "rec-bash", "tool": "bash", "phase": "requested", "input": "{\"command\":\"cargo test\"}" },
        { "call": "rec-bash", "tool": "bash", "phase": "failed", "exit_code": 101,
          "output": "test result: FAILED. 1 failed\n[exit 101]" }
    ]);
    for e in events.as_array().unwrap() {
        let mut e = e.clone();
        e["v"] = Value::from(2);
        e["at"] = Value::from("2026-09-11T00:00:00Z");
        e["session"] = Value::from(RECORD_SESSION);
        for (k, v) in [("run", ""), ("invocation", ""), ("agent", ""), ("project", ""), ("capability", ""), ("kind", ""), ("resource", ""), ("summary", ""), ("detail", "")] {
            if e.get(k).is_none() {
                e[k] = Value::from(v);
            }
        }
        let (ok, v) = ipc(ctx, "tool_activity_record", &format!("{{ event: {e} }}"))?;
        ensure!(ok, "tool_activity_record refused an event: {v}");
    }
    let mut other = serde_json::json!({ "v": 2, "at": "2026-09-11T00:00:00Z", "session": RECORD_OTHER,
        "call": "rec-other", "tool": "read", "phase": "succeeded" });
    for k in ["run", "invocation", "agent", "project", "capability", "kind", "resource", "summary", "detail"] {
        other[k] = Value::from("");
    }
    let (ok, v) = ipc(ctx, "tool_activity_record", &format!("{{ event: {other} }}"))?;
    ensure!(ok, "tool_activity_record refused the other session's event: {v}");
    Ok(())
}

/// What a session's timeline reads back, checked the same way before and
/// after a restart.
fn check_record(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let (ok, items) = ipc(ctx, "tool_activity_items", &format!("{{ session: {RECORD_SESSION:?} }}"))?;
    ensure!(ok, "tool_activity_items failed: {items}");
    let items = items.as_array().cloned().unwrap_or_default();
    let calls: Vec<&str> = items.iter().filter_map(|i| i["call"].as_str()).collect();
    ensure!(calls == ["rec-edit", "rec-compact", "rec-bash"], "wrong items or order: {calls:?}");
    let seqs: Vec<u64> = items.iter().filter_map(|i| i["seq"].as_u64()).collect();
    ensure!(seqs.len() == 3 && seqs.windows(2).all(|w| w[0] < w[1]), "sequence not increasing: {seqs:?}");
    let edit = &items[0];
    ensure!(edit["phase"] == "succeeded", "edit phase: {edit}");
    ensure!(edit["change"]["added"] == 2 && edit["change"]["removed"] == 1, "edit counts: {}", edit["change"]);
    ensure!(edit["change"]["diffStored"] == true, "diff not stored: {}", edit["change"]);
    let raw = items.iter().map(|i| i.to_string()).collect::<String>();
    ensure!(!raw.contains("sk-live_"), "a credential reached the items: {raw}");
    ensure!(items[1]["event_type"] == "lifecycle" && items[1]["lifecycle"] == "compaction", "compaction item: {}", items[1]);
    let bash = &items[2];
    ensure!(bash["phase"] == "failed" && bash["exit_code"] == 101, "bash item: {bash}");
    ensure!(bash["output_state"] == "available", "bash output state: {bash}");
    let (ok, diff) = ipc(ctx, "tool_activity_diff", &format!("{{ session: {RECORD_SESSION:?}, call: 'rec-edit' }}"))?;
    ensure!(ok && diff.as_str().is_some_and(|d| d.contains("new line")), "stored diff: {diff}");
    ensure!(!diff.to_string().contains("sk-live_"), "a credential reached the stored diff: {diff}");
    let (ok, foreign) = ipc(ctx, "tool_activity_diff", &format!("{{ session: {RECORD_OTHER:?}, call: 'rec-edit' }}"))?;
    ensure!(ok && foreign.is_null(), "another session read this session's diff: {foreign}");
    Ok(items)
}

fn scenario_execution_record(ctx: &Ctx) -> ScenarioResult {
    record_events(ctx)?;
    let items = check_record(ctx)?;
    // The export: this session's decisions and record, nobody else's.
    let (ok, export) = ipc(ctx, "audit_export", &format!("{{ session: {RECORD_SESSION:?} }}"))?;
    ensure!(ok, "audit_export failed: {export}");
    let doc: Value = serde_json::from_str(export.as_str().unwrap_or("")).map_err(|e| Failure(format!("export is not JSON: {e}")))?;
    ensure!(doc["format"] == "jan-audit-export", "export format: {}", doc["format"]);
    let exported: Vec<&str> = doc["activity"].as_array().into_iter().flatten().filter_map(|i| i["call"].as_str()).collect();
    ensure!(!exported.contains(&"rec-other"), "the export carries another session's record: {exported:?}");
    ensure!(exported.len() == items.len(), "export and timeline disagree: {exported:?}");
    let (ok, refused) = ipc(ctx, "audit_export", "{ session: '' }")?;
    ensure!(!ok, "an export with no session was not refused: {refused}");
    let order: Vec<String> = items.iter().filter_map(|i| i["call"].as_str().map(str::to_string)).collect();
    std::fs::write(ctx.workspace.join("record-expected.json"), serde_json::to_string(&order).unwrap_or_default())
        .map_err(|e| Failure(format!("could not leave the expectation: {e}")))?;
    println!("      record: {} items in sequence, diff stored and scoped, export scoped", items.len());
    Ok(())
}

/// A new process on the same profile reads back the same items, in the same
/// order, with the same terminal states.
fn scenario_execution_record_restart(ctx: &Ctx) -> ScenarioResult {
    let expected: Vec<String> = std::fs::read(ctx.workspace.join("record-expected.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| Failure("no expectation -- run execution-record first with the same COWORK_SMOKE_KEEP".into()))?;
    let items = check_record(ctx)?;
    let order: Vec<String> = items.iter().filter_map(|i| i["call"].as_str().map(str::to_string)).collect();
    ensure!(order == expected, "after a restart the order is {order:?}, not {expected:?}");
    println!("      record after restart: same {} items, same order, same states", items.len());
    Ok(())
}
