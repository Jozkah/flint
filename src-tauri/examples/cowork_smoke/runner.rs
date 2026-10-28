fn main() {
    // The agent-tools plugin re-executes the current binary as its Windows
    // sandbox helper for every confined shell. Without this hand-off, as in
    // the app's own `main`, each helper launch of this binary started a whole
    // second harness -- WebView, fixture server and a full scenario run --
    // which loaded the machine, fought over the fixture port and wedged the
    // WebView under test.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    let args: Vec<String> = std::env::args().collect();
    let fixtures = fixtures_dir(&args);

    // Per-run scratch tree. `CI=e2e` makes the app resolve its data folder
    // relative to the CWD, so chdir'ing here keeps the run out of the real
    // Jan data folder.
    // `COWORK_SMOKE_KEEP=<dir>` keeps the profile for a second run, which is
    // how a real restart is exercised: the second process inherits the data
    // folder and the WebView profile exactly as an installed app would.
    let keep = std::env::var_os("COWORK_SMOKE_KEEP").map(PathBuf::from);
    let workspace = keep
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join(format!("cowork-smoke-{}", std::process::id())));
    let resumed = keep.is_some() && workspace.join("data").join("settings.json").is_file();
    RESUMED.store(resumed, Ordering::SeqCst);
    if !resumed {
        let _ = std::fs::remove_dir_all(&workspace);
    }
    std::fs::create_dir_all(&workspace).expect("failed to create smoke workspace");
    // `JAN_DATA_FOLDER` is the only override `resolve_jan_data_folder` honours,
    // and it is the one that matters: settings.json -- which is where the
    // Cowork session store actually persists, via `settings_set` -- is resolved
    // through that function and NOT through `CI=e2e`. Without this the harness
    // writes its sessions into the developer's real Jan data folder, and each
    // run inherits the previous run's attached folder from a temp directory
    // that has since been deleted.
    // The provider is reached at a single-label hostname on a fixed port, so
    // every scenario that talks to a model exercises the short-hostname path
    // that was resolving to the wrong machine.
    let lane_base = std::env::var("COWORK_SMOKE_REAL_BASE_URL").ok();
    if let Some(base) = &lane_base {
        let model = std::env::var("COWORK_SMOKE_REAL_MODEL").unwrap_or_else(|_| "pxa-27b".into());
        let _ = LANE.set((base.clone(), model));
        let bytes: [u8; 32] = rand::random();
        let _ = LANE_KEY.set(bytes.iter().map(|b| format!("{b:02x}")).collect());
        println!("real-provider lane: {base} (a fresh 32-byte key, never shown)");
    }
    let mock_port = if lane_base.is_some() {
        0
    } else {
        let (mock, mock_port) = match start_mock_provider(&fixtures, smoke_port()) {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("FATAL: {e}");
                std::process::exit(2);
            }
        };
        *MOCK.lock().unwrap_or_else(|e| e.into_inner()) = Some(mock);
        println!("mock provider on port {mock_port}");
        mock_port
    };

    // Deterministic resolution for the harness only: `llm-host` answers with a
    // public address and a loopback one, exactly the shape that sent requests
    // out of the network. Nothing else about the request path changes -- the
    // app still builds and sends through `core::net::transport`.
    struct SmokeDns;
    impl app_lib::core::net::resolver::DnsProbe for SmokeDns {
        fn lookup(&self, host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
            if host.eq_ignore_ascii_case(SMOKE_ENDPOINT_HOST) {
                return Ok(vec![
                    std::net::SocketAddr::new(SMOKE_PUBLIC_DECOY.parse().unwrap(), port),
                    std::net::SocketAddr::new("127.0.0.1".parse().unwrap(), port),
                ]);
            }
            app_lib::core::net::resolver::SystemDns.lookup(host, port)
        }
    }
    /// The lane resolves for real, and remembers every name it was asked for.
    struct RecordingDns;
    impl app_lib::core::net::resolver::DnsProbe for RecordingDns {
        fn lookup(&self, host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
            if let Ok(mut seen) = LOOKED_UP.lock() {
                seen.push(format!("{host}:{port}"));
            }
            app_lib::core::net::resolver::SystemDns.lookup(host, port)
        }
    }
    if lane_base.is_some() {
        app_lib::core::net::transport::set_probe(std::sync::Arc::new(RecordingDns));
    } else {
        app_lib::core::net::transport::set_probe(std::sync::Arc::new(SmokeDns));
    }

    let data_folder = workspace.join("data");
    let seeded = if resumed {
        println!("resuming the profile at {}", workspace.display());
        Ok(())
    } else if let (Some((base, _)), Some(key)) = (LANE.get(), LANE_KEY.get()) {
        seed_lane_settings(&data_folder, base, key)
    } else {
        seed_settings(
            &data_folder,
            &format!("http://{SMOKE_ENDPOINT_HOST}:{}/v1", smoke_port()),
        )
        .and_then(|()| seed_mcp_config(&data_folder))
    };
    if let Err(e) = seeded {
        eprintln!("FATAL: could not seed the smoke data folder: {e}");
        kill_mock();
        std::process::exit(2);
    }
    std::env::set_var("JAN_DATA_FOLDER", &data_folder);
    std::env::set_var("CI", "e2e");
    // A WebView profile of this run's own.
    //
    // `JAN_DATA_FOLDER` moves what the *app* writes; it does nothing about what
    // the *WebView* keeps. localStorage, sessionStorage, IndexedDB, the service
    // worker registration and the HTTP cache all live in the WebView2 user-data
    // folder, which is keyed by the bundle identifier and shared with the user's
    // own Jan. So a run inherited the previous run's Cowork session -- an
    // attached folder in a temp directory long since deleted -- and the harness
    // tried to paper over it by clearing storage and reloading, which is where
    // it hung waiting ninety seconds for a React root that never came back.
    //
    // Pointing WebView2 at a fresh directory makes that whole problem not exist:
    // storage starts empty because it is a new profile, no reload is needed, and
    // two runs cannot see each other's state even if one crashes half way.
    let webview_profile = workspace.join("webview");
    std::fs::create_dir_all(&webview_profile).expect("failed to create webview profile");
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_profile);
    // The harness window is often behind other windows on a desktop someone is
    // using. Chromium treats an occluded WebView as hidden: it throttles its
    // timers and backgrounds its renderer, and a page that waits on a timer
    // then stops answering the harness's scripts for minutes with the CPU
    // idle -- exactly the stall these runs kept hitting. A real user looks at
    // the window they are waiting on; the harness cannot, so it opts out.
    // `COWORK_SMOKE_THROTTLE=1` keeps the default, to reproduce the stall.
    if std::env::var_os("COWORK_SMOKE_THROTTLE").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
             --disable-background-timer-throttling --disable-renderer-backgrounding \
             --disable-backgrounding-occluded-windows",
        );
    }
    std::env::set_current_dir(&workspace).expect("failed to enter smoke workspace");
    // Provider keys go to the isolated data folder's encrypted file, not the
    // system credential store, which is shared with the developer's own Jan.
    app_lib::core::server::provider_secrets::use_file_secrets_only();

    let app = app_lib::build_app();
    let handle: AppHandle = app.handle().clone();

    let driver_workspace = workspace.clone();
    std::thread::spawn(move || {
        let code = drive(&handle, fixtures, driver_workspace.clone(), mock_port);
        if std::env::var_os("COWORK_SMOKE_KEEP").is_none() {
            let _ = std::fs::remove_dir_all(&driver_workspace);
        }
        // Never leave the fixture server behind.
        kill_mock();
        VERDICT.store(code, Ordering::SeqCst);
        // On macOS the platform event loop terminates the process itself with
        // status 0, so `handle.exit(code)` would discard the verdict. Run
        // Tauri's resource cleanup and then own the exit status here. Scenarios
        // that start background work are responsible for stopping it.
        handle.cleanup_before_exit();
        std::process::exit(code);
    });

    app_lib::run_app(app);
    // The app can also end on its own (its window closed, the event loop
    // gone); the fixture server this process started goes with it.
    kill_mock();
    std::process::exit(VERDICT.load(Ordering::SeqCst));
}

