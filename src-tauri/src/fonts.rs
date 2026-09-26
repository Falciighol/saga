//! Font families installed on this computer, offered in Settings alongside the bundled fonts.
//!
//! The webview can use any installed family by name (WKWebView, WebView2 and WebKitGTK all
//! resolve CSS `font-family` against the OS), so only the names are needed here.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
pub struct InstalledFont {
    pub family: String,
    /// Every face in the family is fixed-width.
    pub mono: bool,
}

/// Every installed family, sorted by name. Reads the OS font folders, per-user ones included
/// (`~/Library/Fonts` on macOS, `%LOCALAPPDATA%\Microsoft\Windows\Fonts` on Windows, fontconfig's
/// folders on Linux). Parsing every font file takes tens of milliseconds, so call it off the main thread.
pub fn installed_fonts() -> Vec<InstalledFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    // Keyed by lowercase name so families sort and dedupe without regard to case.
    let mut families: BTreeMap<String, InstalledFont> = BTreeMap::new();
    for face in db.faces() {
        // The first name is the English one when the font has it; it's what CSS matches.
        let Some((name, _)) = face.families.first() else { continue };
        let name = name.trim();
        // Dot-prefixed families (".SF NS") are macOS internals that web content can't name.
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        families
            .entry(name.to_lowercase())
            .and_modify(|f| f.mono &= face.monospaced)
            .or_insert_with(|| InstalledFont { family: name.to_string(), mono: face.monospaced });
    }
    families.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_sorted_unique_families() {
        let fonts = installed_fonts();
        let names: Vec<String> = fonts.iter().map(|f| f.family.to_lowercase()).collect();
        assert!(names.windows(2).all(|w| w[0] < w[1]), "sorted and deduplicated");
        assert!(fonts.iter().all(|f| !f.family.starts_with('.')));
        #[cfg(target_os = "macos")]
        {
            let find = |n: &str| fonts.iter().find(|f| f.family == n);
            assert!(find("Menlo").is_some_and(|f| f.mono));
            assert!(find("Helvetica").is_some_and(|f| !f.mono));
        }
        #[cfg(target_os = "windows")]
        {
            assert!(fonts.iter().any(|f| f.family == "Consolas" && f.mono));
            assert!(fonts.iter().any(|f| f.family == "Segoe UI" && !f.mono));
        }
    }
}

