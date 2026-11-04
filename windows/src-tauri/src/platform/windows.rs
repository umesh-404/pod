// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::BOOL;
use ::windows::Win32::Foundation::{HWND, LPARAM, POINT};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyboardLayoutList, HKL, VK_LBUTTON};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW,
    GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Pod — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Pod")
}

/// %LOCALAPPDATA%\Pod — where the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Pod")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

// Links, files and folders open through the shell's own API, never by
// spawning rundll32 or explorer.exe: launching system programs to run things is
// what malware does, and antivirus heuristics treat Pod as such when it does too.

/// A web link (callers check it is http/https) or a shelf file, with its default app.
pub fn open_url(url: &str) {
    shell_execute(windows::core::w!("open"), url);
}

/// A folder in File Explorer. The "explore" verb opens folders only, so a path
/// that turned out to be a program is never run.
pub fn reveal_folder(path: &str) {
    shell_execute(windows::core::w!("explore"), path);
}

fn shell_execute(verb: windows::core::PCWSTR, target: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let result = unsafe { ShellExecuteW(None, verb, &HSTRING::from(target), None, None, SW_SHOWNORMAL) };
    // ShellExecute reports success with a value above 32.
    if (result.0 as isize) <= 32 {
        crate::log::line(format!("shell: couldn't open {target} ({})", result.0 as isize));
    }
}

/// A file selected in its folder in File Explorer ("Show in folder").
pub fn reveal_file(path: &std::path::Path) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    unsafe {
        let item = ILCreateFromPathW(&HSTRING::from(path.as_os_str()));
        if item.is_null() {
            return Err(crate::i18n::t("This file is no longer there."));
        }
        let shown = SHOpenFolderAndSelectItems(item, None, 0);
        ILFree(Some(item));
        shown.map_err(|e| e.to_string())
    }
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Keeps the settings window from showing the "no drop" cursor.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything.
/// Revoking it makes OLE fall through to wry's target. The island is the other
/// way round: it takes drops through WebView2's own target (see webview_drop.rs),
/// so its windows are left alone.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else { return };
    let Some(hwnd) = hwnd_of(&win) else { return };
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

/// The cursor poll already parks itself with the island (island.rs): nothing to do.
pub fn set_pointer_watch(_active: bool) {}

/// `set_position` already places a Win32 window on the right display.
pub fn pin_to_monitor(_win: &WebviewWindow, _x: i32, _y: i32) {}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// RegisterHotKey works in every Windows session.
pub fn global_shortcuts_blocked() -> Option<&'static str> {
    None
}

/// The character Ctrl+Alt(+Shift)+`vk` types on one of the installed keyboard
/// layouts, if any. Windows reads Ctrl+Alt as AltGr, so registering such a
/// combination as a global shortcut would stop the user typing that character
/// (AltGr+E is € on most European layouts, AltGr+A is ą in Polish).
///
/// The installed layouts come from GetKeyboardLayoutList; what their AltGr
/// layer types comes from the table below, not from asking Windows to
/// translate keys (ToUnicodeEx). Global key state plus key translation is the
/// fingerprint antivirus heuristics look for in keyloggers, and Pod must not
/// look like one. Layouts outside the table are taken to type nothing on
/// AltGr, which is true of the US, UK and most non-Latin layouts.
pub fn ctrl_alt_types(vk: u16, shift: bool) -> Option<String> {
    let mut layouts = [HKL::default(); 32];
    let count = unsafe { GetKeyboardLayoutList(Some(&mut layouts[..])) };
    let count = usize::try_from(count).unwrap_or(0).min(layouts.len());
    layouts[..count].iter().find_map(|hkl| {
        // The language id is the low word; its primary language the low 10 bits.
        let primary = (hkl.0 as usize & 0x3FF) as u16;
        altgr_char(primary, vk, shift).map(str::to_string)
    })
}

