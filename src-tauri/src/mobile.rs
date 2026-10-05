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

// the screens of the app. they are packed into the app, and a newer set that was downloaded and
// checked (see UiUpdater.kt) lives in the app's own folder, files/ui-update/<folder>, named by
// meta.json. when there is such a set it is served instead, file by file, and anything it does
// not have comes from the app itself, so a missing file can never break the page
use std::borrow::Cow;
use std::path::PathBuf;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

// the folder of the downloaded screens in use, if there is one
fn downloaded_screens() -> Option<PathBuf> {
    // the app's folder is named after the app, which is also the name of its process
    let cmdline = std::fs::read("/proc/self/cmdline").ok()?;
    let name = String::from_utf8_lossy(&cmdline).split('\0').next()?.trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return None;
    }
    let base = PathBuf::from(format!("/data/data/{name}/files/ui-update"));
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(base.join("meta.json")).ok()?).ok()?;
    let folder = meta.get("folder")?.as_str()?;
    if folder.is_empty() || folder.contains('/') || folder.contains('\\') || folder.contains("..") {
        return None;
    }
    let dir = base.join(folder);
    if dir.join("index.html").is_file() {
        Some(dir)
    } else {
        None
    }
}

fn downloaded_file(key: &str) -> Option<Vec<u8>> {
    let relative = key.trim_start_matches('/');
    if relative.is_empty() || relative.contains("..") || relative.contains('\\') || relative.contains(':') {
        return None;
    }
    std::fs::read(downloaded_screens()?.join(relative)).ok()
}

struct Nothing;

impl<R: Runtime> Assets<R> for Nothing {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

struct DownloadedFirst<R: Runtime> {
    built_in: Box<dyn Assets<R>>,
}

impl<R: Runtime> Assets<R> for DownloadedFirst<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.built_in.setup(app);
    }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(bytes) = downloaded_file(key.as_ref()) {
            return Some(Cow::Owned(bytes));
        }
        self.built_in.get(key)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.built_in.iter()
    }
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.built_in.csp_hashes(html_path)
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    let built_in = std::mem::replace(&mut context.assets, Box::new(Nothing));
    context.assets = Box::new(DownloadedFirst { built_in });

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![frontend_log, toggle_miniplayer, apply_shortcut_prefs])
        .run(context)
        .expect("error while running the app");
}
