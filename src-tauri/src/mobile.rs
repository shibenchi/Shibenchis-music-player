// android (and ios) shell. there is no node here, no tray icon and no mini
// player window: the interface is bundled into the app and talks to the social
// server over the network. audio comes from an on-device helper that is added
// separately.
//
// the interface calls a few commands that only mean something on a desktop. they
// exist here as no-ops so those calls do not error on a phone.

#[tauri::command]
fn frontend_log(source: String, message: String) {
    log::info!("[js:{source}] {message}");
}

// no mini player on a phone
#[tauri::command]
fn toggle_miniplayer() {}

// desktop shortcuts and taskbar pins are a windows idea
#[tauri::command]
fn apply_shortcut_prefs(_desktop: bool, _taskbar: bool) {}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![frontend_log, toggle_miniplayer, apply_shortcut_prefs])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
