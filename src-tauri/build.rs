fn main() {
    #[cfg(feature = "tauri-app")]
    {
        tauri_build::build();
    }

    // Give test and example binaries the ComCtl32 v6 activation context that
    // `tauri_build` embeds only in the application binary.
    //
    // With `tauri/common-controls-v6` on, the crate imports `TaskDialogIndirect`
    // (and the window-subclass entry points) from `comctl32.dll`. Those exist
    // only in version 6, which a process gets by declaring a dependency on it;
    // without the declaration the loader binds the v5 `comctl32.dll` in
    // System32, finds no `TaskDialogIndirect`, and kills the process with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before `main` runs.
    //
    // The application binary was fine because `tauri_build` embeds a manifest
    // for it. Test binaries get no manifest, so `cargo test --features
    // cowork-smoke` aborted at load, having run no tests -- and it aborted only
    // in the configurations that pull in `common-controls-v6`, which is why the
    // `test-tauri` feature set looked healthy.
    #[cfg(all(windows, target_env = "msvc", feature = "tauri-app"))]
    {
        const COMMON_CONTROLS_V6: &str = "/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'";
        println!("cargo:rustc-link-arg-tests={COMMON_CONTROLS_V6}");
        println!("cargo:rustc-link-arg-examples={COMMON_CONTROLS_V6}");
        println!("cargo:rustc-link-arg-benches={COMMON_CONTROLS_V6}");
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
