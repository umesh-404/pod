// Linux: XDG directories for files, xdg-open for links and folders, and
// gtk-layer-shell for the island window.
//
// Wayland gives an app no global cursor position and no say over where its
// window goes, so the island works differently from Windows:
//   * it is a layer-shell surface anchored to the top edge, above everything,
//     on compositors that support it (COSMIC, KDE, wlroots — not GNOME);
//   * click-through is the window's input region, set to the island shape, so
//     the compositor itself sends every other click to whatever is underneath;
//   * the cursor comes from the page's own mouse events, which only fire over
//     the island — Stew's eyes follow the pointer there, not across the screen.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use tauri::{AppHandle, WebviewWindow};

use super::{home_dir, LocalTime};

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "HOME";

// ── Files ─────────────────────────────────────────────────────────────────────

/// An XDG base directory (`$XDG_CONFIG_HOME` …), or its fallback under the home
/// directory when it is unset or not absolute.
fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_dir().join(fallback))
}

/// ~/.config/pod — preferences.
pub fn config_dir() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config").join("pod")
}

/// ~/.local/share/pod — where the inbox and the log live.
pub fn local_dir() -> PathBuf {
    xdg("XDG_DATA_HOME", ".local/share").join("pod")
}

/// Environment the webview must inherit, set before any thread or process
/// starts.
///
/// Inside an AppImage, WebKit uses the GStreamer bundled with it, and GStreamer
/// keeps its plugin registry in ~/.cache/gstreamer-1.0 by default — the same
/// file the system's GStreamer uses. The AppImage is mounted somewhere new on
/// every launch, so each launch would rewrite the system's registry with
/// plugin paths that vanish once Pod quits. Give ours its own file.
pub fn prepare_environment() {
    let _ = INHERITED.set(OWN_OVERRIDES.iter().map(|k| (*k, std::env::var_os(k))).collect());
    prefer_x11_on_gnome();
    follow_gnome_text_scaling();
    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os("GST_REGISTRY").is_some() {
        return;
    }
    let cache = xdg("XDG_CACHE_HOME", ".cache").join("pod");
    if std::fs::create_dir_all(&cache).is_ok() {
        std::env::set_var("GST_REGISTRY", cache.join("gstreamer-registry.bin"));
    }
}

/// GNOME on Wayland has no layer-shell and ignores where a regular window asks
/// to go, so the island lands in the middle of the screen. Through XWayland it
/// can be placed, and a Dock window survives "show desktop" (Super+D).
/// An inherited GDK_BACKEND=wayland is overridden too: editors and terminals
/// pass theirs down to every child. POD_X11=0 keeps the Wayland window.
fn prefer_x11_on_gnome() {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    if should_prefer_x11(
        &env("XDG_SESSION_TYPE"),
        &env("XDG_CURRENT_DESKTOP"),
        &env("POD_X11"),
        &env("DISPLAY"),
    ) {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

/// Only with XWayland actually there (`DISPLAY` set): forcing x11 without it
/// would leave GTK with no display at all.
fn should_prefer_x11(session: &str, desktop: &str, opt: &str, display: &str) -> bool {
    session.eq_ignore_ascii_case("wayland")
        && desktop.split(':').any(|d| d.eq_ignore_ascii_case("gnome"))
        && opt != "0"
        && !display.trim().is_empty()
}

fn is_gnome(desktop: &str) -> bool {
    desktop.split(':').any(|d| d.eq_ignore_ascii_case("gnome"))
}

/// GNOME's "Large text" (text-scaling-factor > 1) makes WebKitGTK draw every
/// font larger inside a window sized in fixed pixels, so the island's content
/// was cut off (#122). The island's layout is its own, so it asks GDK to undo
/// that factor for this process only. An explicit GDK_DPI_SCALE always wins.
fn follow_gnome_text_scaling() {
    if std::env::var_os("GDK_DPI_SCALE").is_some()
        || !is_gnome(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())
    {
        return;
    }
    let Ok(out) = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "text-scaling-factor"])
        .output()
    else {
        return;
    };
    if let Some(scale) = dpi_scale_for(&String::from_utf8_lossy(&out.stdout)) {
        std::env::set_var("GDK_DPI_SCALE", scale);
    }
}

