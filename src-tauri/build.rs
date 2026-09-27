fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        // tauri-build puts the Common Controls v6 manifest in a resource that only the app binary
        // links, so `cargo test --lib` (whose exe links the webview stack too) dies at startup with
        // STATUS_ENTRYPOINT_NOT_FOUND. Let the linker embed the same manifest into everything
        // instead, like Tauri does for its own tests. /MANIFESTUAC:NO keeps it identical to
        // tauri-build's, and a dependency (not /MANIFESTINPUT) doesn't need mt.exe under lld-link.
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' \
             version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
