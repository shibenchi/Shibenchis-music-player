fn main() {
  // custom app commands aren't covered by any "core:*" permission —
  // Tauri's ACL blocks them by default unless they're declared here, which
  // is what actually generates the "allow-toggle-miniplayer" /
  // "allow-frontend-log" / "allow-apply-shortcut-prefs" permission
  // identifiers referenced in capabilities/default.json. Without this,
  // invoke() for any of them rejects with "not allowed by ACL" — every
  // single call, from any window, with no visible trace unless the
  // frontend specifically surfaces that rejection.
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&["toggle_miniplayer", "frontend_log", "apply_shortcut_prefs"]),
    ),
  )
  .expect("failed to run tauri-build");
}
