// Microsoft Edge WebView2, checked before Pod creates its first window.
//
// Every window of Pod is a WebView2 webview on Windows. When the runtime the
// registry names is broken — EdgeUpdate still says version X is installed, but
// `<location>\X\msedgewebview2.exe` is gone — creating the island fails with
// HRESULT 0x80070002, and Pod used to die on a Rust panic without a word.
// Microsoft's own installer then refuses too ("already installed").
//
// So, before the first window: is the runtime the registry names really there?
// If not, a native message box (there is no webview to draw anything else)
// says so in the user's language and offers the repair Windows registered for
// WebView2 itself: the ModifyPath of its Uninstall entry, MicrosoftEdgeUpdate.exe
// with `repairtype=windowsonlinerepair`. It runs through ShellExecuteEx, so
// Windows shows its usual UAC prompt — nothing is ever elevated quietly — and
// Pod waits for it, then looks again. Still broken: Microsoft's download page in
// the browser, if the user wants it. Pod downloads and installs nothing itself,
// and does nothing without asking. Whatever happens, it exits cleanly.
//
// Linux: WebKitGTK is a package dependency; there is nothing to check.
//
// POD_HEAL_WEBVIEW2 forces a result, to see every dialog without breaking
// WebView2: "broken" (the real repair is offered and runs if accepted), "dry"
// (broken, and the repair is only pretended: nothing runs), "missing", or
// "startfail" (the message shown when creating the window fails).

use std::path::{Path, PathBuf};

use crate::i18n::{t, tf};

/// Where to get the runtime by hand, opened only when the user says yes.
pub const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
/// The WebView2 Runtime's id in EdgeUpdate's registry.
const CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// The program the runtime is: what must exist under `<location>\<version>\`.
const RUNTIME_EXE: &str = "msedgewebview2.exe";
/// The only program a registered repair may run.
const UPDATER_EXE: &str = "MicrosoftEdgeUpdate.exe";

/// Installed for the whole machine (Program Files) or for this user (AppData).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Machine,
    User,
}

