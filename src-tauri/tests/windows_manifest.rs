//! The binaries this crate produces must carry a ComCtl32 v6 manifest.
//!
//! With `tauri/common-controls-v6` enabled the crate imports
//! `TaskDialogIndirect` from `comctl32.dll`. That entry point exists only in
//! version 6, and a process reaches version 6 through an activation context
//! declared in its manifest. A binary built without one binds the version 5
//! `comctl32.dll` in System32, the loader fails to resolve the symbol, and the
//! process is killed with `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) before
//! `main` runs -- no output, no test results, no stack.
//!
//! `tauri_build` embeds the manifest for the application binary only, via
//! `cargo:rustc-link-arg-bins`. Test and example binaries got nothing, so every
//! configuration that enables `common-controls-v6` aborted at load while
//! `test-tauri` (which does not enable it) looked healthy. `build.rs` now links
//! the same `resource.lib` into tests and examples.
//!
//! This guard runs inside a test binary and asserts the property of *itself*:
//! if the manifest ever stops being linked, the very binary running this
//! assertion is the one that would fail to start, so a regression that removes
//! it either fails here or fails to launch at all. Both are loud.

#![cfg(windows)]

use std::path::Path;

/// Read this test binary's own embedded `RT_MANIFEST` resource (id 1).
///
/// Uses the resource APIs rather than shelling out to `mt.exe`, so the check
/// works on a machine with no Windows SDK installed.
fn embedded_manifest(path: &Path) -> Option<String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    // RT_MANIFEST is resource type 24; the manifest of an executable is id 1.
    const RT_MANIFEST: u16 = 24;
    const CREATEPROCESS_MANIFEST_RESOURCE_ID: u16 = 1;
    const LOAD_LIBRARY_AS_IMAGE_RESOURCE: u32 = 0x0000_0020;
    const LOAD_LIBRARY_AS_DATAFILE: u32 = 0x0000_0002;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
        fn FindResourceW(module: *mut c_void, name: *const u16, ty: *const u16) -> *mut c_void;
        fn LoadResource(module: *mut c_void, res: *mut c_void) -> *mut c_void;
        fn LockResource(data: *mut c_void) -> *mut c_void;
        fn SizeofResource(module: *mut c_void, res: *mut c_void) -> u32;
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // As an image resource, not as code: this must not run the binary's
        // entry point, only read its resource section.
        let module = LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_AS_IMAGE_RESOURCE | LOAD_LIBRARY_AS_DATAFILE,
        );
        if module.is_null() {
            return None;
        }
        // The low word of the pointer is the integer id when the high word is
        // zero, which is how the Win32 resource APIs spell MAKEINTRESOURCE.
        let found = FindResourceW(
            module,
            CREATEPROCESS_MANIFEST_RESOURCE_ID as usize as *const u16,
            RT_MANIFEST as usize as *const u16,
        );
        if found.is_null() {
            FreeLibrary(module);
            return None;
        }
        let size = SizeofResource(module, found) as usize;
        let handle = LoadResource(module, found);
        let ptr = LockResource(handle) as *const u8;
        if ptr.is_null() || size == 0 {
            FreeLibrary(module);
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        FreeLibrary(module);
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[test]
fn this_binary_declares_common_controls_v6() {
    let exe = std::env::current_exe().expect("current exe");

    let manifest = embedded_manifest(&exe).unwrap_or_else(|| {
        panic!(
            "{} has no embedded RT_MANIFEST resource.\n\
             Without one the loader binds ComCtl32 v5, cannot resolve \
             TaskDialogIndirect, and kills this process with \
             STATUS_ENTRYPOINT_NOT_FOUND before main. `build.rs` links \
             tauri's `resource.lib` into tests and examples to supply it.",
            exe.display()
        )
    });

    assert!(
        manifest.contains("Microsoft.Windows.Common-Controls"),
        "embedded manifest of {} does not depend on Common-Controls:\n{manifest}",
        exe.display()
    );
    assert!(
        manifest.contains("6.0.0.0"),
        "embedded manifest of {} does not request version 6:\n{manifest}",
        exe.display()
    );
}