/// Always fails. Enabled by `--self-test-fail` so the harness can prove its own
/// non-zero exit path instead of assuming it.
fn scenario_self_test_fail(_ctx: &Ctx) -> ScenarioResult {
    bail!("deliberate failure injected by --self-test-fail")
}

const SELF_TEST_FAIL: Scenario = Scenario {
    name: "self-test-fail",
    run: scenario_self_test_fail,
};

fn drive(handle: &AppHandle, fixtures: PathBuf, workspace: PathBuf, mock_port: u16) -> i32 {
    let window = match wait_for_window(handle, Duration::from_secs(60)) {
        Some(w) => w,
        None => {
            eprintln!("FATAL: main window never appeared");
            return 2;
        }
    };
    // Layout assertions compare real geometry, so the window must be the same
    // size on every run rather than whatever the platform last remembered.
    // Except when the run is about exactly that memory: the window-chrome
    // scenarios judge the placement a restart restored, which this would
    // overwrite before they could look at it.
    let only_window_chrome = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--only")
        .is_some_and(|w| w[1].split(',').all(|n| n.trim().starts_with("window-chrome")));
    if !only_window_chrome {
        if let Err(e) = window.set_size(LogicalSize::new(1440.0, 900.0)) {
            eprintln!("WARN: could not fix the window size: {e}");
        }
    }
    std::thread::sleep(Duration::from_millis(800));

    let template = fixtures.is_dir().then(|| fixtures.clone());
    let existing = workspace.join("cowork-smoke-fixture");
    let materialized = if RESUMED.load(Ordering::SeqCst) && existing.is_dir() {
        Ok(existing)
    } else {
        materialize_project(&workspace, template.as_deref())
    };
    let project = match materialized {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FATAL: could not materialise the fixture project: {e}");
            return 2;
        }
    };
    println!("fixture project: {}", project.display());

    let ctx = Ctx {
        window,
        fixtures,
        workspace,
        project,
        mock_port,
    };

    let resumed = RESUMED.load(Ordering::SeqCst);
    let started = if resumed {
        // Inherited state is the point of a restart run; only wait for mount.
        ctx.wait_until(
            "React root to mount",
            "return !!document.querySelector('#root') && document.querySelector('#root').children.length > 0;",
            Duration::from_secs(90),
        )
    } else {
        ctx.reset_persisted_state()
    };
    if let Err(Failure(e)) = started {
        eprintln!("FATAL: could not reset persisted WebView state: {e}");
        return 2;
    }

    let self_test = std::env::args().any(|a| a == "--self-test-fail");
    // `--only a,b` runs just those scenarios. A scenario that wedges the
    // WebView fails every scenario after it, so the only honest way to judge
    // one is to run it by itself.
    let only: Option<Vec<String>> = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--only")
        .map(|w| w[1].split(',').map(|s| s.trim().to_string()).collect());
    let rooms = rooms_lane();
    let set = if rooms && resumed {
        ROOMS_RESTART_SCENARIOS
    } else if rooms {
        ROOMS_LANE_SCENARIOS
    } else if LANE.get().is_some() {
        LANE_SCENARIOS
    } else if resumed {
        RESTART_SCENARIOS
    } else {
        SCENARIOS
    };
    // The restart hand-off leaves a room running as the process exits, so it
    // runs last and only when the profile is kept for a second process.
    let keep_tail: &[Scenario] = if rooms && !resumed && std::env::var_os("COWORK_SMOKE_KEEP").is_some() {
        ROOMS_KEEP_SCENARIOS
    } else {
        &[]
    };
    let scenarios: Vec<&Scenario> = set
        .iter()
        .chain(keep_tail.iter())
        .chain(OPT_IN_SCENARIOS.iter())
        .chain(if self_test {
            std::slice::from_ref(&SELF_TEST_FAIL)
        } else {
            &[]
        })
        .filter(|s| match &only {
            Some(names) => names.iter().any(|n| n == s.name),
            None => !OPT_IN_SCENARIOS.iter().any(|o| o.name == s.name),
        })
        .collect();
    if let Some(names) = &only {
        for name in names {
            if !scenarios.iter().any(|s| s.name == name) && !(self_test && name == SELF_TEST_FAIL.name) {
                eprintln!("FATAL: no scenario named {name:?}");
                return 2;
            }
        }
    }

    let mut failed = 0usize;
    let mut wedged: Vec<&str> = Vec::new();
    for scenario in &scenarios {
        ctx.settle();
        if ctx.recover() {
            // Whatever ran before left the page unresponsive. Say so against
            // the scenario that inherits it, so a cascade is never read as a
            // string of unrelated defects.
            println!(
                "      (recovered a wedged WebView before {})",
                scenario.name
            );
            wedged.push(scenario.name);
        }
        // Up to three attempts. The WebView stalls for tens of seconds while
        // it highlights a large file or rescans the tree, and one stall
        // cascades into every scenario that follows until it recovers. A stall
        // is not a defect, but a pass that needed a retry is reported as such
        // so it never reads as a clean one.
        // A bound on one scenario, retries included. Each wait already has a
        // timeout, but a page that stops answering turns every eval into a
        // full-length one; past this the run says where it was and stops,
        // instead of looking hung.
        let limit = std::env::var("COWORK_SMOKE_SCENARIO_LIMIT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1200);
        let done = std::sync::Arc::new(AtomicBool::new(false));
        {
            let done = done.clone();
            let name = scenario.name;
            std::thread::spawn(move || {
                let started = Instant::now();
                while !done.load(Ordering::SeqCst) {
                    if started.elapsed() > Duration::from_secs(limit) {
                        let step = LAST_STEP.lock().map(|s| s.clone()).unwrap_or_default();
                        println!("FAIL {name}\n      no verdict after {limit}s; last step: {step}");
                        kill_mock();
                        std::process::exit(3);
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
        }
        let mut attempt = 0;
        let mut first_err: Option<String> = None;
        let outcome = loop {
            attempt += 1;
            match (scenario.run)(&ctx) {
                Ok(()) => break Ok(attempt > 1),
                Err(Failure(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e.clone());
                    }
                    // One attempt unless asked for more. A pass on a retry is
                    // evidence of a flake, not of a pass, and the stall that
                    // retries were added for is gone: it was the WebView being
                    // backgrounded behind other windows (see the browser
                    // arguments set in `main`). `COWORK_SMOKE_RETRIES=<n>`
                    // allows up to n more, reported as such.
                    let allowed = std::env::var("COWORK_SMOKE_RETRIES")
                        .ok()
                        .and_then(|v| v.parse::<u32>().ok())
                        .unwrap_or(0)
                        .min(2);
                    let last = attempt > allowed || scenario.name == SELF_TEST_FAIL.name;
                    if last {
                        break Err(Failure(match first_err {
                            Some(ref f) if f != &e => {
                                format!("{e}\n(first attempt failed with: {f})")
                            }
                            _ => e,
                        }));
                    }
                    // Let the WebView finish whatever wedged it. A page that
                    // stopped answering a script entirely does not recover by
                    // waiting: the retry would only time out the same way, so
                    // reload it first.
                    if e.contains("eval timed out") {
                        println!("      (reloading an unresponsive WebView before retrying)");
                        ctx.eval_detached("window.location.replace('/')").ok();
                    }
                    ctx.settle();
                }
            }
        };
        done.store(true, Ordering::SeqCst);
        match outcome {
            Ok(false) => println!("PASS {}", scenario.name),
            Ok(true) => {
                println!("PASS {} (on retry)", scenario.name);
                // What the first attempt hit, so a retry never hides a defect.
                if let Some(first) = &first_err {
                    println!("      first attempt failed with: {first}");
                }
            }
            Err(Failure(msg)) => {
                failed += 1;
                println!(
                    "FAIL {}\n      {}",
                    scenario.name,
                    msg.replace('\n', "\n      ")
                );
            }
        }
    }

    println!(
        "\n{} scenario(s) executed, {} passed, {} failed",
        scenarios.len(),
        scenarios.len() - failed,
        failed
    );
    if !wedged.is_empty() {
        // Named, so a failure inherited from a wedged page is never read as a
        // defect in the scenario that inherited it.
        println!(
            "{} scenario(s) started after a wedged WebView had to be reloaded: {}",
            wedged.len(),
            wedged.join(", ")
        );
    }
    i32::from(failed > 0)
}

fn wait_for_window(handle: &AppHandle, timeout: Duration) -> Option<WebviewWindow> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(w) = handle.get_webview_window("main") {
            return Some(w);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Where a scope's memories live on disk, for the assertions that have to look
/// past the DOM.
fn memory_records_path(scope_file: &str) -> Option<PathBuf> {
    std::env::var("JAN_DATA_FOLDER").ok().map(|d| {
        Path::new(&d)
            .join("agent-workspace")
            .join("memory")
            .join("records")
            .join(scope_file)
    })
}
