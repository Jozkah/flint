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

    // NOTE (Windows, unfinished): `cargo test --features cowork-smoke` aborts at
    // load with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139), having run no tests.
    //
    // Diagnosed, not fixed. `dumpbin /imports` on the test binary shows it
    // importing `TaskDialogIndirect`, `SetWindowSubclass`, `RemoveWindowSubclass`
    // and `DefSubclassProc` from `comctl32.dll`, and `dumpbin /headers` shows no
    // `.rsrc` section, so the binary carries no manifest. Those entry points
    // exist only in ComCtl32 version 6, which a process reaches through an
    // activation context declared in a manifest; without one the loader binds
    // the version 5 `comctl32.dll` in System32, cannot resolve
    // `TaskDialogIndirect`, and kills the process before `main`.
    //
    // The application binary is unaffected: `tauri_build` compiles the manifest
    // into `resource.lib` and links it via `cargo:rustc-link-arg-bins`. Only the
    // configurations enabling `tauri/common-controls-v6` are affected, which is
    // why `test-tauri` is healthy and the default-features one is not.
    //
    // Tried and rejected, so this is not repeated: `cargo:rustc-link-arg-tests`
    // with `/MANIFESTDEPENDENCY` (with and without `/MANIFEST:EMBED`), and with
    // `resource.lib` both as a plain input and under `/WHOLEARCHIVE`. The build
    // script does emit them -- they are visible in
    // `target/debug/build/Jan-*/output` -- and the test binary does relink, yet
    // it still has no `.rsrc`, so the flags are not reaching the linker in a
    // form that takes effect for test targets. Next thing to try: embed the
    // manifest into the test binary directly (an `.res` compiled from the
    // generated `resource.rc` passed as a link input, or `embed-resource`),
    // rather than relying on a link argument.

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
