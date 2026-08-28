use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MINIPLAYER_LABEL: &str = "miniplayer";
const MINI_WIDTH: f64 = 300.0;
const MINI_HEIGHT: f64 = 118.0;
const MINI_MARGIN: f64 = 20.0;
const APP_URL: &str = "http://localhost:3001";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// fallback for when this isnt running from an installed bundle (just
// `cargo build`/`cargo tauri dev` straight out of the repo, resources never
// got copied anywhere) — a real install never touches this path. derived
// from CARGO_MANIFEST_DIR (always src-tauri/, set by cargo at compile time)
// instead of a hardcoded absolute path so this actually works regardless of
// which machine or OS the repo happens to be cloned onto
fn dev_project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

// node.exe on windows, plain "node" everywhere else — same binary, just
// windows insists on the extension
#[cfg(windows)]
const NODE_BIN_NAME: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN_NAME: &str = "node";

struct BackendProcesses(Mutex<Vec<Child>>);

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

// desktop shortcuts / taskbar pins are a windows-only concept — mac
// installs by dragging the .app out of the dmg into /Applications and pins
// to the Dock by dragging it there yourself, theres no equivalent file this
// app could drop on your behalf. so the whole shortcut-prefs system below
// only exists on windows; apply_shortcut_prefs just no-ops everywhere else
#[cfg(windows)]
mod shortcuts {
    use super::log_line;
    use std::path::Path;

// windows killed the actual "pin to taskbar" api for normal processes
// years ago, BUT a .lnk dropped straight into the old Quick
// Launch\User Pinned\TaskBar folder still counts as a real pin. tried
// doing this from the installer (wix) first and that was a nightmare —
// declaring that whole per-user folder chain trips ICE64, which wants a
// wildcard cleanup on every ancestor folder on uninstall, which wouldve
// nuked OTHER apps pins sitting in that same shared folder. no thanks.
// doing it here at first launch instead, uses the real final exe path and
// never touches folders it doesnt own
pub fn ensure_taskbar_pin() {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let taskbar_folder = Path::new(&appdata)
        .join("Microsoft")
        .join("Internet Explorer")
        .join("Quick Launch")
        .join("User Pinned")
        .join("TaskBar");
    let link_path = taskbar_folder.join("Shibenchi's Music Player.lnk");
    if link_path.exists() {
        return;
    }
    let Ok(exe_path) = std::env::current_exe() else {
        log_line("ensure_taskbar_pin: could not resolve current_exe, skipping");
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&taskbar_folder) {
        log_line(&format!("ensure_taskbar_pin: create_dir_all FAILED: {e}"));
        return;
    }
    match mslnk::ShellLink::new(&exe_path) {
        Ok(link) => match link.create_lnk(&link_path) {
            Ok(_) => log_line(&format!("ensure_taskbar_pin: created {}", link_path.display())),
            Err(e) => log_line(&format!("ensure_taskbar_pin: create() FAILED: {e}")),
        },
        Err(e) => log_line(&format!("ensure_taskbar_pin: ShellLink::new FAILED: {e}")),
    }
}

// installer's desktop shortcut is unconditional (tauri gives no config to
// make it optional, and the .wxs it comes from regenerates every build so
// hand-editing it is off the table). deleting the .lnk it already dropped
// is basically the same as "dont create it" when you opt out at first
// run — windows installer just no-ops uninstalling a file thats already
// gone, same as if you'd deleted it yourself, totally normal. DesktopFolder
// resolves to either the shared public desktop (allusers install) or your
// own, depending — just try both instead of guessing which this install used
pub fn remove_desktop_shortcut() {
    let name = "Shibenchi's Music Player.lnk";
    let mut candidates = Vec::new();
    if let Ok(public) = std::env::var("PUBLIC") {
        candidates.push(Path::new(&public).join("Desktop").join(name));
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        candidates.push(Path::new(&userprofile).join("Desktop").join(name));
    }
    for path in candidates {
        if path.exists() {
            match std::fs::remove_file(&path) {
                Ok(_) => log_line(&format!("remove_desktop_shortcut: removed {}", path.display())),
                Err(e) => log_line(&format!("remove_desktop_shortcut: remove_file FAILED for {}: {e}", path.display())),
            }
        }
    }
}
} // mod shortcuts

