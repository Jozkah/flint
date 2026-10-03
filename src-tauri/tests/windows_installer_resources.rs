//! Guards the one file that silently drops bundled resources.
//!
//! `template-tauri-build-windows-x64.yml` patches
//! `bundle.windows.nsis.template` into the config at build time, so the NSIS
//! bundler stops deriving its resource list from `bundle.resources` and uses the
//! committed template's hand-written block instead. The MSI still honours the
//! config, so a resource missing from the template ships in the MSI and not in
//! the setup exe -- which is the primary release asset *and* the auto-updater
//! payload, making it the more damaging half.
//!
//! This has already happened twice: #7618 hand-added `jan-cli.exe`, and the
//! engine worker plus its ggml modules fell through the same gap. Nothing in the
//! build fails when it happens, which is why it needs a test rather than a
//! comment.

use std::path::PathBuf;

fn repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()))
}

#[test]
fn every_bundled_windows_resource_is_installed_by_the_nsis_template() {
    let conf: serde_json::Value = serde_json::from_str(&repo_file("tauri.windows.conf.json"))
        .expect("tauri.windows.conf.json is not valid JSON");
    let resources = conf["bundle"]["resources"]
        .as_array()
        .expect("bundle.resources must be an array");
    assert!(
        !resources.is_empty(),
        "bundle.resources is empty; this test would then assert nothing"
    );

    let template = repo_file("tauri.bundle.windows.nsis.template");

    let missing: Vec<&str> = resources
        .iter()
        .filter_map(|r| r.as_str())
        // The basename is what the template writes, and it carries the glob
        // verbatim (`ggml*.dll`), so comparing basenames covers both the literal
        // and the wildcard entries without reimplementing glob matching.
        .filter(|rel| {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            !template.contains(name)
        })
        .collect();

    assert!(
        missing.is_empty(),
        "these bundle.resources entries are declared in tauri.windows.conf.json \
         but never installed by tauri.bundle.windows.nsis.template, so they ship \
         in the MSI and are silently absent from the NSIS setup exe: {missing:?}\n\
         Add a `File` line for each to the template's `; Copy resources` block."
    );
}

/// Returns the body of `!macro <name> ...` up to its `!macroend`.
fn macro_body<'a>(template: &'a str, name: &str) -> &'a str {
    let start = template
        .find(&format!("!macro {name}"))
        .unwrap_or_else(|| panic!("macro {name} not found in the NSIS template"));
    let rest = &template[start..];
    let end = rest.find("!macroend").expect("unterminated macro");
    &rest[..end]
}

/// #289: a binary renamed to `<name>.old` because it was locked during one
/// update must be removed by the next, unlocked update. The old macro only
/// deleted `.old` after the primary `Delete` had already failed, so a normal
/// update never reached it and the (often hundreds of MB) copy leaked forever.
#[test]
fn stale_old_copies_are_removed_even_when_the_primary_delete_succeeds() {
    let template = repo_file("tauri.bundle.windows.nsis.template");

    let unlock = macro_body(&template, "UnlockBundledBinary");
    let old_delete = unlock
        .find("Delete \"${path}.old\"")
        .expect("UnlockBundledBinary must delete ${path}.old");
    let retry_loop = unlock.find("${Do}").expect("UnlockBundledBinary retry loop");
    assert!(
        old_delete < retry_loop,
        "UnlockBundledBinary must delete ${{path}}.old before its retry loop; \
         inside the loop it only runs when the primary Delete fails"
    );

    let free = macro_body(&template, "FreeBundledFiles");
    for sweep in [
        "Delete \"$INSTDIR\\resources\\bin\\*.old\"",
        "Delete \"$INSTDIR\\*.old\"",
    ] {
        assert!(
            free.contains(sweep),
            "FreeBundledFiles must sweep stray .old files on every install: {sweep}"
        );
    }
}

/// The body of the NSIS section `name`, up to its `SectionEnd`.
fn section_body<'a>(template: &'a str, name: &str) -> &'a str {
    let start = template
        .find(&format!("Section {name}\n"))
        .or_else(|| template.find(&format!("Section {name}\r\n")))
        .unwrap_or_else(|| panic!("Section {name} not found in the NSIS template"));
    let rest = &template[start..];
    &rest[..rest.find("SectionEnd").expect("unterminated section")]
}

/// #293: the install directory can be one Jan does not own (`/D=`, or a path
/// restored from the registry), and every upgrade runs the old uninstaller
/// against it. Uninstall must remove what the installer wrote and then the
/// directory only if that left it empty -- never the whole tree.
#[test]
fn uninstall_never_deletes_the_install_directory_recursively() {
    let template = repo_file("tauri.bundle.windows.nsis.template");
    let uninstall = section_body(&template, "Uninstall");
    for line in uninstall.lines().map(str::trim) {
        let recursive = line.starts_with("RMDir") && line.split_whitespace().any(|w| w == "/r");
        assert!(
            !(recursive && line.ends_with("\"$INSTDIR\"")),
            "Section Uninstall deletes $INSTDIR recursively: {line}"
        );
    }
    assert!(
        uninstall.lines().any(|l| l.trim() == "RMDir /REBOOTOK \"$INSTDIR\""),
        "Section Uninstall must still remove $INSTDIR once it is empty"
    );
    // Everything the installer writes at the top level is removed by name, or
    // the non-recursive RMDir leaves Jan's own files behind.
    for file in [
        "${MAINBINARYNAME}.exe",
        "LICENSE",
        "bun.exe",
        "uv.exe",
        "uninstall.exe",
    ] {
        assert!(
            uninstall.contains(&format!("Delete \"$INSTDIR\\{file}\"")),
            "Section Uninstall does not delete $INSTDIR\\{file}"
        );
    }
}

/// The publisher rename moved the registry key that remembers the install
/// location, so upgrades landed in a new directory and left the old copy
/// (and the taskbar pin to it) behind. Both templates must retire that copy,
/// and must not take its directory out recursively (#293).
#[test]
fn the_install_left_behind_by_the_publisher_rename_is_retired() {
    for name in [
        "tauri.bundle.windows.nsis.template",
        "tauri.bundle.windows.nsis.base.template",
    ] {
        let template = repo_file(name);
        let body = macro_body(&template, "RetireLegacyInstall");
        assert!(
            section_body(&template, "Install").contains("!insertmacro RetireLegacyInstall"),
            "{name}: Section Install never retires the legacy install"
        );
        assert!(
            body.contains("${AndIf} $4 != $INSTDIR"),
            "{name}: the legacy cleanup must skip the directory being installed to"
        );
        assert!(
            body.contains("SetShortcutTarget \"${TASKBARPIN}\""),
            "{name}: the taskbar pin to the old copy is not repointed"
        );
        for line in body.lines().map(str::trim) {
            let recursive = line.starts_with("RMDir") && line.split_whitespace().any(|w| w == "/r");
            assert!(
                !(recursive && line.ends_with("\"$4\"")),
                "{name}: the legacy directory is deleted recursively: {line}"
            );
        }
    }
}
