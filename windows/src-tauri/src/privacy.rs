// Microphone and camera in use, for the notch's privacy dot: which apps hold
// them right now, as Windows records it.
//
// Windows keeps a per-app usage record under
// HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}:
// packaged apps directly under the key (by package family name), desktop apps
// under NonPackaged (by their exe path, `\` written `#`). An app holds the
// device while its LastUsedTimeStop is 0. While watched, one thread sleeps on
// RegNotifyChangeKeyValue for both trees (and a stop event) and emits `privacy`
// only when the lists change. Linux has no such record: empty lists.

use serde::Serialize;
use tauri::AppHandle;

/// Also the `privacy` event payload, sent when it changes.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InUse {
    /// Readable app names ("Teams", "Chrome"…).
    pub mic: Vec<String>,
    pub camera: Vec<String>,
}

#[tauri::command]
pub fn privacy_watch(app: AppHandle, on: bool) {
    #[cfg(windows)]
    win::watch(app, on);
    #[cfg(not(windows))]
    let _ = (app, on);
}

#[tauri::command]
pub fn privacy_now() -> InUse {
    #[cfg(windows)]
    {
        win::read()
    }
    #[cfg(not(windows))]
    {
        InUse::default()
    }
}

// ── Names ─────────────────────────────────────────────────────────────────────

/// Known executables and packages → the name people know them by.
fn known(stem: &str) -> Option<&'static str> {
    Some(match stem.to_ascii_lowercase().as_str() {
        "chrome" => "Chrome",
        "msedge" | "msedgewebview2" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "opera" => "Opera",
        "vivaldi" => "Vivaldi",
        "ms-teams" | "teams" | "msteams" => "Teams",
        "zoom" => "Zoom",
        "slack" => "Slack",
        "discord" => "Discord",
        "obs64" | "obs32" | "obs" => "OBS",
        "skype" => "Skype",
        "webex" | "ciscocollabhost" | "webexhost" => "Webex",
        "windowscamera" => "Camera",
        "windowssoundrecorder" => "Sound Recorder",
        "whatsapp" | "whatsappdesktop" => "WhatsApp",
        "telegram" => "Telegram",
        "signal" => "Signal",
        "claude" => "Claude",
        _ => return None,
    })
}

fn capitalised(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A NonPackaged key name ("C:#Program Files#Google#Chrome#Application#chrome.exe")
/// → a readable app name ("Chrome").
pub fn desktop_app_name(key: &str) -> String {
    let file = key.rsplit(['#', '\\', '/']).next().unwrap_or(key);
    let stem = match file.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("exe") => stem,
        _ => file,
    };
    known(stem).map(str::to_string).unwrap_or_else(|| capitalised(stem))
}

/// A package family name ("MSTeams_8wekyb3d8bbwe", "Microsoft.WindowsCamera_8wekyb3d8bbwe")
/// → a readable app name ("Teams", "Camera").
pub fn packaged_app_name(key: &str) -> String {
    let name = key.split('_').next().unwrap_or(key);
    let last = name.rsplit('.').next().unwrap_or(name);
    known(last).map(str::to_string).unwrap_or_else(|| capitalised(last))
}

/// The exe file name of a NonPackaged key, to recognise Pod itself.
pub fn desktop_exe(key: &str) -> &str {
    key.rsplit(['#', '\\', '/']).next().unwrap_or(key)
}

