fn main() {
    // Cargo re-runs a build script on any change *until* the script emits a
    // `rerun-if-changed` of its own, at which point that list becomes the whole
    // rule and `build.rs` is not on it unless it says so. `tauri_build::build()`
    // emits several, so without this line edits to this file are silently
    // ignored and the previous run's output keeps being replayed.
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(feature = "tauri-app")]
    {
        tauri_build::build();
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
    // `-examples` and `-tests` are not enough on their own: `-tests` covers the
    // integration-test binaries but not the unit-test harness built from the
    // library itself, which is the one `cargo test --lib` runs and the one that
    // was dying. `cargo:rustc-link-arg` covers every linked artifact, which is
    // what this needs.
    #[cfg(all(windows, target_env = "msvc", feature = "tauri-app"))]
    {
        let resource =
            std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("resource.lib");
        if resource.exists() {
            println!("cargo:rustc-link-arg={}", resource.display());
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