/// What AltGr(+Shift)+`vk` types on the main layout of a primary language
/// (LANG_* ids), for the European layouts that put characters there.
pub(crate) fn altgr_char(primary_lang: u16, vk: u16, shift: bool) -> Option<&'static str> {
    // Virtual-key codes: letters and digits are their ASCII codes; OEM keys by name.
    const OEM_1: u16 = 0xBA; // ;: (US position)
    const OEM_PLUS: u16 = 0xBB;
    const OEM_COMMA: u16 = 0xBC;
    const OEM_PERIOD: u16 = 0xBE;
    const OEM_2: u16 = 0xBF;
    const OEM_3: u16 = 0xC0;
    const OEM_4: u16 = 0xDB;
    const OEM_5: u16 = 0xDC;
    const OEM_7: u16 = 0xDE;
    const OEM_102: u16 = 0xE2;
    let k = |c: char| c as u16;
    let table: &[(u16, &str)] = match (primary_lang, shift) {
        // German (QWERTZ)
        (0x07, false) => &[(k('Q'), "@"), (k('E'), "€"), (k('M'), "µ"), (k('2'), "²"), (k('3'), "³"), (k('7'), "{"),
            (k('8'), "["), (k('9'), "]"), (k('0'), "}"), (OEM_4, "\\"), (OEM_PLUS, "~"), (OEM_102, "|")],
        // French (AZERTY)
        (0x0C, false) => &[(k('E'), "€"), (k('2'), "~"), (k('3'), "#"), (k('4'), "{"), (k('5'), "["), (k('6'), "|"),
            (k('7'), "`"), (k('8'), "\\"), (k('9'), "^"), (k('0'), "@"), (OEM_4, "]"), (OEM_PLUS, "}")],
        // Spanish
        (0x0A, false) => &[(k('E'), "€"), (k('1'), "|"), (k('2'), "@"), (k('3'), "#"), (k('4'), "~"), (k('6'), "¬"),
            (OEM_3, "\\"), (OEM_1, "["), (OEM_PLUS, "]"), (OEM_7, "{"), (OEM_2, "}")],
        // Italian
        (0x10, false) => &[(k('E'), "€"), (OEM_1, "["), (OEM_PLUS, "]"), (OEM_3, "@"), (OEM_7, "#")],
        (0x10, true) => &[(OEM_1, "{"), (OEM_PLUS, "}")],
        // Portuguese
        (0x16, false) => &[(k('E'), "€"), (k('2'), "@"), (k('3'), "£"), (k('4'), "§"), (k('7'), "{"), (k('8'), "["),
            (k('9'), "]"), (k('0'), "}")],
        // Polish (Programmers)
        (0x15, false) => &[(k('A'), "ą"), (k('C'), "ć"), (k('E'), "ę"), (k('L'), "ł"), (k('N'), "ń"), (k('O'), "ó"),
            (k('S'), "ś"), (k('X'), "ź"), (k('Z'), "ż")],
        (0x15, true) => &[(k('A'), "Ą"), (k('C'), "Ć"), (k('E'), "Ę"), (k('L'), "Ł"), (k('N'), "Ń"), (k('O'), "Ó"),
            (k('S'), "Ś"), (k('X'), "Ź"), (k('Z'), "Ż")],
        // Czech, Slovak
        (0x05 | 0x1B, false) => &[(k('Q'), "\\"), (k('W'), "|"), (k('E'), "€"), (k('F'), "["), (k('G'), "]"),
            (k('X'), "#"), (k('C'), "&"), (k('V'), "@"), (k('B'), "{"), (k('N'), "}"), (OEM_COMMA, "<"),
            (OEM_PERIOD, ">"), (OEM_2, "*"), (OEM_102, "\\")],
        // Hungarian
        (0x0E, false) => &[(k('Q'), "\\"), (k('W'), "|"), (k('E'), "Ä"), (k('F'), "["), (k('G'), "]"), (k('V'), "@"),
            (k('B'), "{"), (k('N'), "}"), (k('X'), "#"), (k('C'), "&"), (OEM_COMMA, ";"), (OEM_PERIOD, ">")],
        // Swedish, Norwegian, Danish, Finnish
        (0x1D | 0x14 | 0x06 | 0x0B, false) => &[(k('E'), "€"), (k('M'), "µ"), (k('2'), "@"), (k('3'), "£"),
            (k('4'), "$"), (k('7'), "{"), (k('8'), "["), (k('9'), "]"), (k('0'), "}"), (OEM_PLUS, "\\"),
            (OEM_102, "|")],
        // Turkish (Q)
        (0x1F, false) => &[(k('Q'), "@"), (k('E'), "€"), (k('7'), "{"), (k('8'), "["), (k('9'), "]"), (k('0'), "}"),
            (OEM_5, "|")],
        // Belgian and Swiss French/German share their language ids with French/German above.
        _ => &[],
    };
    table.iter().find(|(key, _)| *key == vk).map(|(_, c)| *c)
}