/// Sorted, without repeats (Chrome and Chrome's helper count once).
fn tidy(mut names: Vec<String>) -> Vec<String> {
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    names
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::Mutex;
    use tauri::Emitter;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegNotifyChangeKeyValue, RegOpenKeyExW, RegQueryValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_NOTIFY, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET, REG_NOTIFY_CHANGE_NAME, REG_QWORD,
        REG_VALUE_TYPE,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects};

    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
    const EVENT: &str = "privacy";

    /// The watcher's stop event (as an integer: HANDLE isn't Send).
    static STOP: Mutex<Option<isize>> = Mutex::new(None);

    struct Key(HKEY);

    impl Key {
        fn open(parent: HKEY, path: &str, access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<Key> {
            let mut out = HKEY::default();
            let err = unsafe { RegOpenKeyExW(parent, &HSTRING::from(path), Some(0), access, &mut out) };
            (err == ERROR_SUCCESS).then_some(Key(out))
        }

        fn subkeys(&self) -> Vec<String> {
            let mut out = Vec::new();
            let mut buf = [0u16; 512];
            for index in 0.. {
                let mut len = buf.len() as u32;
                let err = unsafe {
                    RegEnumKeyExW(self.0, index, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None)
                };
                if err != ERROR_SUCCESS {
                    break;
                }
                out.push(String::from_utf16_lossy(&buf[..len as usize]));
            }
            out
        }

        fn qword(&self, name: &str) -> Option<u64> {
            let mut kind = REG_VALUE_TYPE::default();
            let mut value = 0u64;
            let mut size = 8u32;
            let err = unsafe {
                RegQueryValueExW(
                    self.0,
                    &HSTRING::from(name),
                    None,
                    Some(&mut kind),
                    Some(&mut value as *mut u64 as *mut u8),
                    Some(&mut size),
                )
            };
            (err == ERROR_SUCCESS && kind == REG_QWORD && size == 8).then_some(value)
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    /// In use: a usage record with a start and no stop yet.
    fn in_use(key: &Key) -> bool {
        key.qword("LastUsedTimeStop") == Some(0) && key.qword("LastUsedTimeStart").is_some_and(|t| t != 0)
    }

    fn own_exe() -> Option<String> {
        std::env::current_exe().ok()?.file_name().map(|n| n.to_string_lossy().to_lowercase())
    }

    fn apps(capability: &str, own: Option<&str>) -> Vec<String> {
        let path = format!(r"{STORE}\{capability}");
        let Some(root) = Key::open(HKEY_CURRENT_USER, &path, KEY_READ) else { return Vec::new() };
        let mut names = Vec::new();
        for sub in root.subkeys() {
            if sub.eq_ignore_ascii_case("NonPackaged") {
                let Some(np) = Key::open(root.0, &sub, KEY_READ) else { continue };
                for exe in np.subkeys() {
                    if own.is_some_and(|own| desktop_exe(&exe).eq_ignore_ascii_case(own)) {
                        continue;
                    }
                    if Key::open(np.0, &exe, KEY_READ).is_some_and(|k| in_use(&k)) {
                        names.push(desktop_app_name(&exe));
                    }
                }
            } else if Key::open(root.0, &sub, KEY_READ).is_some_and(|k| in_use(&k)) {
                names.push(packaged_app_name(&sub));
            }
        }
        tidy(names)
    }

    pub fn read() -> InUse {
        let own = own_exe();
        InUse { mic: apps("microphone", own.as_deref()), camera: apps("webcam", own.as_deref()) }
    }

    pub fn watch(app: AppHandle, on: bool) {
        let mut stop = STOP.lock().unwrap_or_else(|e| e.into_inner());
        if !on {
            if let Some(h) = stop.take() {
                // The thread closes the handle on its way out.
                unsafe {
                    let _ = SetEvent(HANDLE(h as *mut _));
                }
            }
            return;
        }
        if stop.is_some() {
            return;
        }
        let Ok(event) = (unsafe { CreateEventW(None, true, false, PCWSTR::null()) }) else { return };
        let raw = event.0 as isize;
        let spawned = std::thread::Builder::new().name("pod-privacy".into()).spawn(move || listen(app, raw));
        match spawned {
            Ok(_) => *stop = Some(raw),
            Err(err) => {
                crate::log::line(format!("privacy: no watcher thread: {err}"));
                unsafe {
                    let _ = CloseHandle(event);
                }
            }
        }
    }

    fn listen(app: AppHandle, stop_raw: isize) {
        let stop = HANDLE(stop_raw as *mut _);
        // One key and one auto-reset event per device; only the key that
        // fired is armed again, so registrations never pile up.
        let mut watched: Vec<(Key, HANDLE)> = Vec::new();
        for capability in ["microphone", "webcam"] {
            let path = format!(r"{STORE}\{capability}");
            let Some(key) = Key::open(HKEY_CURRENT_USER, &path, KEY_READ | KEY_NOTIFY) else { continue };
            let Ok(event) = (unsafe { CreateEventW(None, false, false, PCWSTR::null()) }) else { continue };
            arm(&key, event);
            watched.push((key, event));
        }
        let mut handles = vec![stop];
        handles.extend(watched.iter().map(|(_, e)| *e));
        let mut last: Option<InUse> = None;
        loop {
            let now = read();
            if last.as_ref() != Some(&now) {
                let _ = app.emit(EVENT, &now);
                last = Some(now);
            }
            // The registry's change notifications come late or not at all for these
            // keys, so the watcher also reads again every RECHECK_MS (≈1.8 ms a read).
            // It only runs while the notch is on screen (the island turns it off when
            // hidden), and it emits only on a change.
            let woke = unsafe { WaitForMultipleObjects(&handles, false, RECHECK_MS) };
            if woke == WAIT_TIMEOUT {
                continue;
            }
            let index = woke.0.wrapping_sub(WAIT_OBJECT_0.0) as usize;
            match index {
                1.. if index < handles.len() => {
                    let (key, event) = &watched[index - 1];
                    arm(key, *event);
                }
                // The stop event, or a failed wait: end.
                _ => break,
            }
        }
        for (key, event) in watched {
            drop(key);
            unsafe {
                let _ = CloseHandle(event);
            }
        }
        // Ended on its own (not by watch(false)): let the next watch(true) start again.
        {
            let mut slot = STOP.lock().unwrap_or_else(|e| e.into_inner());
            if *slot == Some(stop_raw) {
                *slot = None;
            }
        }
        unsafe {
            let _ = CloseHandle(stop);
        }
    }

    /// How often the registry is read again while watching, notification or not.
    const RECHECK_MS: u32 = 1_500;

    fn arm(key: &Key, event: HANDLE) {
        unsafe {
            let _ = RegNotifyChangeKeyValue(
                key.0,
                true,
                REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_CHANGE_NAME,
                Some(event),
                true,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn how_long_a_read_takes() {
        let t = std::time::Instant::now();
        for _ in 0..200 {
            std::hint::black_box(win::read());
        }
        println!("privacy read: {:?} each", t.elapsed() / 200);
    }

    #[test]
    fn desktop_app_paths_become_names() {
        assert_eq!(desktop_app_name("C:#Program Files#Google#Chrome#Application#chrome.exe"), "Chrome");
        assert_eq!(desktop_app_name("C:#Users#me#AppData#Local#Microsoft#Teams#current#Teams.exe"), "Teams");
        assert_eq!(desktop_app_name("C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe"), "Microsoft Edge");
        assert_eq!(desktop_app_name("C:#Tools#audacity.exe"), "Audacity");
        assert_eq!(desktop_app_name("D:#odd#noext"), "Noext");
        assert_eq!(desktop_exe("C:#Program Files#Pod#pod.exe"), "pod.exe");
    }

    #[test]
    fn package_family_names_become_names() {
        assert_eq!(packaged_app_name("MSTeams_8wekyb3d8bbwe"), "Teams");
        assert_eq!(packaged_app_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "Camera");
        assert_eq!(packaged_app_name("Claude_pzs8sxrjxfjjc"), "Claude");
        assert_eq!(packaged_app_name("AD2F1837.myHP_v10z8vjag6ke6"), "MyHP");
    }

    #[test]
    fn names_are_sorted_once() {
        assert_eq!(tidy(vec!["Zoom".into(), "chrome".into(), "Chrome".into()]), vec!["chrome", "Zoom"]);
    }

    #[cfg(windows)]
    #[test]
    fn reading_the_consent_store_does_not_fail() {
        let _ = privacy_now();
    }
}
