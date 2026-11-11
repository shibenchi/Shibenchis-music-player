// the windows side of the live wallpaper: putting an existing window behind the desktop icons, and finding out whether the
// desktop can be seen at all. raw user32 and dwmapi calls only (no extra crate), so this file can also be compiled on its own
// by the probe in examples/wallpaper_probe.rs
//
// how the desktop is built, which differs between windows versions (checked on build 26200 with a dump of the real windows):
// - classic (windows 10, windows 11 up to 23H2): the icons (SHELLDLL_DefView) sit in a top level window, and the message 0x052C
//   sent to Progman makes the shell create a second top level WorkerW behind it. a window that is made a child of that
//   WorkerW is drawn over the wallpaper and under the icons
// - raised (windows 11 24H2 and later): Progman itself holds SHELLDLL_DefView and, after 0x052C, a WorkerW child below it
//   that draws the wallpaper. Progman has no redirection bitmap there, so only what draws through DirectComposition (which
//   webview2 does) shows up. the window becomes a child of Progman placed right under the icon view, and the shell's own
//   WorkerW goes to the very bottom so it cannot paint over it
#![cfg(windows)]
#![allow(non_snake_case, dead_code, clippy::missing_safety_doc)]

use std::ffi::c_void;

pub type Hwnd = isize;

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> Hwnd;
    fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, title: *const u16) -> Hwnd;
    fn SendMessageTimeoutW(h: Hwnd, msg: u32, wparam: usize, lparam: isize, flags: u32, timeout: u32, result: *mut usize) -> isize;
    fn GetWindowLongPtrW(h: Hwnd, index: i32) -> isize;
    fn SetWindowLongPtrW(h: Hwnd, index: i32, value: isize) -> isize;
    fn SetParent(child: Hwnd, parent: Hwnd) -> Hwnd;
    fn GetParent(h: Hwnd) -> Hwnd;
    fn SetWindowPos(h: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindowRect(h: Hwnd, rect: *mut Rect) -> i32;
    fn MapWindowPoints(from: Hwnd, to: Hwnd, points: *mut Point, count: u32) -> i32;
    fn MonitorFromPoint(point: Point, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    fn IsWindow(h: Hwnd) -> i32;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn IsIconic(h: Hwnd) -> i32;
    fn ShowWindow(h: Hwnd, command: i32) -> i32;
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
    fn GetClassNameW(h: Hwnd, buffer: *mut u16, max: i32) -> i32;
    fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> isize;
    fn CloseDesktop(desktop: isize) -> i32;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(h: Hwnd, attribute: u32, value: *mut c_void, size: u32) -> i32;
}

const GWL_STYLE: i32 = -16;
const GWL_EXSTYLE: i32 = -20;

const WS_POPUP: isize = 0x8000_0000u32 as i32 as isize;
const WS_CHILD: isize = 0x4000_0000;
const WS_CAPTION: isize = 0x00C0_0000;
const WS_THICKFRAME: isize = 0x0004_0000;
const WS_CLIPSIBLINGS: isize = 0x0400_0000;
const WS_CLIPCHILDREN: isize = 0x0200_0000;

const WS_EX_TRANSPARENT: isize = 0x0000_0020;
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_APPWINDOW: isize = 0x0004_0000;
const WS_EX_NOREDIRECTIONBITMAP: isize = 0x0020_0000;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;

const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
const SWP_SHOWWINDOW: u32 = 0x0040;

const HWND_BOTTOM: Hwnd = 1;
const HWND_DESKTOP: Hwnd = 0;

const MONITOR_DEFAULTTOPRIMARY: u32 = 1;
const DWMWA_CLOAKED: u32 = 14;
const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;

pub const SW_HIDE: i32 = 0;
pub const SW_SHOWNOACTIVATE: i32 = 4;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn class_name(h: Hwnd) -> String {
    let mut buffer = [0u16; 128];
    let length = unsafe { GetClassNameW(h, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn find_child(parent: Hwnd, after: Hwnd, class: &str) -> Hwnd {
    let class = wide(class);
    unsafe { FindWindowExW(parent, after, class.as_ptr(), std::ptr::null()) }
}

fn rect_of(h: Hwnd) -> Rect {
    let mut rect = Rect::default();
    unsafe { GetWindowRect(h, &mut rect) };
    rect
}

// the primary monitor in physical pixels (this process is per monitor DPI aware, like the rest of the app)
pub fn primary_monitor_rect() -> Rect {
    unsafe {
        let monitor = MonitorFromPoint(Point { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MonitorInfo { size: std::mem::size_of::<MonitorInfo>() as u32, monitor: Rect::default(), work: Rect::default(), flags: 0 };
        if monitor != 0 && GetMonitorInfoW(monitor, &mut info) != 0 {
            return info.monitor;
        }
    }
    Rect { left: 0, top: 0, right: 1920, bottom: 1080 }
}

#[derive(Debug, Clone, Copy)]
pub struct Layer {
    // the window the wallpaper window becomes a child of
    pub parent: Hwnd,
    // the raised desktop of 24H2 and later (see the top of this file)
    pub raised: bool,
    // the icon view, only known on the raised desktop
    pub icons: Hwnd,
    // the shell's own wallpaper window, only known on the raised desktop
    pub shell_worker: Hwnd,
}

// asks the shell for its wallpaper layer and finds where a window has to go
pub fn find_layer() -> Result<Layer, String> {
    let progman_class = wide("Progman");
    let progman = unsafe { FindWindowW(progman_class.as_ptr(), std::ptr::null()) };
    if progman == 0 {
        return Err("the desktop window (Progman) was not found".to_string());
    }
    // the message that makes the shell create its wallpaper layer. harmless when the layer already exists
    let mut ignored = 0usize;
    unsafe { SendMessageTimeoutW(progman, 0x052C, 0xD, 1, 0, 1000, &mut ignored) };

    // raised: the icon view is a child of Progman
    let icons = find_child(progman, 0, "SHELLDLL_DefView");
    if icons != 0 {
        let shell_worker = find_child(progman, 0, "WorkerW");
        return Ok(Layer { parent: progman, raised: true, icons, shell_worker });
    }

    // classic: the top level window that holds the icon view, and the WorkerW that comes after it
    struct Search {
        host: Hwnd,
    }
    unsafe extern "system" fn look(h: Hwnd, lparam: isize) -> i32 {
        let search = &mut *(lparam as *mut Search);
        let icon_class = wide("SHELLDLL_DefView");
        if FindWindowExW(h, 0, icon_class.as_ptr(), std::ptr::null()) != 0 {
            search.host = h;
            return 0;
        }
        1
    }
    let mut search = Search { host: 0 };
    unsafe { EnumWindows(look, &mut search as *mut Search as isize) };
    if search.host == 0 {
        return Err("the icon view of the desktop was not found".to_string());
    }
    let worker = find_child(HWND_DESKTOP, search.host, "WorkerW");
    if worker == 0 {
        return Err("the wallpaper layer (WorkerW) was not created by the shell".to_string());
    }
    Ok(Layer { parent: worker, raised: false, icons: 0, shell_worker: 0 })
}

#[derive(Debug, Clone, Copy)]
pub struct Attached {
    pub layer: Layer,
    pub size: (i32, i32),
}

// turns an existing top level window into the wallpaper: a child of the layer, as big as the primary monitor, behind the
// icons, never taking focus, not in the taskbar or the alt tab list. the window should not be visible yet (it is shown here,
// already as a child, so it never flashes on top of everything)
pub fn attach(window: Hwnd) -> Result<Attached, String> {
    if unsafe { IsWindow(window) } == 0 {
        return Err("the window is gone".to_string());
    }
    let layer = find_layer()?;
    let monitor = primary_monitor_rect();
    unsafe {
        // the styles change before SetParent, which does not touch WS_POPUP and WS_CHILD itself (they are never combined)
        let style = GetWindowLongPtrW(window, GWL_STYLE);
        let style = (style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
        SetWindowLongPtrW(window, GWL_STYLE, style);
        let ex_style = GetWindowLongPtrW(window, GWL_EXSTYLE);
        let ex_style = (ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & !WS_EX_APPWINDOW;
        SetWindowLongPtrW(window, GWL_EXSTYLE, ex_style);

        SetParent(window, layer.parent);

        // where the monitor starts, in the coordinates of the new parent
        let mut origin = Point { x: monitor.left, y: monitor.top };
        MapWindowPoints(HWND_DESKTOP, layer.parent, &mut origin, 1);

        // the raised desktop: right under the icon view. the classic one: the top of its own layer
        let insert_after = if layer.raised { layer.icons } else { 0 };
        let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED;
        if SetWindowPos(window, insert_after, origin.x, origin.y, monitor.width(), monitor.height(), flags) == 0 {
            return Err("the window could not be placed behind the icons".to_string());
        }
        if layer.raised && layer.shell_worker != 0 {
            SetWindowPos(layer.shell_worker, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    Ok(Attached { layer, size: (monitor.width(), monitor.height()) })
}

// the shell's own wallpaper window on the raised desktop (0 on the classic one, where it is a top level window). when the person
// changes the wallpaper the shell can make a new one, which lands above the wallpaper window: the handle changing says so
pub fn shell_worker() -> Hwnd {
    let progman_class = wide("Progman");
    let progman = unsafe { FindWindowW(progman_class.as_ptr(), std::ptr::null()) };
    if progman == 0 {
        return 0;
    }
    find_child(progman, 0, "WorkerW")
}

// the window still sits in the layer it was put in (explorer restarting destroys the layer and with it the window)
pub fn still_attached(window: Hwnd, layer: &Layer) -> bool {
    unsafe { IsWindow(window) != 0 && GetParent(window) == layer.parent && IsWindow(layer.parent) != 0 }
}

pub fn is_window(window: Hwnd) -> bool {
    unsafe { IsWindow(window) != 0 }
}

pub fn show(window: Hwnd, visible: bool) {
    unsafe { ShowWindow(window, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
}

// true when the person cannot see the desktop right now: the screen is locked (or a secure screen is up), or a window
// covers most of the primary monitor (a maximized window, a fullscreen game). nothing is drawn for it then
pub fn desktop_hidden(own_window: Hwnd) -> bool {
    unsafe {
        // the input desktop of a locked computer cannot be opened
        let input = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if input == 0 {
            return true;
        }
        CloseDesktop(input);
    }

    struct Cover {
        monitor: Rect,
        own: Hwnd,
        covered: bool,
    }
    unsafe extern "system" fn check(h: Hwnd, lparam: isize) -> i32 {
        let cover = &mut *(lparam as *mut Cover);
        if h == cover.own || IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
            return 1;
        }
        // windows of other virtual desktops and the shell's own full screen helpers exist but are cloaked
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4) == 0 && cloaked != 0 {
            return 1;
        }
        let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE);
        // overlays that cover the whole screen but let everything through (game overlays), and tool windows
        if ex_style & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) != 0 {
            return 1;
        }
        let class = class_name(h);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow") {
            return 1;
        }
        let rect = rect_of(h);
        let left = rect.left.max(cover.monitor.left);
        let top = rect.top.max(cover.monitor.top);
        let right = rect.right.min(cover.monitor.right);
        let bottom = rect.bottom.min(cover.monitor.bottom);
        if right <= left || bottom <= top {
            return 1;
        }
        let shown = (right - left) as i64 * (bottom - top) as i64;
        let whole = cover.monitor.width() as i64 * cover.monitor.height() as i64;
        if whole > 0 && shown * 100 >= whole * 90 {
            cover.covered = true;
            return 0;
        }
        1
    }
    let mut cover = Cover { monitor: primary_monitor_rect(), own: own_window, covered: false };
    unsafe { EnumWindows(check, &mut cover as *mut Cover as isize) };
    cover.covered
}

// for the probe and the logs: is the desktop of this windows build the raised kind
pub fn describe() -> String {
    let progman_class = wide("Progman");
    let progman = unsafe { FindWindowW(progman_class.as_ptr(), std::ptr::null()) };
    if progman == 0 {
        return "no Progman".to_string();
    }
    let ex_style = unsafe { GetWindowLongPtrW(progman, GWL_EXSTYLE) };
    format!("progman 0x{:X}, no redirection bitmap: {}, icons are its child: {}", progman, ex_style & WS_EX_NOREDIRECTIONBITMAP != 0, find_child(progman, 0, "SHELLDLL_DefView") != 0)
}
