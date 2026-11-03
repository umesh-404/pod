// Is the notch over someone's window? When the active window reaches the top of
// the island's screen under the notch (maximized, snapped to the top, full
// screen), the island tucks away into a slim lip so it doesn't sit on the
// window's tabs or title bar; hovering the lip or dragging a file onto it brings
// it back. Event-driven: a WinEvent hook on foreground changes and on the
// foreground window moving or resizing, nothing polls. Linux: never covered.

use tauri::AppHandle;

/// Half the width, in logical px, of the band under the notch that counts.
const BAND_HALF_W: f64 = 200.0;
/// How close to the screen's top edge a window's top must be, in physical px
/// (maximized windows sit a few pixels above it).
const TOP_SLACK: i32 = 12;

/// The rule, pure: does `win` (physical rect l, t, r, b) cover the band under the
/// notch on a monitor whose top is `mon_top`, centred on `cx`, `band` px each side?
pub fn covers(win: (i32, i32, i32, i32), mon_top: i32, cx: i32, band: i32) -> bool {
    let (l, t, r, b) = win;
    r > l && b > t && t <= mon_top + TOP_SLACK && b > mon_top + 40 && l < cx + band && r > cx - band
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Emitter;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, TranslateMessage, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, MSG, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static COVERED: AtomicBool = AtomicBool::new(false);

    /// Shell windows that are "the desktop", not someone's window.
    fn is_shell(hwnd: HWND) -> bool {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
        let class = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow" | "XamlExplorerHostIslandWindow")
    }

    fn check() {
        let Some(app) = APP.get() else { return };
        let Some(win) = crate::island::window(app) else { return };
        let Ok(pos) = win.outer_position() else { return };
        let Ok(size) = win.outer_size() else { return };
        let scale = win.scale_factor().unwrap_or(1.0);
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() {
            return;
        }
        // Our own windows (the island, Settings, a dialog) change nothing.
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
        if pid == std::process::id() {
            return;
        }
        let covered = unsafe {
            if !IsWindowVisible(fg).as_bool() || IsIconic(fg).as_bool() || is_shell(fg) {
                false
            } else {
                let cx = pos.x + size.width as i32 / 2;
                let island_mon = MonitorFromPoint(POINT { x: cx, y: pos.y + 1 }, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                let mut r = RECT::default();
                MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) == island_mon
                    && GetMonitorInfoW(island_mon, &mut mi).as_bool()
                    && GetWindowRect(fg, &mut r).is_ok()
                    && covers((r.left, r.top, r.right, r.bottom), mi.rcMonitor.top, cx, (BAND_HALF_W * scale) as i32)
            }
        };
        if COVERED.swap(covered, Ordering::Relaxed) != covered {
            let _ = app.emit("notch-covered", covered);
        }
    }

    unsafe extern "system" fn on_event(_: HWINEVENTHOOK, event: u32, hwnd: HWND, id_object: i32, _: i32, _: u32, _: u32) {
        // Location changes fire for every object of every window: only the foreground window's own frame counts.
        if event == EVENT_OBJECT_LOCATIONCHANGE && (id_object != OBJID_WINDOW.0 || hwnd != unsafe { GetForegroundWindow() }) {
            return;
        }
        check();
    }

    pub fn start(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        let _ = std::thread::Builder::new().name("notch-cover".into()).spawn(|| unsafe {
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            let _a = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_event), 0, 0, flags);
            let _b = SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND - 1, EVENT_SYSTEM_MINIMIZEEND, None, Some(on_event), 0, 0, flags);
            let _c = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, None, Some(on_event), 0, 0, flags);
            check();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    pub fn now() -> bool {
        COVERED.load(Ordering::Relaxed)
    }
}

/// Starts watching (called once from setup); `notch-covered` (bool) on every change.
pub fn start(app: &AppHandle) {
    #[cfg(windows)]
    imp::start(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Whether the notch is over a window right now (the island asks once at start).
#[tauri::command]
pub fn notch_covered() -> bool {
    #[cfg(windows)]
    return imp::now();
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::covers;

    #[test]
    fn a_maximized_window_covers_a_floating_one_does_not() {
        // 2880-wide monitor at the top-left, notch centred at 1440, band ±450.
        assert!(covers((-11, -11, 2891, 1700), 0, 1440, 450), "maximized");
        assert!(covers((0, 0, 1440, 1700), 0, 1440, 450), "snapped left, reaching the middle");
        assert!(!covers((200, 300, 2000, 1500), 0, 1440, 450), "floating below the top");
        assert!(!covers((0, 0, 900, 1700), 0, 1440, 450), "snapped left, short of the notch");
        assert!(!covers((0, 0, 0, 0), 0, 1440, 450), "empty");
        assert!(covers((2880, 370, 4800, 1450), 370, 3840, 450), "second monitor below the first's top");
    }
}