/// `"1.25\n"` → `Some("0.8")`; `None` for 1.0 or anything unreadable.
fn dpi_scale_for(gsettings_output: &str) -> Option<String> {
    let factor: f64 = gsettings_output.trim().parse().ok()?;
    if !(0.5..=3.0).contains(&factor) || (factor - 1.0).abs() < 0.01 {
        return None;
    }
    Some(format!("{:.4}", 1.0 / factor).trim_end_matches('0').trim_end_matches('.').to_string())
}

pub fn local_time() -> LocalTime {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        libc::localtime_r(&now, &mut tm);
    }
    LocalTime {
        year: (tm.tm_year + 1900) as u32,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// Creates `dir` and closes it to other users. The log, the inbox of dropped
/// files and the relay binary live under these directories; with the default
/// umask they would come out 0755 and readable by anyone on the machine.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// What the variables Pod sets for itself (prepare_environment) were when it
/// started, so its children get the user's own values back.
static INHERITED: std::sync::OnceLock<Vec<(&'static str, Option<std::ffi::OsString>)>> = std::sync::OnceLock::new();
/// Set or changed by prepare_environment for this process only.
const OWN_OVERRIDES: [&str; 3] = ["GDK_BACKEND", "GDK_DPI_SCALE", "GST_REGISTRY"];
/// Set by the AppImage's launcher for its bundled GStreamer: dropped when they
/// point inside the AppImage, which a child cannot use.
const APPIMAGE_GST: [&str; 3] = ["GST_REGISTRY_1_0", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0"];

/// The changes a child's environment needs: `Some` sets the value back, `None`
/// removes the variable. Nothing for a variable Pod left as it found it.
fn child_env(
    inherited: &[(&str, Option<std::ffi::OsString>)],
    current: impl Fn(&str) -> Option<std::ffi::OsString>,
    appdir: Option<&std::ffi::OsStr>,
) -> Vec<(String, Option<std::ffi::OsString>)> {
    let mut out = Vec::new();
    for (key, was) in inherited {
        if current(key) != *was {
            out.push((key.to_string(), was.clone()));
        }
    }
    if let Some(dir) = appdir.and_then(|d| d.to_str()).filter(|d| !d.is_empty()) {
        for key in APPIMAGE_GST {
            if current(key).is_some_and(|v| v.to_string_lossy().contains(dir)) {
                out.push((key.to_string(), None));
            }
        }
    }
    out
}

/// Prepares a command to launch a child process: Pod's own GDK and
/// GStreamer settings (GDK_BACKEND=x11 on GNOME, GDK_DPI_SCALE, the AppImage's
/// GStreamer paths) go back to what the user had, so they do not leak into the
/// browser, the editor or the apps it opens (#859).
pub fn no_console(cmd: &mut Command) -> &mut Command {
    let inherited = INHERITED.get().map(Vec::as_slice).unwrap_or(&[]);
    let appdir = std::env::var_os("APPDIR");
    for (key, value) in child_env(inherited, |k| std::env::var_os(k), appdir.as_deref()) {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    cmd
}

pub fn open_url(url: &str) {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(url);
    let _ = no_console(&mut cmd).spawn();
}

pub fn reveal_folder(path: &str) {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path);
    let _ = no_console(&mut cmd).spawn();
}

/// Our own `which`: the first executable file named `stem` on $PATH.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    std::env::split_paths(&dirs)
        .map(|dir| dir.join(stem))
        .find(|p| {
            std::fs::metadata(p)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Nothing polls the cursor here: the page reports it over the island, and the
/// input region decides click-through (see the top of this file).
pub const CURSOR_POLL: bool = false;

pub fn cursor_physical() -> Option<(f64, f64)> {
    None
}

pub fn left_button_down() -> bool {
    false
}

// ── Island window ─────────────────────────────────────────────────────────────

/// The few gtk-layer-shell calls we need, straight from the C library.
mod layer {
    use gtk::ffi::GtkWindow;
    use std::os::raw::{c_char, c_int};

    pub const LAYER_TOP: c_int = 2;
    pub const LAYER_OVERLAY: c_int = 3;
    pub const EDGE_LEFT: c_int = 0;
    pub const EDGE_RIGHT: c_int = 1;
    pub const EDGE_TOP: c_int = 2;
    pub const EDGE_BOTTOM: c_int = 3;
    pub const KEYBOARD_NONE: c_int = 0;
    pub const KEYBOARD_ON_DEMAND: c_int = 2;

    #[link(name = "gtk-layer-shell")]
    extern "C" {
        pub fn gtk_layer_is_supported() -> c_int;
        pub fn gtk_layer_init_for_window(window: *mut GtkWindow);
        pub fn gtk_layer_set_namespace(window: *mut GtkWindow, name_space: *const c_char);
        pub fn gtk_layer_set_layer(window: *mut GtkWindow, layer: c_int);
        pub fn gtk_layer_set_anchor(window: *mut GtkWindow, edge: c_int, anchor: c_int);
        pub fn gtk_layer_set_margin(window: *mut GtkWindow, edge: c_int, margin: c_int);
        pub fn gtk_layer_set_monitor(window: *mut GtkWindow, monitor: *mut gtk::gdk::ffi::GdkMonitor);
        pub fn gtk_layer_set_exclusive_zone(window: *mut GtkWindow, zone: c_int);
        pub fn gtk_layer_set_keyboard_mode(window: *mut GtkWindow, mode: c_int);
    }
}

/// POD_LAYER_SHELL=0 is the way out on a compositor where it misbehaves.
fn layer_shell_wanted() -> bool {
    std::env::var("POD_LAYER_SHELL").map(|v| v != "0").unwrap_or(true)
}

/// True once the island window is a layer-shell surface.
static LAYER_SURFACE: AtomicBool = AtomicBool::new(false);

/// The input region last asked for, re-applied whenever the window is mapped:
/// GTK resets it to the whole window on map. Until the page reports the island
/// shape it is empty, so nothing takes the mouse.
type Region = Option<(f64, f64, f64, f64)>;
static INPUT_REGION: Mutex<Region> = Mutex::new(Some((0.0, 0.0, 0.0, 0.0)));

fn gtk_window_ptr(win: &gtk::ApplicationWindow) -> *mut gtk::ffi::GtkWindow {
    let w: &gtk::Window = win.upcast_ref();
    w.to_glib_none().0
}

/// WebKitGTK has no competing drop target to remove.
pub fn unblock_webview_drops(_app: &AppHandle) {}

/// Turns the island into an overlay surface on the top edge that never takes
/// the keyboard. Must run before the window is first shown: a layer surface
/// cannot be made out of a window the compositor already knows.
///
/// Without layer-shell (GNOME, X11, or POD_LAYER_SHELL=0) the window stays
/// an ordinary always-on-top window that refuses focus; where it lands is then
/// up to the window manager.
pub fn make_non_activating(win: &WebviewWindow) {
    let Ok(gw) = win.gtk_window() else { return };
    // The pointer watch reports the pointer leaving on every kind of window:
    // a regular one (GNOME, X11) misses `mouseout` just as a layer surface does.
    ISLAND_GTK.with(|cell| *cell.borrow_mut() = Some(gw.clone()));
    watch_pointer_leave(win);
    let wanted = layer_shell_wanted();
    let supported = unsafe { layer::gtk_layer_is_supported() } != 0;
    if !wanted || !supported || gw.is_realized() {
        let why = if !wanted {
            "POD_LAYER_SHELL=0"
        } else if supported {
            "window already shown"
        } else {
            "compositor has no layer-shell"
        };
        crate::log::line(format!("island is a regular window ({why})"));
        gw.set_accept_focus(false);
        if !gw.is_realized() {
            // On X11 a Dock is kept above everything and is the only kind of
            // window, besides the desktop, that "show desktop" leaves alone.
            // POD_DOCK=0 falls back to a utility window.
            let dock = std::env::var("POD_DOCK").map(|v| v != "0").unwrap_or(true);
            gw.set_type_hint(if dock {
                gtk::gdk::WindowTypeHint::Dock
            } else {
                gtk::gdk::WindowTypeHint::Utility
            });
        }
        gw.set_keep_above(true);
        return;
    }
    // tao gives undecorated Wayland windows an empty titlebar to force
    // client-side decorations. A layer surface has none, and a client-decorated
    // GtkWindow recomputes its own input region (shadow margins included) on
    // every map, over ours.
    gw.set_titlebar(None::<&gtk::Widget>);
    let ptr = gtk_window_ptr(&gw);
    unsafe {
        layer::gtk_layer_init_for_window(ptr);
        layer::gtk_layer_set_namespace(ptr, c"pod".as_ptr());
        layer::gtk_layer_set_layer(ptr, layer::LAYER_OVERLAY);
        // Top edge only: the compositor centres the surface horizontally.
        layer::gtk_layer_set_anchor(ptr, layer::EDGE_TOP, 1);
        // -1: sit right against the screen edge, over any top panel, the way
        // the Mac island sits in the notch.
        layer::gtk_layer_set_exclusive_zone(ptr, -1);
        layer::gtk_layer_set_keyboard_mode(ptr, layer::KEYBOARD_NONE);
    }
    // WebKitGTK in a freshly mapped layer surface never paints its first frame
    // (seen on COSMIC, and reproduced with a bare GTK window + WebKitGTK, no
    // Tauri involved): the surface stays empty. Unmapping and mapping it once,
    // right after the first map, gets it drawing for good.
    let remapped = std::cell::Cell::new(false);
    gw.connect_map_event(move |w, _| {
        apply_input_region(w, *INPUT_REGION.lock().unwrap());
        if !remapped.replace(true) {
            let w = w.clone();
            gtk::glib::idle_add_local_once(move || {
                w.hide();
                w.show_all();
                apply_input_region(&w, *INPUT_REGION.lock().unwrap());
            });
        }
        gtk::glib::Propagation::Proceed
    });
    LAYER_SURFACE.store(true, Ordering::Relaxed);
    crate::log::line("island is a layer-shell overlay");
}

thread_local! {
    /// The island's GTK window, for the pointer watch (GTK main thread only).
    static ISLAND_GTK: std::cell::RefCell<Option<gtk::ApplicationWindow>> =
        const { std::cell::RefCell::new(None) };
}

/// Reports the pointer leaving the island, which the page cannot see by itself.
///
/// On a layer surface WebKitGTK does not send `mouseout` when the pointer leaves
/// for good, and GTK's leave-notify fires spuriously while the pointer is still
/// over the island (each followed by a re-enter), so neither tells "really
/// gone". GDK's pointer focus does: it follows the compositor's wl_pointer
/// enter/leave. It is read every 100 ms while the island is shown; both edges go
/// to the page as `pointer-inside`, and leaving also emits the far-away cursor
/// the page uses. While the island is hidden the timer is removed altogether
/// (set_pointer_watch), so a hidden island costs nothing.
static POINTER_WIN: std::sync::OnceLock<WebviewWindow> = std::sync::OnceLock::new();
static WATCH_WANTED: AtomicBool = AtomicBool::new(true);
static WATCH_RUNNING: AtomicBool = AtomicBool::new(false);

fn watch_pointer_leave(win: &WebviewWindow) {
    let _ = POINTER_WIN.set(win.clone());
    start_pointer_watch();
}

/// Starts or parks the pointer watch. Called with the island's collapsed state;
/// safe from any thread (the timer itself lives on the GTK main loop).
pub fn set_pointer_watch(active: bool) {
    WATCH_WANTED.store(active, Ordering::Relaxed);
    if active {
        gtk::glib::MainContext::default().invoke(start_pointer_watch);
    }
}

/// Main thread only.
fn start_pointer_watch() {
    if !WATCH_WANTED.load(Ordering::Relaxed) || WATCH_RUNNING.swap(true, Ordering::Relaxed) {
        return;
    }
    use tauri::Emitter;
    let Some(win) = POINTER_WIN.get().cloned() else {
        WATCH_RUNNING.store(false, Ordering::Relaxed);
        return;
    };
    let inside = std::cell::Cell::new(false);
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        if !WATCH_WANTED.load(Ordering::Relaxed) {
            WATCH_RUNNING.store(false, Ordering::Relaxed);
            return gtk::glib::ControlFlow::Break;
        }
        let now_inside = ISLAND_GTK
            .with(|cell| {
                let gw = cell.borrow().clone()?;
                let ours = gw.window()?;
                let pointer = gtk::gdk::Display::default()?.default_seat()?.pointer()?;
                let (under, _, _) = pointer.window_at_position();
                Some(under?.toplevel() == ours.toplevel())
            })
            .unwrap_or(false);
        if inside.replace(now_inside) != now_inside {
            // The page gates its own (late, sometimes stale) mouse events on
            // this state, so a mousemove queued before the pointer left cannot
            // pull the island back to "inside".
            let _ = win.emit("pointer-inside", now_inside);
            if !now_inside {
                let _ = win.emit("cursor", crate::island::CursorPayload { x: -10_000.0, y: -10_000.0 });
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

/// Puts the layer surface on the display whose logical origin is (`x`, `y`).
///
/// A layer surface ignores `set_position`: without an explicit output the
/// compositor maps it on whichever display has focus at that moment, so on a
/// multi-monitor Hyprland or Sway desktop the island wandered from one screen
/// to the other every time it was remapped. A no-op for a regular window, which
/// `set_position` already places.
pub fn pin_to_monitor(win: &WebviewWindow, x: i32, y: i32) {
    if !LAYER_SURFACE.load(Ordering::Relaxed) {
        return;
    }
    let Ok(gw) = win.gtk_window() else { return };
    let display = gw.display();
    let monitor = (0..display.n_monitors())
        .filter_map(|i| display.monitor(i))
        .find(|m| {
            let g = m.geometry();
            g.x() == x && g.y() == y
        });
    let Some(monitor) = monitor else { return };
    let mon_ptr: *mut gtk::gdk::ffi::GdkMonitor = monitor.to_glib_none().0;
    unsafe { layer::gtk_layer_set_monitor(gtk_window_ptr(&gw), mon_ptr) };
}

/// Temporarily allow keyboard focus so a text field inside the island can be
/// typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Ok(gw) = win.gtk_window() else { return };
    // The island is created `focusable: false` (tauri.linux.conf.json), so GTK
    // refuses focus until we say otherwise — on a layer surface too.
    gw.set_accept_focus(activating);
    if LAYER_SURFACE.load(Ordering::Relaxed) {
        let mode = if activating { layer::KEYBOARD_ON_DEMAND } else { layer::KEYBOARD_NONE };
        unsafe { layer::gtk_layer_set_keyboard_mode(gtk_window_ptr(&gw), mode) };
    }
}

/// Only this rectangle (window-logical pixels) takes the mouse; `None` means
/// the whole window does. Everything outside goes to the window underneath.
pub fn set_input_region(win: &WebviewWindow, rect: Region) {
    *INPUT_REGION.lock().unwrap() = rect;
    let Ok(gw) = win.gtk_window() else { return };
    apply_input_region(&gw, rect);
}

fn apply_input_region(gw: &impl IsA<gtk::Widget>, rect: Region) {
    match rect {
        None => gw.input_shape_combine_region(None),
        Some((x, y, w, h)) => {
            let Some(gdk_window) = gw.window() else { return };
            let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                x.floor() as i32,
                y.floor() as i32,
                w.ceil().max(0.0) as i32,
                h.ceil().max(0.0) as i32,
            ));
            gdk_window.input_shape_combine_region(&region, 0, 0);
        }
    }
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// Global shortcuts are X11 key grabs. A Wayland session has no such thing: a
/// grab made through XWayland only sees keys typed into other X11 windows, so
/// it would look registered and never fire. On Wayland the shortcuts go to the
/// desktop through the XDG GlobalShortcuts portal instead (portal.rs), and
/// where there is none Settings explains how to bind `pod --shortcut <id>`
/// in the desktop's own keyboard settings.
pub fn global_shortcuts_blocked() -> Option<&'static str> {
    let set = |var: &str| std::env::var_os(var).is_some_and(|v| !v.is_empty());
    let wayland = set("WAYLAND_DISPLAY")
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"));
    if wayland {
        Some("wayland")
    } else if !set("DISPLAY") {
        Some("no-display")
    } else {
        None
    }
}

/// On X11, AltGr is a modifier of its own (ISO_Level3_Shift): Ctrl+Alt+key
/// never stands for it, so no combination takes a character away.
pub fn ctrl_alt_types(_vk: u16, _shift: bool) -> Option<String> {
    None
}

// ── Desktop Stew window ──────────────────────────────────────────────────────
//
// Where the window may go decides everything here:
//   * X11 places any window where it is asked: an ordinary always-on-top
//     window, moved with set_position;
//   * a layer-shell compositor won't move a toplevel, but anchors a layer
//     surface wherever its margins say, on the island's display;
//   * GNOME on Wayland has neither, so the feature is off there.
// In every case the input region is Stew's body, so clicks anywhere else go
// to the desktop underneath without any cursor polling.

/// Which of the three applies. Must run on the GTK main thread.
pub fn desktop_mode() -> super::DesktopMode {
    use gtk::glib::prelude::ObjectExt;
    let wayland = gtk::gdk::Display::default()
        .map(|d| d.type_().name().contains("Wayland"))
        .unwrap_or(false);
    let layer = layer_shell_wanted() && unsafe { layer::gtk_layer_is_supported() } != 0;
    if layer {
        super::DesktopMode::Layer
    } else if !wayland {
        super::DesktopMode::Window
    } else {
        super::DesktopMode::Off
    }
}

/// The input shape last asked for the desktop Stew, re-applied on every map.
static MOCHI_SHAPE: Mutex<super::MouseShape> = Mutex::new(super::MouseShape::Empty);

/// Sets the window up for `mode` before it is ever shown. False means it can't
/// be used (a layer surface can't be made from a window already shown).
pub fn prepare_desktop_window(win: &WebviewWindow, mode: super::DesktopMode) -> bool {
    let Ok(gw) = win.gtk_window() else { return false };
    gw.set_accept_focus(false);
    match mode {
        super::DesktopMode::Layer => {
            if gw.is_realized() {
                crate::log::line("desktop Stew: window already shown, no layer surface");
                return false;
            }
            gw.set_titlebar(None::<&gtk::Widget>);
            let ptr = gtk_window_ptr(&gw);
            unsafe {
                layer::gtk_layer_init_for_window(ptr);
                layer::gtk_layer_set_namespace(ptr, c"pod-mochi".as_ptr());
                // Above windows, below fullscreen video — like a floating panel.
                layer::gtk_layer_set_layer(ptr, layer::LAYER_TOP);
                layer::gtk_layer_set_anchor(ptr, layer::EDGE_TOP, 1);
                layer::gtk_layer_set_anchor(ptr, layer::EDGE_LEFT, 1);
                // -1: margins count from the display's corner, panels or not,
                // the same origin the island uses.
                layer::gtk_layer_set_exclusive_zone(ptr, -1);
                layer::gtk_layer_set_keyboard_mode(ptr, layer::KEYBOARD_NONE);
            }
            // Same first-frame problem as the island (see make_non_activating).
            let remapped = std::cell::Cell::new(false);
            gw.connect_map_event(move |w, _| {
                apply_mouse_shape(w, *MOCHI_SHAPE.lock().unwrap());
                if !remapped.replace(true) {
                    let w = w.clone();
                    gtk::glib::idle_add_local_once(move || {
                        w.hide();
                        w.show_all();
                        apply_mouse_shape(&w, *MOCHI_SHAPE.lock().unwrap());
                    });
                }
                gtk::glib::Propagation::Proceed
            });
            true
        }
        super::DesktopMode::Window => {
            gw.connect_map_event(|w, _| {
                apply_mouse_shape(w, *MOCHI_SHAPE.lock().unwrap());
                gtk::glib::Propagation::Proceed
            });
            true
        }
        _ => false,
    }
}

/// Which part of the desktop Stew takes the mouse. Main thread.
pub fn set_desktop_shape(win: &WebviewWindow, shape: super::MouseShape) {
    *MOCHI_SHAPE.lock().unwrap() = shape;
    let Ok(gw) = win.gtk_window() else { return };
    apply_mouse_shape(&gw, shape);
}

fn apply_mouse_shape(gw: &impl IsA<gtk::Widget>, shape: super::MouseShape) {
    use gtk::cairo::{RectangleInt, Region};
    if shape == super::MouseShape::Whole {
        gw.input_shape_combine_region(None);
        return;
    }
    let Some(gdk_window) = gw.window() else { return };
    match shape {
        super::MouseShape::Whole => {}
        super::MouseShape::Empty => {
            let region = Region::create_rectangle(&RectangleInt::new(0, 0, 0, 0));
            gdk_window.input_shape_combine_region(&region, 0, 0);
        }
        super::MouseShape::Disc { cx, cy, r } => {
            // A region is made of rectangles: stack 2 px rows into a disc.
            let region = Region::create_rectangle(&RectangleInt::new(0, 0, 0, 0));
            let mut y = (cy - r).floor();
            while y < cy + r {
                let mid = y + 1.0 - cy;
                let half = (r * r - mid * mid).max(0.0).sqrt();
                let row = RectangleInt::new(
                    (cx - half).floor() as i32,
                    y as i32,
                    (2.0 * half).ceil() as i32,
                    2,
                );
                let _ = region.union_rectangle(&row);
                y += 2.0;
            }
            gdk_window.input_shape_combine_region(&region, 0, 0);
        }
    }
}

/// Layer surface only: puts the top-left corner at (x, y), logical pixels from
/// the display's corner. Main thread.
pub fn set_layer_margins(win: &WebviewWindow, x: f64, y: f64) {
    let Ok(gw) = win.gtk_window() else { return };
    let ptr = gtk_window_ptr(&gw);
    unsafe {
        layer::gtk_layer_set_margin(ptr, layer::EDGE_LEFT, x.round() as i32);
        layer::gtk_layer_set_margin(ptr, layer::EDGE_TOP, y.round() as i32);
    }
}

/// Layer surface only: `on` stretches it over the whole display — how a drag
/// gets exact pointer positions on Wayland, where a surface that moves under
/// the pointer can't tell where it is — and `off` folds it back to Stew's
/// size in the corner. Main thread.
pub fn set_layer_overlay(win: &WebviewWindow, on: bool) {
    let Ok(gw) = win.gtk_window() else { return };
    let ptr = gtk_window_ptr(&gw);
    unsafe {
        layer::gtk_layer_set_anchor(ptr, layer::EDGE_RIGHT, on as i32);
        layer::gtk_layer_set_anchor(ptr, layer::EDGE_BOTTOM, on as i32);
        if on {
            layer::gtk_layer_set_margin(ptr, layer::EDGE_LEFT, 0);
            layer::gtk_layer_set_margin(ptr, layer::EDGE_TOP, 0);
        }
    }
}

/// Layer surface only: puts the desktop Stew on the island's display and
/// returns that display's logical size. Main thread.
pub fn layer_display(island: &WebviewWindow, mochi: &WebviewWindow) -> Option<(f64, f64)> {
    let island_gw = island.gtk_window().ok()?;
    let display = gtk::gdk::Display::default()?;
    let monitor = island_gw
        .window()
        .and_then(|w| display.monitor_at_window(&w))
        .or_else(|| display.primary_monitor())
        .or_else(|| display.monitor(0))?;
    if let Ok(gw) = mochi.gtk_window() {
        unsafe { layer::gtk_layer_set_monitor(gtk_window_ptr(&gw), monitor.to_glib_none().0) };
    }
    let g = monitor.geometry();
    Some((g.width() as f64, g.height() as f64))
}

// ── Background work ───────────────────────────────────────────────────────────

/// Starts a heavy helper (ffmpeg) at a lower priority (nice 10), set in the
/// child before it runs, so every thread it starts inherits it.
pub fn spawn_background(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    no_console(cmd);
    unsafe {
        cmd.pre_exec(|| {
            // nice() may legitimately return -1, so its result is not checked:
            // a helper at normal priority is still better than no helper.
            libc::nice(10);
            Ok(())
        });
    }
    cmd.spawn()
}

// ── Island webview memory ─────────────────────────────────────────────────────

/// WebKitGTK has no memory target to set.
pub fn set_webview_memory_low(_win: &WebviewWindow, _low: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_is_only_preferred_on_gnome_wayland_unless_opted_out() {
        assert!(should_prefer_x11("wayland", "ubuntu:GNOME", "", ":0"));
        assert!(!should_prefer_x11("x11", "ubuntu:GNOME", "", ":0"));
        assert!(!should_prefer_x11("wayland", "KDE", "", ":0"));
        assert!(!should_prefer_x11("wayland", "GNOME", "0", ":0"));
        // No XWayland: keep the Wayland window rather than no display at all.
        assert!(!should_prefer_x11("wayland", "GNOME", "", ""));
    }

    #[test]
    fn text_scaling_is_undone_for_the_island() {
        assert_eq!(dpi_scale_for("1.25\n").as_deref(), Some("0.8"));
        assert_eq!(dpi_scale_for("1.5").as_deref(), Some("0.6667"));
        assert_eq!(dpi_scale_for("1.0").as_deref(), None);
        assert_eq!(dpi_scale_for("").as_deref(), None);
        assert_eq!(dpi_scale_for("nonsense").as_deref(), None);
        assert_eq!(dpi_scale_for("40").as_deref(), None);
    }

    #[test]
    fn private_dirs_are_closed_to_everyone_else() {
        use std::os::unix::fs::MetadataExt;
        let dir = std::env::temp_dir().join(format!("pod-priv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn children_get_the_users_own_gdk_and_gstreamer_settings_back() {
        use std::ffi::{OsStr, OsString};
        let current = |k: &str| -> Option<OsString> {
            match k {
                "GDK_BACKEND" => Some("x11".into()),
                "GDK_DPI_SCALE" => Some("0.8".into()),
                "GST_REGISTRY" => Some("/home/u/.cache/pod/gstreamer-registry.bin".into()),
                "GST_PLUGIN_SYSTEM_PATH_1_0" => Some("/tmp/.mount_PodX/usr/lib/gstreamer-1.0".into()),
                "GST_PLUGIN_SYSTEM_PATH" => Some("/usr/lib/gstreamer-1.0".into()),
                _ => None,
            }
        };
        // Pod forced x11 over the user's wayland, and set the other two itself.
        let inherited = [("GDK_BACKEND", Some(OsString::from("wayland"))), ("GDK_DPI_SCALE", None), ("GST_REGISTRY", None)];
        let fixes = child_env(&inherited, current, Some(OsStr::new("/tmp/.mount_PodX")));
        assert_eq!(fixes, vec![
            ("GDK_BACKEND".to_string(), Some(OsString::from("wayland"))),
            ("GDK_DPI_SCALE".to_string(), None),
            ("GST_REGISTRY".to_string(), None),
            ("GST_PLUGIN_SYSTEM_PATH_1_0".to_string(), None),
        ]);
        // Values the user set and Pod kept (an explicit GDK_DPI_SCALE) stay.
        let kept = [("GDK_BACKEND", Some(OsString::from("x11"))), ("GDK_DPI_SCALE", Some(OsString::from("0.8")))];
        assert!(child_env(&kept, current, None).is_empty());
    }
}
