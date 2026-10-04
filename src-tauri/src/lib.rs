// the app has two shells. the desktop one (desktop.rs) starts a bundled node
// server and a local audio helper, owns the tray icon and the mini player
// window, and loads the interface from that local server. the mobile one
// (mobile.rs) has no node, no tray and no second window: it just shows the
// interface that is bundled into the app. which one gets built depends on the
// platform being compiled for.
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(mobile)]
    mobile::run();
}