// ── Desktop Stew window ──────────────────────────────────────────────────────

/// Windows places a window wherever it is asked, and the cursor poll is there.
pub fn desktop_mode() -> super::DesktopMode {
    super::DesktopMode::Poll
}

/// Same window styles as the island: never takes focus, never in Alt-Tab (it
/// is created without a taskbar button).
pub fn prepare_desktop_window(win: &WebviewWindow, _mode: super::DesktopMode) -> bool {
    make_non_activating(win);
    true
}

/// The cursor poll toggles WS_EX_TRANSPARENT from the body hit test instead.
pub fn set_desktop_shape(_win: &WebviewWindow, _shape: super::MouseShape) {}

/// Layer-shell only (Linux).
pub fn set_layer_margins(_win: &WebviewWindow, _x: f64, _y: f64) {}

/// Layer-shell only (Linux).
pub fn set_layer_overlay(_win: &WebviewWindow, _on: bool) {}

/// Layer-shell only (Linux): the logical size of the display the island is on.
pub fn layer_display(_island: &WebviewWindow, _mochi: &WebviewWindow) -> Option<(f64, f64)> {
    None
}

// ── Background work ───────────────────────────────────────────────────────────

/// Starts a heavy helper (ffmpeg) so it never makes the rest of the PC sluggish:
/// below-normal priority, no console, and EcoQoS ("efficiency mode"), which lets
/// Windows run it on efficient cores at an efficient clock. Older Windows
/// versions that don't know EcoQoS just keep the lower priority.
pub fn spawn_background(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    use ::windows::Win32::Foundation::HANDLE;
    use ::windows::Win32::System::Threading::{
        ProcessPowerThrottling, SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE,
    };
    use std::os::windows::io::AsRawHandle;

    cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS.0);
    let child = cmd.spawn()?;
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    };
    let handle = HANDLE(child.as_raw_handle());
    unsafe {
        let _ = SetProcessInformation(
            handle,
            ProcessPowerThrottling,
            &state as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
    Ok(child)
}

// ── Island webview memory ─────────────────────────────────────────────────────

/// Asks WebView2 to trim its memory while the island is hidden or compact
/// (`low`), and to keep it normal while it is open. WebView2 older than the
/// 1.0.1774 runtime has no such setting: then nothing happens.
pub fn set_webview_memory_low(win: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use wv2_core::Interface;

    let _ = win.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(core) = core.cast::<ICoreWebView2_19>() else { return };
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        let _ = core.SetMemoryUsageTargetLevel(level);
    });
}

#[cfg(test)]
mod altgr_tests {
    use super::altgr_char;

    #[test]
    fn the_altgr_table_knows_the_usual_clashes() {
        assert_eq!(altgr_char(0x07, 'E' as u16, false), Some("€"));
        assert_eq!(altgr_char(0x07, 'Q' as u16, false), Some("@"));
        assert_eq!(altgr_char(0x15, 'S' as u16, false), Some("ś"));
        assert_eq!(altgr_char(0x15, 'S' as u16, true), Some("Ś"));
        // US English and Space: nothing on AltGr.
        assert_eq!(altgr_char(0x09, 'E' as u16, false), None);
        assert_eq!(altgr_char(0x07, 0x20, false), None);
    }
}