#[cfg(windows)]
#[tauri::command]
fn apply_shortcut_prefs(desktop: bool, taskbar: bool) {
    log_line(&format!("apply_shortcut_prefs: desktop={desktop} taskbar={taskbar}"));
    if taskbar {
        shortcuts::ensure_taskbar_pin();
    }
    if !desktop {
        shortcuts::remove_desktop_shortcut();
    }
}

// no desktop/taskbar shortcut concept to apply on mac (or linux) — the
// frontend still calls this after the first-run popup regardless of
// platform, so it just needs to exist and do nothing instead of failing
// to compile
#[cfg(not(windows))]
#[tauri::command]
fn apply_shortcut_prefs(desktop: bool, taskbar: bool) {
    log_line(&format!(
        "apply_shortcut_prefs: no-op on this platform (desktop={desktop} taskbar={taskbar})"
    ));
}

// resolved once at startup, reused everywhere, see resolve_paths() below
struct AppPaths {
    /// where the actual per-user data lives (db, downloads, cache, logs).
    /// %APPDATA%\<identifier> on windows, ~/Library/Application
    /// Support/<identifier> on mac — writable no matter where the app
    /// itself got installed (Program Files / /Applications definitely isnt)
    data_dir: PathBuf,
    /// folder with server/index.js (and node_modules) to actually run
    server_dir: PathBuf,
    /// node(.exe) binary to run it with
    node_exe: PathBuf,
}

fn resolve_paths(app: &tauri::AppHandle) -> AppPaths {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| dev_project_root());

    // installed layout: resources/{server, node_modules, node(.exe)} sitting
    // next to the exe, set up via tauri.conf.json's bundle.resources
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_server = resource_dir.join("server").join("index.js");
        if bundled_server.exists() {
            return AppPaths {
                data_dir,
                server_dir: resource_dir.join("server"),
                node_exe: resource_dir.join(NODE_BIN_NAME),
            };
        }
    }

    // dev fallback — not bundled, resources never got copied, just run
    // straight against the project folder w/ whatever `node` is on PATH,
    // same as before bundling was even a thing
    log_line("resolve_paths: no bundled server found, falling back to dev project layout");
    let dev_root = dev_project_root();
    AppPaths {
        data_dir,
        server_dir: dev_root.join("server"),
        node_exe: PathBuf::from("node"),
    }
}

// one-time move of whatever was sitting in the old project-relative
// data/downloads/temp_audio folders (from before this had a real installed
// data location) into the proper per-user app_data_dir, so switching to an
// actual installer doesnt just quietly orphan someone's whole library.
// no-ops once data_dir already has its own data
fn migrate_dev_data_if_needed(data_dir: &Path) {
    if data_dir.join("data").join("music.db").exists() {
        return; // already migrated, or already a fresh appdata install
    }
    let dev_root = dev_project_root();
    if !dev_root.join("data").join("music.db").exists() {
        return; // nothing to move
    }
    log_line(&format!("migrate_dev_data_if_needed: copying old data from {} to {}", dev_root.display(), data_dir.display()));
    for folder in ["data", "downloads", "temp_audio", "logs"] {
        let src = dev_root.join(folder);
        if !src.exists() {
            continue;
        }
        let dst = data_dir.join(folder);
        if let Err(e) = copy_dir_recursive(&src, &dst) {
            log_line(&format!("migrate_dev_data_if_needed: failed copying {folder}: {e}"));
        }
    }
    log_line("migrate_dev_data_if_needed: done");
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), dst_path)?;
        }
    }
    Ok(())
}

// always-on logging, not hidden behind debug_assertions or some log crate
// backend whose output location i cant even confirm — just writes straight
// to a plain text file in the per-user data dir so rust AND (via
// frontend_log / the server's own writes) js both land in the same place,
// one timeline i can actually read. resolved independently of AppPaths
// since the very first log lines happen before an AppHandle even exists yet.
// no tauri path resolver available this early either, so this has to fall
// back to raw env vars per-platform instead of app.path().app_data_dir()
#[cfg(windows)]
fn log_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(|appdata| Path::new(&appdata).join("com.shibenchi.musicplayer"))
        .unwrap_or_else(|_| dev_project_root())
}

