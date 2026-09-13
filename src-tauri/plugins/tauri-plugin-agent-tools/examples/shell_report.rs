//! What every shell on this host does when started in the sandbox.
//!
//! The production selection path, printed: each candidate `select_shell` would
//! consider, its origin, how long its probe took and what it said. Run it when
//! a host withholds `bash`, to see which shell failed and why rather than
//! "no shell could be started".
//!
//! ```text
//! cargo run -p tauri-plugin-agent-tools --no-default-features --example shell_report
//! ```

use tauri_plugin_agent_tools::tools::jail;

fn main() {
    // The AppContainer backend re-executes this binary as its helper.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    let root = std::env::temp_dir().join(format!("jan-shell-report-{}", std::process::id()));
    let workspace = root.join("workspace");
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&workspace).expect("workspace");
    std::fs::create_dir_all(&scratch).expect("scratch");
    let policy = jail::Policy::new(&workspace, false).with_scratch_root(&scratch);

    let started = std::time::Instant::now();
    for report in jail::shell_reports(&policy) {
        println!(
            "{:<60} {:<12} {:<10} {:?}",
            report.cfg.program.display(),
            report.cfg.description,
            report.origin.as_str(),
            report.outcome
        );
    }
    println!("probed in {:?}", started.elapsed());
    match jail::select_shell(&policy) {
        Ok(selected) => println!("selected: {}", selected.report.cfg.program.display()),
        Err(e) => println!("selected: none\n{e}"),
    }
    let _ = std::fs::remove_dir_all(&root);
}