/// One install the registry names.
#[derive(Clone, Debug, PartialEq)]
pub struct Install {
    pub scope: Scope,
    pub version: String,
    pub exe: PathBuf,
    /// `exe` is there.
    pub found: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Health {
    /// Usable, at this version.
    Ready(String),
    /// The registry names it, the program is gone.
    Broken(Install),
    /// Nothing installed anywhere.
    Missing,
}

/// "156.0.4314.58" → [156, 0, 4314, 58]; None for anything else, and for the
/// "0.0.0.0" EdgeUpdate leaves behind an uninstalled runtime.
pub fn version_numbers(version: &str) -> Option<Vec<u64>> {
    let numbers: Vec<u64> = version.trim().split('.').map(|part| part.parse().ok()).collect::<Option<_>>()?;
    numbers.iter().any(|n| *n > 0).then_some(numbers)
}

/// The runtime's program for a registry entry: `<location>\<version>\msedgewebview2.exe`.
/// `location` may be quoted, may already end in the version, or be missing
/// (older entries): then `fallback`, the usual folder for the install's scope.
pub fn runtime_exe(location: Option<&str>, version: &str, fallback: Option<&Path>) -> Option<PathBuf> {
    let version = version.trim();
    version_numbers(version)?;
    let location = location.map(|l| l.trim().trim_matches('"').trim()).filter(|l| !l.is_empty());
    let base = match location {
        Some(l) => PathBuf::from(l),
        None => fallback?.to_path_buf(),
    };
    if base.file_name().is_some_and(|n| n.eq_ignore_ascii_case(RUNTIME_EXE)) {
        return Some(base);
    }
    if base.file_name().is_some_and(|n| n.to_string_lossy() == version) {
        return Some(base.join(RUNTIME_EXE));
    }
    Some(base.join(version).join(RUNTIME_EXE))
}

/// What the loader will use: the newest registered version wins, so a broken
/// newest install breaks Pod even when an older one is fine. With nothing
/// registered, `loader` (WebView2's own lookup: an Edge preview channel, a
/// fixed-version runtime) has the last word.
pub fn judge(installs: &[Install], loader: impl FnOnce() -> Option<String>) -> Health {
    let newest = installs
        .iter()
        .filter_map(|i| version_numbers(&i.version).map(|v| (v, i)))
        .max_by(|(va, a), (vb, b)| va.cmp(vb).then(a.found.cmp(&b.found)));
    match newest {
        Some((_, install)) if install.found => Health::Ready(install.version.clone()),
        Some((_, install)) => Health::Broken(install.clone()),
        None => loader().filter(|v| !v.trim().is_empty()).map(Health::Ready).unwrap_or(Health::Missing),
    }
}

/// A repair as Windows registered it, split for ShellExecuteEx.
#[derive(Clone, Debug, PartialEq)]
pub struct RepairCommand {
    pub program: PathBuf,
    pub params: String,
    /// A machine-wide repair: asks Windows for permission ("runas", the UAC prompt).
    pub elevate: bool,
}

/// `"C:\…\MicrosoftEdgeUpdate.exe" /install "appguid=…&needsadmin=true…" /installsource offline`
/// (quoted or not) → program and arguments. Anything but EdgeUpdate is refused:
/// the registry is not a place Pod takes programs to run from.
pub fn parse_repair(command: &str) -> Option<RepairCommand> {
    let command = command.trim();
    let (program, params) = if let Some(rest) = command.strip_prefix('"') {
        let end = rest.find('"')?;
        (&rest[..end], &rest[end + 1..])
    } else {
        let lower = command.to_ascii_lowercase();
        let end = lower
            .match_indices(".exe")
            .map(|(i, _)| i + 4)
            .find(|&i| command[i..].chars().next().is_none_or(char::is_whitespace))?;
        (&command[..end], &command[end..])
    };
    let program = PathBuf::from(program.trim());
    if !program.file_name().is_some_and(|n| n.eq_ignore_ascii_case(UPDATER_EXE)) {
        return None;
    }
    let params = params.trim().to_string();
    let elevate = params.to_ascii_lowercase().contains("needsadmin=true");
    Some(RepairCommand { program, params, elevate })
}

/// A forced result (POD_HEAL_WEBVIEW2), to try the dialogs on a healthy machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Force {
    Broken,
    Dry,
    Missing,
    StartFail,
}

fn forced() -> Option<Force> {
    match std::env::var("POD_HEAL_WEBVIEW2").ok()?.trim().to_ascii_lowercase().as_str() {
        "broken" => Some(Force::Broken),
        "dry" => Some(Force::Dry),
        "missing" => Some(Force::Missing),
        "startfail" => Some(Force::StartFail),
        _ => None,
    }
}

/// How WebView2 is on this computer (the health list shows it too, heal.rs).
pub fn detect() -> Health {
    let force = forced();
    if force == Some(Force::Missing) {
        return Health::Missing;
    }
    let health = detect_real();
    match force {
        Some(Force::Broken | Force::Dry) => match health {
            Health::Broken(install) => Health::Broken(install),
            other => Health::Broken(Install {
                scope: Scope::Machine,
                version: match other {
                    Health::Ready(v) => v,
                    _ => "0.0.0.1".into(),
                },
                exe: PathBuf::from(RUNTIME_EXE),
                found: false,
            }),
        },
        _ => health,
    }
}

/// The startup guard, before any webview exists. True: go on and start Pod.
/// False: the user was told what is wrong (and offered the fix), Pod quits.
/// `check` is off when self-repair is switched off: only a forced result runs.
pub fn ensure_ready(check: bool) -> bool {
    let force = forced();
    if force == Some(Force::StartFail) {
        startup_failed("simulated (POD_HEAL_WEBVIEW2=startfail)");
        return false;
    }
    if !cfg!(windows) || (!check && force.is_none()) {
        return true;
    }
    match detect() {
        Health::Ready(_) => true,
        Health::Broken(install) => {
            crate::log::line(format!(
                "webview2: {} is registered ({:?}) but {} is missing",
                install.version,
                install.scope,
                install.exe.display()
            ));
            os::use_system_language();
            offer_repair(&install, force == Some(Force::Dry))
        }
        Health::Missing => {
            crate::log::line("webview2: not installed");
            os::use_system_language();
            offer_download(&t("Pod needs Microsoft Edge WebView2 to show its window, and it isn't installed on this PC."));
            false
        }
    }
}

