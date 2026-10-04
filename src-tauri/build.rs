fn main() {
    // Cargo re-runs a build script on any change *until* the script emits a
    // `rerun-if-changed` of its own, at which point that list becomes the whole
    // rule and `build.rs` is not on it unless it says so. `tauri_build::build()`
    // emits several, so without this line edits to this file are silently
    // ignored and the previous run's output keeps being replayed.
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(feature = "tauri-app")]
    {
        // The app's command allowlist is built here from the permission files
        // each local plugin generates. Tauri tracks those through an
        // environment path that does not change when the files do, so a
        // command added to a plugin stayed "not allowed. Command not found" in
        // the app until something else made this script run -- a smoke run
        // that way had memory retrieval and the tool readiness check denied.
        // Watch the files themselves, but not `schemas/`, which every plugin
        // build rewrites.
        if let Ok(plugins) = std::fs::read_dir("plugins") {
            for plugin in plugins.flatten() {
                let Ok(entries) = std::fs::read_dir(plugin.path().join("permissions")) else {
                    continue;
                };
                for entry in entries.flatten() {
                    if entry.file_name() != "schemas" {
                        println!("cargo:rerun-if-changed={}", entry.path().display());
                    }
                }
            }
        }
        tauri_build::build();
    }

    // Windows gives a program's main thread a 1 MB stack unless the linker asks
    // for more (Linux and macOS give the main thread 8 MB). Tauri runs its
    // command dispatch and window-event handling on that thread, and in the
    // size-optimised release build (thin LTO, one inlined dispatcher) the
    // frames of that path no longer fit: the app died with `thread 'main' has
    // overflowed its stack` as soon as a model's tool call arrived, on every
    // machine running the release installer, while debug builds (which do not
    // inline the same way) never showed it. Reserving 8 MB costs address space
    // only. The release workflow checks the built exe for it
    // (scripts/check-main-thread-stack.mjs).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    }

    // Give test and example binaries the manifest `tauri_build` embeds only in
    // the application binary.
    //
    // With `tauri/common-controls-v6` on, this crate imports `TaskDialogIndirect`
    // from `comctl32.dll`. That entry point exists only in ComCtl32 version 6,
    // which a process reaches through an activation context declared in its
    // manifest. A binary with no manifest gets the version 5 `comctl32.dll` in
    // System32, the loader cannot resolve the symbol, and the process dies with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before `main` -- so
    // `cargo test --features cowork-smoke` and the smoke harness both aborted
    // having run nothing. Confirmed by embedding the manifest into a copy of the
    // built executable with `mt.exe`: the copy starts and reaches its own
    // argument handling.
    //
    // `tauri_build` compiles the application manifest into `resource.lib` and
    // links it with `cargo:rustc-link-arg-bins`. Linking the same object into
    // tests and examples gives them the identical activation context -- and the
    // identical icons and version metadata -- rather than a second, divergent
    // manifest maintained by hand.
    //
    // The plain `cargo:rustc-link-arg` form cannot be used here: it covers every
    // linked artifact, the application binary included, so that binary received
    // `resource.lib` twice -- once from `tauri_build` and once from this script
    // -- and the resource compiler rejected the second copy:
    //
    //   CVTRES : fatal error CVT1100: duplicate resource. type:VERSION, name:1
    //   LINK : fatal error LNK1123: failure during conversion to COFF
    //
    // The target-scoped forms exclude bins, which already have the resource.
    //
    // Known limitation: `-tests` covers the integration-test binaries and the
    // examples cover the smoke harness, but neither covers the unit-test
    // harness cargo builds from the library itself. So
    // `cargo test --lib --features cowork-smoke` still aborts at load, while
    // `--features test-tauri` (which does not enable `common-controls-v6`)
    // runs those same unit tests fine. Cargo offers no selector for that
    // target, and the plain form that would reach it is the one that breaks
    // the application binary above.
    #[cfg(all(windows, target_env = "msvc", feature = "tauri-app"))]
    {
        let resource =
            std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("resource.lib");
        if resource.exists() {
            // No `benches`: cargo rejects `rustc-link-arg-benches` outright
            // ("does not have a benchmark target") when the package declares
            // none, and this one does not.
            for target in ["tests", "examples"] {
                println!("cargo:rustc-link-arg-{target}={}", resource.display());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        if let Ok(output) = std::process::Command::new("xcrun")
            .args(["--toolchain", "default", "--find", "swift"])
            .output()
        {
            let swift_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(toolchain) = std::path::Path::new(&swift_path)
                .parent()
                .and_then(|p| p.parent())
            {
                let lib_path = toolchain.join("lib/swift/macosx");
                if lib_path.exists() {
                    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_path.display());
                }
            }
        }
    }
}