#[cfg(target_os = "macos")]
fn log_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|home| {
            Path::new(&home)
                .join("Library")
                .join("Application Support")
                .join("com.shibenchi.musicplayer")
        })
        .unwrap_or_else(|_| dev_project_root())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn log_dir() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|home| Path::new(&home).join(".local").join("share")))
        .map(|base| base.join("com.shibenchi.musicplayer"))
        .unwrap_or_else(|_| dev_project_root())
}

fn log_line(msg: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("rust_debug.log"))
    {
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

// lets the frontend (main window AND miniplayer) write into the exact same
// log file as the rust side, so one trace shows what BOTH sides saw for a
// given action instead of me trying to line up two separate logs by hand
// like some kind of caveman
#[tauri::command]
fn frontend_log(source: String, message: String) {
    log_line(&format!("[js:{source}] {message}"));
}

// spawns the same server/index.js that old start.bat did: once as the main
// server (auth/db/social + serves the built frontend on 3001) and once as
// the local helper (yt-dlp/ffmpeg on 3002) — basically mirrors the two npm
// scripts start.bat used to fire off in separate terminal windows
fn spawn_node(paths: &AppPaths, is_helper: bool) -> std::io::Result<Child> {
    let mut cmd = Command::new(&paths.node_exe);
    cmd.arg("index.js")
        .current_dir(&paths.server_dir)
        .env("APP_DATA_DIR", &paths.data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if is_helper {
        cmd.env("LOCAL_HELPER", "1").env("LOCAL_HELPER_PORT", "3002");
    } else {
        cmd.env("PORT", "3001").env("NODE_ENV", "production");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

fn kill_backend(app: &tauri::AppHandle) {
    let state = app.state::<BackendProcesses>();
    let mut children = state.0.lock().unwrap();
    log_line(&format!("kill_backend: killing {} child process(es)", children.len()));
    for mut child in children.drain(..) {
        let _ = child.kill();
    }
}

// points at the SAME running server as the main window (not tauri's own
// bundled asset protocol) so it gets the exact same index.css — vinyl
// record styling, theme vars, all of it — for free, instead of me having
// to reimplement it against some separate stale bundle snapshot
fn create_or_show_miniplayer(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MINIPLAYER_LABEL) {
        log_line("create_or_show_miniplayer: window already exists, showing it");
        match window.show() {
            Ok(_) => log_line("create_or_show_miniplayer: show() ok"),
            Err(e) => log_line(&format!("create_or_show_miniplayer: show() FAILED: {e}")),
        }
        match window.set_focus() {
            Ok(_) => {}
            Err(e) => log_line(&format!("create_or_show_miniplayer: set_focus() FAILED: {e}")),
        }
        return;
    }

    let mini_url = format!("{APP_URL}/?view=miniplayer");
    log_line(&format!("create_or_show_miniplayer: no existing window, building new one at {mini_url}"));
    let built = WebviewWindowBuilder::new(
        app,
        MINIPLAYER_LABEL,
        WebviewUrl::External(mini_url.parse().unwrap()),
    )
    .title("miniplayer")
    .inner_size(MINI_WIDTH, MINI_HEIGHT)
    .min_inner_size(220.0, 90.0)
    .resizable(true)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .build();

    match built {
        Ok(window) => {
            log_line("create_or_show_miniplayer: window built OK");
            // bottom right corner of whatever monitor it opens on, like a
            // normal picture-in-picture widget wouldve
            match window.primary_monitor() {
                Ok(Some(monitor)) => {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let x = (logical_w - MINI_WIDTH - MINI_MARGIN).max(0.0);
                    let y = (logical_h - MINI_HEIGHT - MINI_MARGIN).max(0.0);
                    log_line(&format!("create_or_show_miniplayer: positioning at ({x}, {y}) on monitor {logical_w}x{logical_h} scale={scale}"));
                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                }
                Ok(None) => log_line("create_or_show_miniplayer: primary_monitor() returned None, leaving default position"),
                Err(e) => log_line(&format!("create_or_show_miniplayer: primary_monitor() FAILED: {e}")),
            }
            let window_for_events = window.clone();
            // dragging from an EDGE (vs a corner) stretches width or
            // height on their own, which is exactly what distorts the
            // content once its scaled to match the window. couldnt find
            // any real way to selectively kill just the edge handles
            // through tauri/webview2, so instead this just snaps any
            // resize back onto the locked aspect ratio right after —
            // net effect, only a proportional corner-style resize
            // actually sticks. good enough
            let last_corrected_size = Arc::new(Mutex::new(None::<(u32, u32)>));
            window.on_window_event(move |event| {
                log_line(&format!("miniplayer window event: {event:?}"));
                match event {
                    WindowEvent::Moved(pos) => {
                        log_line(&format!("miniplayer window MOVED to {pos:?} (drag is reaching the OS)"));
                    }
                    WindowEvent::Resized(size) => {
                        {
                            let mut last = last_corrected_size.lock().unwrap();
                            if let Some((w, h)) = *last {
                                if size.width == w && size.height == h {
                                    // this is just the echo of our OWN
                                    // correction below, not a fresh resize
                                    // to actually re-check
                                    *last = None;
                                    return;
                                }
                            }
                        }
                        let target_ratio = MINI_WIDTH / MINI_HEIGHT;
                        let w = size.width as f64;
                        let h = size.height as f64;
                        if w < 10.0 || h < 10.0 {
                            return;
                        }
                        if (w / h - target_ratio).abs() > 0.01 {
                            let corrected_height = (w / target_ratio).round() as u32;
                            let corrected = tauri::PhysicalSize::new(size.width, corrected_height);
                            *last_corrected_size.lock().unwrap() = Some((corrected.width, corrected.height));
                            let _ = window_for_events.set_size(corrected);
                        }
                    }
                    _ => {}
                }
            });
        }
        Err(e) => log_line(&format!("create_or_show_miniplayer: build() FAILED: {e}")),
    }
}

fn hide_miniplayer(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MINIPLAYER_LABEL) {
        log_line("hide_miniplayer: hiding existing window");
        let _ = window.hide();
    } else {
        log_line("hide_miniplayer: no window to hide");
    }
}

#[tauri::command]
fn toggle_miniplayer(app: tauri::AppHandle) {
    log_line("toggle_miniplayer invoked from frontend");
    if let Some(window) = app.get_webview_window(MINIPLAYER_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        log_line(&format!("toggle_miniplayer: existing window found, visible={visible}"));
        if visible {
            let _ = window.hide();
            return;
        }
    } else {
        log_line("toggle_miniplayer: no existing window");
    }
    create_or_show_miniplayer(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // webview2 needs somewhere writable for its profile (localstorage,
    // cookies, indexeddb — this is literally where the queue/playlists/
    // theme actually live on the frontend side, totally separate from the
    // sqlite db the server manages). leave it unset and it defaults to a
    // folder next to the exe, which is FINE in a dev folder but Program
    // Files isnt writable by a normal user, so webview2 was silently
    // falling back to a temp profile that got wiped every single restart.
    // spent way too long confused why my queue kept disappearing before i
    // figured this out. has to happen before ANY webview gets created, so
    // this is the very first thing in run(). webview2 is windows-only —
    // mac's WKWebView (via wry) doesnt have this problem, it already uses a
    // sane per-app writable profile location on its own
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        let webview_dir = Path::new(&appdata).join("com.shibenchi.musicplayer").join("webview2");
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
    }

    // fresh log every launch, old entries are just noise once youre past
    // whatever session made them
    let _ = std::fs::remove_file(log_dir().join("rust_debug.log"));
    log_line("=== app launching ===");
    #[cfg(windows)]
    log_line(&format!("WEBVIEW2_USER_DATA_FOLDER={:?}", std::env::var("WEBVIEW2_USER_DATA_FOLDER")));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![toggle_miniplayer, frontend_log, apply_shortcut_prefs])
        .manage(BackendProcesses(Mutex::new(Vec::new())))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let paths = resolve_paths(&app.handle());
            log_line(&format!(
                "setup: data_dir={} server_dir={} node_exe={}",
                paths.data_dir.display(),
                paths.server_dir.display(),
                paths.node_exe.display()
            ));
            migrate_dev_data_if_needed(&paths.data_dir);

            // start whatever isnt already running, so a leftover dev
            // server from testing just gets reused instead of double
            // spawning, before pointing any window at it
            {
                let state = app.state::<BackendProcesses>();
                let mut children = state.0.lock().unwrap();
                if !port_open(3001) {
                    log_line("setup: spawning main server (port 3001)");
                    match spawn_node(&paths, false) {
                        Ok(child) => {
                            log_line(&format!("setup: main server spawned, pid={}", child.id()));
                            children.push(child);
                        }
                        Err(e) => log_line(&format!("setup: FAILED to start backend server: {e}")),
                    }
                } else {
                    log_line("setup: port 3001 already open, reusing existing server");
                }
                if !port_open(3002) {
                    log_line("setup: spawning local helper (port 3002)");
                    match spawn_node(&paths, true) {
                        Ok(child) => {
                            log_line(&format!("setup: local helper spawned, pid={}", child.id()));
                            children.push(child);
                        }
                        Err(e) => log_line(&format!("setup: FAILED to start local helper: {e}")),
                    }
                } else {
                    log_line("setup: port 3002 already open, reusing existing server");
                }
            }

            // NOTE: tried a real "initializing... 40%" splash here
            // (WebviewUrl::App pointed at a bundled splash.html, self-
            // navigating to APP_URL once the backend was up) but its
            // content just never loaded under a plain `cargo build` and i
            // gave up chasing it — maybe worth another shot later with a
            // data: url instead of the asset protocol, but not shipping
            // it broken. reverted to just building the real window the
            // second the backend's confirmed up, still appears asap
            // instead of after some arbitrary fixed wait.
            // debounces the focus-loss -> show-miniplayer path (see the
            // Focused(false) handler below) — dragging or resizing the
            // main window fires RAPID spurious Focused(false)/Focused(true)
            // churn, a known webview2 thing during a host-window drag, and
            // reacting to every single one meant creating/showing a whole
            // new webview window dozens of times a SECOND. this is exactly
            // what made the window bug the hell out and fight alt-tab
            // during a drag, took forever to track down. only the latest
            // focus-loss still standing 400ms later actually triggers a show
            let focus_generation = Arc::new(AtomicU64::new(0));

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                log_line("startup: waiting for backend on port 3001");
                let mut waited_ms: u32 = 0;
                loop {
                    if port_open(3001) {
                        break;
                    }
                    if waited_ms >= 20_000 {
                        log_line("startup: gave up waiting for port 3001 after 20s, building window anyway");
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                    waited_ms += 250;
                }
                log_line(&format!("startup: backend ready after {waited_ms}ms, building main window"));

                let window = WebviewWindowBuilder::new(
                    &app_handle,
                    "main",
                    WebviewUrl::External(APP_URL.parse().unwrap()),
                )
                .title("Shibenchi's music player")
                // a fixed default can still be too tall on a smaller
                // screen no matter what number i pick here — the monitor
                // clamp below is what actually guarantees it fits, this
                // is just a decent starting point
                .inner_size(1400.0, 760.0)
                .min_inner_size(1000.0, 560.0)
                .resizable(true)
                .build();

                match window {
                    Ok(main_window) => {
                        log_line("startup: main window built OK");

                        // two things happening here, both need a real
                        // resize after the window already exists:
                        // 1. clamp to whatever actually fits the screen
                        //    it launched on — the fixed default above can
                        //    still be taller than a smaller display once
                        //    the taskbar eats into it, and tauri doesnt
                        //    expose the real os work area so this just
                        //    leaves a margin instead
                        // 2. webview2 sometimes lays out its first paint
                        //    against a viewport size measured BEFORE the
                        //    host window settles into its final size —
                        //    shows up as scrollable content getting cut
                        //    off short, only "fixed" by something like
                        //    maximizing forcing a real resize afterward.
                        //    took forever to figure out why scrolling was
                        //    broken only sometimes
                        // the clamp's own resize already covers #2 when it
                        // fires, and when it doesnt (window already fits)
                        // a trivial 1px nudge covers it instead
                        let window_for_nudge = main_window.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(400));
                            let Ok(size) = window_for_nudge.inner_size() else { return };

                            let mut target = size;
                            if let Ok(Some(monitor)) = window_for_nudge.primary_monitor() {
                                let scale = monitor.scale_factor();
                                let monitor_size = monitor.size();
                                let max_w = (monitor_size.width as f64 / scale * 0.95) as u32;
                                let max_h = (monitor_size.height as f64 / scale * 0.8) as u32;
                                target = tauri::PhysicalSize::new(size.width.min(max_w), size.height.min(max_h));
                            }

                            if target.width != size.width || target.height != size.height {
                                let _ = window_for_nudge.set_size(target);
                                let _ = window_for_nudge.center();
                                log_line(&format!("startup: clamped main window to {}x{} to fit the screen", target.width, target.height));
                            } else {
                                let nudged = tauri::PhysicalSize::new(size.width + 1, size.height);
                                let _ = window_for_nudge.set_size(nudged);
                                thread::sleep(Duration::from_millis(60));
                                let _ = window_for_nudge.set_size(size);
                                log_line("startup: nudged main window size to force WebView2 relayout");
                            }
                        });

                        // closing the main window just hides it instead of
                        // quitting, playback keeps going in the
                        // background — actual quit only happens from the
                        // tray menu
                        let window_for_handler = main_window.clone();
                        let app_handle_for_focus = app_handle.clone();
                        main_window.on_window_event(move |event| {
                            log_line(&format!("main window event: {event:?}"));
                            match event {
                                WindowEvent::CloseRequested { api, .. } => {
                                    api.prevent_close();
                                    let _ = window_for_handler.hide();
                                }
                                // minimizing ALSO fires Focused(false) on
                                // windows so this one event covers both
                                // "minimized" and "unfocused" — losing
                                // focus brings up the mini widget, getting
                                // it back (or restoring from tray) tucks
                                // it away again. debounced (see
                                // focus_generation above) so drag/resize
                                // churn doesnt spam window creation like
                                // it used to, that was SO annoying
                                WindowEvent::Focused(false) => {
                                    let my_gen = focus_generation.fetch_add(1, Ordering::SeqCst) + 1;
                                    log_line(&format!("main window lost focus -> scheduling miniplayer show (gen {my_gen})"));
                                    let gen_check = focus_generation.clone();
                                    let app_for_debounce = app_handle_for_focus.clone();
                                    thread::spawn(move || {
                                        thread::sleep(Duration::from_millis(400));
                                        if gen_check.load(Ordering::SeqCst) == my_gen {
                                            log_line(&format!("gen {my_gen} still current after debounce -> showing miniplayer"));
                                            create_or_show_miniplayer(&app_for_debounce);
                                        } else {
                                            log_line(&format!("gen {my_gen} superseded before debounce elapsed -> skipping"));
                                        }
                                    });
                                }
                                WindowEvent::Focused(true) => {
                                    focus_generation.fetch_add(1, Ordering::SeqCst);
                                    log_line("main window gained focus -> hiding miniplayer");
                                    hide_miniplayer(&app_handle_for_focus);
                                }
                                _ => {}
                            }
                        });
                    }
                    Err(e) => log_line(&format!("startup: FAILED to build main window: {e}")),
                }
            });

            let show_item = MenuItem::with_id(app, "show", "show player", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Shibenchi's music player")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    log_line(&format!("tray menu event: {}", event.id.as_ref()));
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            kill_backend(app);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        log_line("tray icon left-clicked");
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    log_line("main window destroyed -> killing backend");
                    kill_backend(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