/// Creating a window failed anyway: a message instead of a panic. The caller exits.
pub fn startup_failed(error: &str) {
    crate::log::line(format!("could not start: {error}"));
    os::use_system_language();
    let lead = format!(
        "{}\n\n{}",
        tf("Pod couldn't open its window: {error}", &[("error", error)]),
        t("This usually means Microsoft Edge WebView2 is damaged or missing.")
    );
    offer_download(&lead);
}

/// "Damaged — repair it?", then the repair, then a second look.
fn offer_repair(install: &Install, dry: bool) -> bool {
    let question = format!(
        "{}\n\n{}",
        tf(
            "Pod needs Microsoft Edge WebView2 to show its window, but WebView2 {version} is damaged on this PC.",
            &[("version", &install.version)]
        ),
        t("Repair it now? Windows will ask for your permission, then Microsoft's own repair runs.")
    );
    if !os::ask(&question, true) {
        crate::log::line("webview2: repair declined, quitting");
        return false;
    }
    let started = if dry {
        crate::log::line("webview2: repair pretended (POD_HEAL_WEBVIEW2=dry), nothing run");
        Ok(())
    } else {
        os::repair_command(install.scope)
            .ok_or_else(|| "no repair registered".to_string())
            .and_then(|command| {
                crate::log::line(format!(
                    "webview2: running the registered repair: {} {}",
                    command.program.display(),
                    command.params
                ));
                os::run_and_wait(&command)
            })
    };
    if let Err(err) = started {
        crate::log::line(format!("webview2: the repair didn't start: {err}"));
        offer_download(&t("The repair couldn't start."));
        return false;
    }
    // EdgeUpdate may finish in a process of its own: a few looks, a few seconds apart.
    for attempt in 0..10 {
        if let Health::Ready(version) = detect() {
            crate::log::line(format!("webview2: repaired, {version} is usable again"));
            return true;
        }
        if attempt < 9 {
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
    crate::log::line("webview2: still broken after the repair");
    offer_download(&t("WebView2 still doesn't work after the repair."));
    false
}

/// `lead`, then "Open Microsoft's download page?" — the browser only on yes.
fn offer_download(lead: &str) {
    let question = format!("{lead}\n\n{}", t("Open Microsoft's WebView2 download page?"));
    if os::ask(&question, false) {
        os::open_download_page();
    }
}

#[cfg(windows)]
mod os {
    use super::{parse_repair, RepairCommand, Scope, CLIENT_GUID};
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};

    /// A string value from the registry, read only.
    pub(crate) fn reg_string(machine: bool, key: &str, value: &str) -> Option<String> {
        let root: HKEY = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
        let (key, value) = (HSTRING::from(key), HSTRING::from(value));
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut bytes = 0u32;
        if unsafe { RegGetValueW(root, &key, &value, flags, None, None, Some(&mut bytes)) } != ERROR_SUCCESS || bytes < 2 {
            return None;
        }
        let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
        let read = unsafe {
            RegGetValueW(root, &key, &value, flags, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes))
        };
        if read != ERROR_SUCCESS {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len])).filter(|s| !s.trim().is_empty())
    }

    fn env_dir(name: &str) -> Option<std::path::PathBuf> {
        std::env::var_os(name).filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
    }

    /// The registry's installs, machine-wide (32-bit view, then native) and per-user.
    pub fn installs() -> Vec<super::Install> {
        let clients = format!(r"Microsoft\EdgeUpdate\Clients\{CLIENT_GUID}");
        let machine_base = env_dir("ProgramFiles(x86)")
            .or_else(|| env_dir("ProgramFiles"))
            .map(|p| p.join(r"Microsoft\EdgeWebView\Application"));
        let user_base = env_dir("LOCALAPPDATA").map(|p| p.join(r"Microsoft\EdgeWebView\Application"));
        let places = [
            (true, format!(r"SOFTWARE\WOW6432Node\{clients}"), Scope::Machine, machine_base.clone()),
            (true, format!(r"SOFTWARE\{clients}"), Scope::Machine, machine_base),
            (false, format!(r"Software\{clients}"), Scope::User, user_base),
        ];
        let mut out = Vec::new();
        for (machine, key, scope, fallback) in places {
            let Some(version) = reg_string(machine, &key, "pv") else { continue };
            let location = reg_string(machine, &key, "location");
            let Some(exe) = super::runtime_exe(location.as_deref(), &version, fallback.as_deref()) else { continue };
            let found = exe.is_file();
            out.push(super::Install { scope, version: version.trim().to_string(), exe, found });
        }
        out
    }

    /// WebView2's own answer: the version the loader would use, if any.
    pub fn loader_version() -> Option<String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
        let mut version = wv2_core::PWSTR::null();
        unsafe { GetAvailableCoreWebView2BrowserVersionString(wv2_core::PCWSTR::null(), &mut version) }.ok()?;
        if version.is_null() {
            return None;
        }
        Some(webview2_com::take_pwstr(version))
    }

    /// The repair Windows registered for WebView2 (Settings → Apps → Modify),
    /// for the install's scope first, then the other one.
    pub fn repair_command(scope: Scope) -> Option<RepairCommand> {
        const ENTRY: &str = r"Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView";
        let machine = [(true, format!(r"SOFTWARE\WOW6432Node\{ENTRY}")), (true, format!(r"SOFTWARE\{ENTRY}"))];
        let user = [(false, format!(r"Software\{ENTRY}"))];
        let order: Vec<(bool, String)> = match scope {
            Scope::Machine => machine.into_iter().chain(user).collect(),
            Scope::User => user.into_iter().chain(machine).collect(),
        };
        order
            .iter()
            .filter_map(|(m, key)| reg_string(*m, key, "ModifyPath"))
            .filter_map(|command| parse_repair(&command))
            .find(|command| command.program.is_file())
    }

    /// Runs the repair through the shell — "runas" for a machine-wide one, so
    /// Windows asks with its own UAC prompt — and waits until it is done.
    pub fn run_and_wait(command: &RepairCommand) -> Result<(), String> {
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let file = HSTRING::from(command.program.as_os_str());
        let params = HSTRING::from(command.params.as_str());
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: if command.elevate { w!("runas") } else { w!("open") },
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        // Declining the UAC prompt lands here too (ERROR_CANCELLED).
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| e.to_string())?;
        if info.hProcess.is_invalid() {
            return Ok(());
        }
        // Half an hour at most: an online repair downloads the runtime again.
        unsafe { WaitForSingleObject(info.hProcess, 30 * 60 * 1000) };
        let mut code = 0u32;
        let _ = unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
        let _ = unsafe { CloseHandle(info.hProcess) };
        crate::log::line(format!("webview2: the repair finished (exit code {code:#x})"));
        Ok(())
    }

    /// A Yes/No message box: no webview is needed to show it. True on Yes.
    /// `warn`: the warning icon, else the information one.
    pub fn ask(text: &str, warn: bool) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_ICONINFORMATION, MB_ICONWARNING, MB_RIGHT, MB_RTLREADING, MB_SETFOREGROUND, MB_YESNO,
        };
        let mut style = MB_YESNO | MB_SETFOREGROUND | if warn { MB_ICONWARNING } else { MB_ICONINFORMATION };
        if crate::i18n::current() == "ar" {
            style |= MB_RTLREADING | MB_RIGHT;
        }
        unsafe { MessageBoxW(None, &HSTRING::from(text), w!("Pod"), style) == IDYES }
    }

    pub fn open_download_page() {
        // The shell wants COM on the thread for a link; Pod quits right after.
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        crate::platform::open_url(super::DOWNLOAD_PAGE);
    }

    /// The messages come before the webview could report the system's
    /// languages (i18n.rs): Windows' own list of display languages instead.
    pub fn use_system_language() {
        use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
        let (mut count, mut len) = (0u32, 0u32);
        if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len) }.is_err() || len == 0 {
            return;
        }
        let mut buffer = vec![0u16; len as usize];
        let got = unsafe {
            GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(windows::core::PWSTR(buffer.as_mut_ptr())), &mut len)
        };
        if got.is_err() {
            return;
        }
        let languages: Vec<String> = buffer
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(String::from_utf16_lossy)
            .collect();
        crate::i18n::set_system(languages);
    }
}

#[cfg(windows)]
fn detect_real() -> Health {
    // A fixed-version runtime picked through the environment wins over everything.
    if let Some(folder) = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").filter(|v| !v.is_empty()) {
        if Path::new(&folder).join(RUNTIME_EXE).is_file() {
            return Health::Ready("fixed".into());
        }
    }
    judge(&os::installs(), os::loader_version)
}

#[cfg(windows)]
pub(crate) use os::reg_string;

#[cfg(not(windows))]
fn detect_real() -> Health {
    Health::Ready(String::new())
}

#[cfg(not(windows))]
mod os {
    use super::{RepairCommand, Scope};

    pub fn repair_command(_scope: Scope) -> Option<RepairCommand> {
        None
    }

    pub fn run_and_wait(_command: &RepairCommand) -> Result<(), String> {
        Err("not on this system".into())
    }

    /// No message box without a toolkit: the terminal and the log say it.
    pub fn ask(text: &str, _warn: bool) -> bool {
        eprintln!("[pod] {text}");
        false
    }

    pub fn open_download_page() {}

    pub fn use_system_language() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(version: &str, found: bool, scope: Scope) -> Install {
        Install { scope, version: version.into(), exe: PathBuf::from("x"), found }
    }

    #[test]
    fn versions_are_numbers_and_never_all_zero() {
        assert_eq!(version_numbers("156.0.4314.58"), Some(vec![156, 0, 4314, 58]));
        assert_eq!(version_numbers(" 120.0.1 "), Some(vec![120, 0, 1]));
        assert_eq!(version_numbers("0.0.0.0"), None);
        assert_eq!(version_numbers(""), None);
        assert_eq!(version_numbers("156.0.beta"), None);
    }

    #[cfg(windows)]
    #[test]
    fn the_runtime_is_found_under_location_and_version() {
        let exe = |l: Option<&str>, f: Option<&str>| runtime_exe(l, "156.0.4314.58", f.map(Path::new));
        let want = PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.4314.58\msedgewebview2.exe");
        assert_eq!(exe(Some(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application"), None), Some(want.clone()));
        // Quoted, with a trailing separator, or already ending in the version.
        assert_eq!(exe(Some(r#""C:\Program Files (x86)\Microsoft\EdgeWebView\Application\""#), None), Some(want.clone()));
        assert_eq!(exe(Some(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.4314.58"), None), Some(want.clone()));
        // No location: the scope's usual folder.
        assert_eq!(exe(None, Some(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application")), Some(want.clone()));
        assert_eq!(exe(Some("  "), Some(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application")), Some(want));
        assert_eq!(exe(None, None), None);
        // A version that isn't one names no program at all.
        assert_eq!(runtime_exe(Some(r"C:\x"), "0.0.0.0", None), None);
    }

    #[test]
    fn the_newest_registered_install_decides() {
        let never = || -> Option<String> { panic!("the loader is asked only when nothing is registered") };
        assert_eq!(judge(&[install("156.0.4314.58", true, Scope::Machine)], never), Health::Ready("156.0.4314.58".into()));
        // Today's failure: registered, program gone.
        let broken = install("156.0.4314.58", false, Scope::Machine);
        assert_eq!(judge(std::slice::from_ref(&broken), never), Health::Broken(broken.clone()));
        // An older per-user copy doesn't save a broken newer machine-wide one…
        assert_eq!(judge(&[broken.clone(), install("150.0.1.2", true, Scope::User)], never), Health::Broken(broken));
        // …but a newer working one is what the loader takes.
        assert_eq!(
            judge(&[install("150.0.1.2", false, Scope::Machine), install("156.0.1.1", true, Scope::User)], never),
            Health::Ready("156.0.1.1".into())
        );
        // The same version in two places: the one that is there.
        assert_eq!(
            judge(&[install("156.0.1.1", false, Scope::Machine), install("156.0.1.1", true, Scope::Machine)], never),
            Health::Ready("156.0.1.1".into())
        );
        // An uninstalled entry ("0.0.0.0") counts as nothing registered.
        assert_eq!(judge(&[install("0.0.0.0", false, Scope::Machine)], || None), Health::Missing);
        assert_eq!(judge(&[], || Some("128.0.1".into())), Health::Ready("128.0.1".into()));
        assert_eq!(judge(&[], || Some(" ".into())), Health::Missing);
    }

    /// What this machine has, read only (cargo test -- --ignored --nocapture).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_this_machine() {
        println!("installs: {:#?}", os::installs());
        println!("loader: {:?}", os::loader_version());
        println!("health: {:?}", detect());
        println!("repair: {:?}", os::repair_command(Scope::Machine));
    }

    #[cfg(windows)]
    #[test]
    fn the_registered_repair_is_split_and_only_edgeupdate_may_run() {
        let quoted = r#""C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe" /install "appguid={F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}&needsadmin=true&repairtype=windowsonlinerepair" /installsource offline"#;
        let cmd = parse_repair(quoted).unwrap();
        assert_eq!(cmd.program, PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe"));
        assert_eq!(
            cmd.params,
            r#"/install "appguid={F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}&needsadmin=true&repairtype=windowsonlinerepair" /installsource offline"#
        );
        assert!(cmd.elevate);
        // Unquoted, spaces in the path, a per-user repair.
        let bare = r"C:\Users\me\AppData\Local\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe /install appguid={F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}&needsadmin=false&repairtype=windowsonlinerepair";
        let cmd = parse_repair(bare).unwrap();
        assert_eq!(cmd.program, PathBuf::from(r"C:\Users\me\AppData\Local\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe"));
        assert!(cmd.params.starts_with("/install appguid="));
        assert!(!cmd.elevate);
        let spaced = r"C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe /install x";
        assert_eq!(parse_repair(spaced).unwrap().params, "/install x");
        // Anything else is not run.
        assert_eq!(parse_repair(r#""C:\Windows\System32\cmd.exe" /c whatever"#), None);
        assert_eq!(parse_repair(r"C:\evil\MicrosoftEdgeUpdate.exe.bat /install"), None);
        assert_eq!(parse_repair(r#""C:\x\MicrosoftEdgeUpdate.exe"#), None);
        assert_eq!(parse_repair(""), None);
    }
}

/// A page whose renderer dies (WebView2 kills one it distrusts, or it crashes)
/// stays on Edge's "This page is having a problem" until Pod restarts. So each
/// window reloads itself instead, at most three times a minute: a page that
/// keeps dying is left alone rather than reloaded in a loop.
pub fn reload_on_crash(win: &tauri::WebviewWindow) {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    let label = win.label().to_string();
    let result = win.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let recent: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let mut kind = Default::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
            {
                crate::log::line(format!("webview {label}: a WebView2 process failed ({})", kind.0));
                return Ok(());
            }
            let mut recent = recent.lock().unwrap_or_else(|e| e.into_inner());
            recent.retain(|t| t.elapsed() < Duration::from_secs(60));
            if recent.len() >= 3 {
                crate::log::line(format!("webview {label}: the page keeps failing, not reloading it again"));
                return Ok(());
            }
            recent.push(Instant::now());
            crate::log::line(format!("webview {label}: the page's renderer stopped ({}), reloading it", kind.0));
            sender.Reload()
        }));
        let mut token = 0i64;
        if let Err(err) = core.add_ProcessFailed(&handler, &mut token) {
            crate::log::line(format!("webview: cannot watch for crashes: {err}"));
        }
    });
    if let Err(err) = result {
        crate::log::line(format!("webview: {err}"));
    }
}
