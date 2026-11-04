// Self-repair: Pod checks its own parts and quietly fixes what broke.
//
// What is Pod's own is repaired without asking, and every repair goes to
// pod.log and to Settings → General → Health. What belongs to Windows or to
// another program is only reported here: the startup entry (re-registering it
// at launch looks like malware persisting, see lib.rs), and WebView2, which is
// checked before the first window and repaired only when the user says so
// (webview_check.rs).
//
// When: at launch (the update schedule's first tick, 30 s in), then every 6
// hours, and then only while the user is away and no job works on files. It
// rides on update.rs' hourly tick: no timer of its own, nothing runs in
// between. "Check now" in Settings runs it at once. Switched off (Settings →
// Features → Self-repair), it runs only on "Check now".
//
// The checks:
//   * the shelf folder: missing → created again, as every drop action would;
//     on a drive that isn't connected → said, never moved anywhere else;
//   * settings.json: unusable → kept aside (settings.rs' own copy), and the
//     settings in use written again;
//   * the ffmpeg Pod downloaded (only that one): no longer a program → removed,
//     so Settings offers the download again. Pod never downloads it by itself,
//     and a copy that merely doesn't answer is reported, not removed;
//   * leftovers of Pod's own, recognised by their exact names: an interrupted
//     ffmpeg download, an earlier run's update downloads, the temporary files
//     of settings, update, reminder and note saves, inbox copies past a week;
//   * the startup entry and WebView2: reported only.
// Nothing the user named is ever deleted, and nothing is overwritten.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::{t, tf};

/// The feature's id in `disabledFeatures` (src/settings/catalog.ts).
pub const FEATURE: &str = "heal";
/// Between two automatic checks.
const INTERVAL: i64 = 6 * 3600;
/// How long the keyboard and mouse must have been still for an automatic check.
const AWAY: Duration = Duration::from_secs(5 * 60);
/// A temporary file of Pod's this old belongs to no save still going on.
const STALE: Duration = Duration::from_secs(3600);
/// Smaller than this, the downloaded ffmpeg can't be a whole program (it weighs ~100 MB).
const MIN_PROGRAM: u64 = 1024 * 1024;
/// Repairs Settings lists, newest first.
const MAX_REPAIRS: usize = 20;

/// Self-repair is on unless switched off in Settings → Features.
pub fn enabled(settings: &crate::settings::Settings) -> bool {
    !settings.disabled_features.iter().any(|f| f == FEATURE)
}

// ── What a check found ────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Check {
    Workspace,
    Settings,
    Ffmpeg,
    Leftovers,
    Autostart,
    Webview,
}

impl Check {
    fn id(self) -> &'static str {
        match self {
            Check::Workspace => "workspace",
            Check::Settings => "settings",
            Check::Ffmpeg => "ffmpeg",
            Check::Leftovers => "leftovers",
            Check::Autostart => "autostart",
            Check::Webview => "webview2",
        }
    }

    fn title(self) -> String {
        match self {
            Check::Workspace => t("Shelf folder"),
            Check::Settings => t("Settings file"),
            Check::Ffmpeg => "ffmpeg".into(),
            Check::Leftovers => t("Leftover files"),
            Check::Autostart => t("Launch at startup"),
            Check::Webview => "Microsoft Edge WebView2".into(),
        }
    }
}

/// What a check has to say, kept apart from its words: Settings asks in the
/// language of the moment.
#[derive(Clone, Debug, PartialEq)]
enum Note {
    FolderCreated(String),
    FolderOffline(String),
    FolderIsFile(String),
    FolderCannotCreate(String, String),
    SettingsRewritten(String),
    SettingsUnreadable(String),
    FfmpegRemoved,
    FfmpegCannotRemove(String),
    FfmpegNoAnswer,
    FfmpegChosenGone(String),
    LeftoversRemoved(usize),
    Busy,
    AutostartStale(String),
    AutostartBlocked,
    AutostartLeftover,
    WebviewVersion(String),
    WebviewBroken(String),
    WebviewMissing,
}

impl Note {
    fn text(&self) -> String {
        match self {
            Note::FolderCreated(dir) => tf("Created the shelf folder again: {dir}", &[("dir", dir)]),
            Note::FolderOffline(dir) => tf("The shelf folder is on a drive that isn't connected: {dir}", &[("dir", dir)]),
            Note::FolderIsFile(dir) => tf("The shelf folder's path is taken by a file: {dir}", &[("dir", dir)]),
            Note::FolderCannotCreate(dir, error) => {
                tf("Couldn't create the shelf folder {dir}: {error}", &[("dir", dir), ("error", error)])
            }
            Note::SettingsRewritten(name) => tf(
                "settings.json was damaged. It was kept as {name} and your current settings were written again.",
                &[("name", name)],
            ),
            Note::SettingsUnreadable(error) => tf("settings.json can't be read: {error}", &[("error", error)]),
            Note::FfmpegRemoved => t("The downloaded ffmpeg was damaged and was removed. Download it again in Settings → General."),
            Note::FfmpegCannotRemove(error) => {
                tf("The downloaded ffmpeg is damaged and couldn't be removed: {error}", &[("error", error)])
            }
            Note::FfmpegNoAnswer => t("The downloaded ffmpeg didn't answer when tested."),
            Note::FfmpegChosenGone(path) => tf("The ffmpeg you chose is no longer there: {path}", &[("path", path)]),
            Note::LeftoversRemoved(n) => tf("Leftover files removed: {count}", &[("count", &n.to_string())]),
            Note::Busy => t("Skipped while Pod is working on your files."),
            Note::AutostartStale(path) => tf("Launch at startup points to another copy of Pod: {path}", &[("path", path)]),
            Note::AutostartBlocked => t("Launch at startup is on, but the system won't start Pod. Check the startup apps in your system settings."),
            Note::AutostartLeftover => t("A startup entry is left although Launch at startup is off."),
            Note::WebviewVersion(version) => version.clone(),
            Note::WebviewBroken(version) => tf("WebView2 {version} is damaged: a file is missing.", &[("version", version)]),
            Note::WebviewMissing => t("WebView2 isn't installed."),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Ok,
    /// Fine, with something worth showing (a version).
    Info(Note),
    Repaired(Note),
    /// Something Pod can't or mustn't fix itself.
    Warning(Note),
    Skipped(Note),
}

impl Outcome {
    fn status(&self) -> &'static str {
        match self {
            Outcome::Ok | Outcome::Info(_) => "ok",
            Outcome::Repaired(_) => "repaired",
            Outcome::Warning(_) => "warning",
            Outcome::Skipped(_) => "skipped",
        }
    }

    fn note(&self) -> Option<&Note> {
        match self {
            Outcome::Ok => None,
            Outcome::Info(n) | Outcome::Repaired(n) | Outcome::Warning(n) | Outcome::Skipped(n) => Some(n),
        }
    }
}

// ── State, and what Settings sees ─────────────────────────────────────────────

struct State {
    /// Unix seconds of the last finished check.
    last: Option<i64>,
    running: bool,
    results: Vec<(Check, Outcome)>,
    /// (unix seconds, what was repaired), newest first.
    repairs: VecDeque<(i64, Note)>,
}

static STATE: Mutex<State> = Mutex::new(State { last: None, running: false, results: Vec::new(), repairs: VecDeque::new() });

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    id: &'static str,
    title: String,
    /// "ok", "repaired", "warning" or "skipped".
    status: &'static str,
    detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepairView {
    /// Milliseconds since the epoch, for `new Date()`.
    at: i64,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    enabled: bool,
    checking: bool,
    /// Milliseconds since the epoch; None before the first check.
    last_check: Option<i64>,
    checks: Vec<CheckView>,
    repairs: Vec<RepairView>,
}

fn report(app: &AppHandle) -> HealthReport {
    let on = enabled(&app.state::<crate::Shared>().settings.lock().unwrap_or_else(PoisonError::into_inner));
    let s = state();
    HealthReport {
        enabled: on,
        checking: s.running,
        last_check: s.last.map(|secs| secs * 1000),
        checks: s
            .results
            .iter()
            .map(|(check, outcome)| CheckView {
                id: check.id(),
                title: check.title(),
                status: outcome.status(),
                detail: outcome.note().map(Note::text).unwrap_or_default(),
            })
            .collect(),
        repairs: s.repairs.iter().map(|(at, note)| RepairView { at: at * 1000, text: note.text() }).collect(),
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("heal-status", report(app));
}

fn now() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/// Whether an automatic check is due. The first one (at launch) needs only
/// self-repair on and no job running; the next ones also wait 6 hours, for the
/// user to be away, and for the tray's Pause to be off. A clock set back
/// counts as due rather than waiting for the old time to come round again.
fn due(last: Option<i64>, now: i64, on: bool, busy: bool, paused: bool, idle: Duration) -> bool {
    if !on || busy {
        return false;
    }
    match last {
        None => true,
        Some(last) => !paused && (now - last >= INTERVAL || now < last) && idle >= AWAY,
    }
}

/// update.rs' hourly tick (and its first one, 30 s after launch).
pub fn tick(app: &AppHandle) {
    let on = enabled(&app.state::<crate::Shared>().settings.lock().unwrap_or_else(PoisonError::into_inner));
    let last = state().last;
    let paused = crate::update::PAUSED.load(std::sync::atomic::Ordering::Relaxed);
    if !due(last, now(), on, crate::files::busy(), paused, crate::update::idle_for()) {
        return;
    }
    let app = app.clone();
    // The launch check skips `ffmpeg -version`: nothing is spawned while Pod starts.
    let deep = last.is_some();
    tauri::async_runtime::spawn_blocking(move || run(&app, deep));
}

/// Clears `running` however the checks end.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        state().running = false;
    }
}

/// Every check, one after the other. `deep`: also run the downloaded ffmpeg once.
fn run(app: &AppHandle, deep: bool) {
    {
        let mut s = state();
        if s.running {
            return;
        }
        s.running = true;
    }
    let guard = Running;
    changed(app);
    let busy = crate::files::busy();
    let mut results = vec![
        (Check::Workspace, check_workspace(app)),
        (Check::Settings, check_settings(app)),
        (Check::Ffmpeg, check_ffmpeg(app, deep, busy)),
        (Check::Leftovers, check_leftovers(app, busy)),
        (Check::Autostart, check_autostart(app)),
    ];
    if cfg!(windows) {
        results.push((Check::Webview, check_webview()));
    }
    let at = now();
    {
        let mut s = state();
        for (_, outcome) in &results {
            if let Outcome::Repaired(note) = outcome {
                s.repairs.push_front((at, note.clone()));
            }
        }
        s.repairs.truncate(MAX_REPAIRS);
        s.results = results;
        s.last = Some(at);
    }
    drop(guard);
    changed(app);
}

// ── The checks ────────────────────────────────────────────────────────────────

fn current_settings(app: &AppHandle) -> crate::settings::Settings {
    app.state::<crate::Shared>().settings.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

/// Where a removable drive or a network share is mounted for `path`: the drive
/// or share root on Windows ("E:\", "\\server\share\"); /media/<user>/<label>,
/// /run/media/<user>/<label> or /mnt/<name> on Linux. None for anything else.
fn mount_point(path: &Path) -> Option<&Path> {
    let chain: Vec<&Path> = path.ancestors().collect();
    let root = *chain.last()?;
    if root != Path::new("/") {
        return (root != path).then_some(root);
    }
    let text = path.to_string_lossy();
    let depth = if text.starts_with("/run/media/") {
        5
    } else if text.starts_with("/media/") {
        4
    } else if text.starts_with("/mnt/") {
        3
    } else {
        return None;
    };
    chain.into_iter().find(|p| p.components().count() == depth && *p != path)
}

/// The folder sits on a drive or share that isn't there right now.
fn drive_missing(path: &Path, exists: impl Fn(&Path) -> bool) -> bool {
    mount_point(path).is_some_and(|mount| !exists(mount))
}

fn check_workspace(app: &AppHandle) -> Outcome {
    let ws = crate::workspace::dir(app);
    let shown = ws.to_string_lossy().to_string();
    match std::fs::metadata(&ws) {
        Ok(meta) if meta.is_dir() => Outcome::Ok,
        Ok(_) => Outcome::Warning(Note::FolderIsFile(shown)),
        // Pod never picks another folder by itself: moving the shelf is the user's call.
        Err(_) if drive_missing(&ws, Path::exists) => Outcome::Warning(Note::FolderOffline(shown)),
        Err(_) => match std::fs::create_dir_all(&ws) {
            Ok(()) => {
                crate::log::line(format!("heal: the shelf folder was missing, created it again: {shown}"));
                Outcome::Repaired(Note::FolderCreated(shown))
            }
            Err(err) => Outcome::Warning(Note::FolderCannotCreate(shown, err.to_string())),
        },
    }
}

fn check_settings(app: &AppHandle) -> Outcome {
    use crate::settings::FileState;
    match crate::settings::file_state() {
        FileState::Missing | FileState::Usable => Outcome::Ok,
        FileState::Unreadable(err) => Outcome::Warning(Note::SettingsUnreadable(err)),
        FileState::Unusable => match crate::settings::repair(&current_settings(app)) {
            Ok(Some(copy)) => {
                crate::log::line(format!("heal: settings.json was unusable, kept as {} and written again", copy.display()));
                let name = copy.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                Outcome::Repaired(Note::SettingsRewritten(name))
            }
            Ok(None) => Outcome::Ok,
            Err(err) => Outcome::Warning(Note::SettingsUnreadable(err.to_string())),
        },
    }
}

/// The first bytes of a program: "MZ" on Windows, ELF elsewhere.
const PROGRAM_MAGIC: &[u8] = if cfg!(windows) { b"MZ" } else { b"\x7fELF" };

/// Whether a file of `len` bytes starting with `head` can still be the program.
fn looks_like_program(len: u64, head: &[u8], magic: &[u8]) -> bool {
    len >= MIN_PROGRAM && head.starts_with(magic)
}

fn check_ffmpeg(app: &AppHandle, deep: bool, busy: bool) -> Outcome {
    let chosen = current_settings(app).ffmpeg_path.trim().to_string();
    let chosen_gone = !chosen.is_empty() && !Path::new(&chosen).is_file();
    let gone_or_ok = || if chosen_gone { Outcome::Warning(Note::FfmpegChosenGone(chosen.clone())) } else { Outcome::Ok };
    // Being downloaded right now: the download checks it itself.
    if crate::convert::ffmpeg_downloading() {
        return Outcome::Ok;
    }
    let path = crate::convert::downloaded_ffmpeg();
    let Ok(meta) = std::fs::metadata(&path) else { return gone_or_ok() };
    let mut head = [0u8; 4];
    let read = std::fs::File::open(&path).and_then(|mut f| std::io::Read::read(&mut f, &mut head));
    let head = &head[..read.unwrap_or(0)];
    if !meta.is_file() || !looks_like_program(meta.len(), head, PROGRAM_MAGIC) {
        if busy {
            return Outcome::Skipped(Note::Busy);
        }
        return match std::fs::remove_file(&path) {
            Ok(()) => {
                crate::log::line(format!("heal: removed a damaged ffmpeg ({} bytes) at {}", meta.len(), path.display()));
                Outcome::Repaired(Note::FfmpegRemoved)
            }
            Err(err) => Outcome::Warning(Note::FfmpegCannotRemove(err.to_string())),
        };
    }
    // Not answering can be an antivirus scanning it: said, never removed.
    if deep && !busy && !crate::convert::answers_as_ffmpeg(&path) {
        return Outcome::Warning(Note::FfmpegNoAnswer);
    }
    gone_or_ok()
}

/// `ffmpeg-download.zip.part` and `ffmpeg-extract-<pid>` (convert.rs) of
/// another run of Pod.
fn is_ffmpeg_leftover(name: &str, pid: u32) -> bool {
    name == "ffmpeg-download.zip.part"
        || name.strip_prefix("ffmpeg-extract-").and_then(|p| p.parse::<u32>().ok()).is_some_and(|p| p != pid)
}

/// `<pid>-<nonce>` in the updates folder (update.rs), of another run of Pod.
fn is_old_update_dir(name: &str, pid: u32) -> bool {
    let Some((p, nonce)) = name.split_once('-') else { return false };
    !nonce.is_empty() && nonce.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|p| p != pid)
}

/// The temporary files Pod writes beside its own settings before renaming
/// them over: `settings.json.pod-<pid>`, `update.json.pod-<pid>` (another
/// run's), and `reminders.json.tmp` (old enough, see `STALE`).
fn is_temp_save(name: &str, pid: u32) -> bool {
    for base in ["settings.json.pod-", "update.json.pod-"] {
        if let Some(p) = name.strip_prefix(base) {
            return p.parse::<u32>().is_ok_and(|p| p != pid);
        }
    }
    name == "reminders.json.tmp"
}

/// A note's temporary save in the shelf folder: `.<note>.<pid>.tmp` (quicknote.rs).
fn is_note_temp(name: &str, pid: u32) -> bool {
    let Some(inner) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")) else { return false };
    let Some((note, p)) = inner.rsplit_once('.') else { return false };
    !note.is_empty() && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|p| p != pid)
}

fn older_than(path: &Path, age: Duration) -> bool {
    std::fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .is_ok_and(|at| SystemTime::now().duration_since(at).is_ok_and(|d| d > age))
}

/// Removes `path` (a file, or a folder of Pod's own); true when it is gone.
fn remove(path: &Path) -> bool {
    let removed = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(_) => return false,
    };
    match removed {
        Ok(()) => {
            crate::log::line(format!("heal: removed the leftover {}", path.display()));
            true
        }
        Err(err) => {
            crate::log::line(format!("heal: couldn't remove the leftover {}: {err}", path.display()));
            false
        }
    }
}

/// The names in `dir` that `keep` picks.
fn entries_matching(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter(|e| keep(&e.file_name().to_string_lossy())).map(|e| e.path()).collect()
}

fn check_leftovers(app: &AppHandle, busy: bool) -> Outcome {
    // A job under way may own a temporary file right now.
    if busy {
        return Outcome::Skipped(Note::Busy);
    }
    let pid = std::process::id();
    let mut doomed = Vec::new();
    if !crate::convert::ffmpeg_downloading() {
        if let Some(bin) = crate::convert::downloaded_ffmpeg().parent() {
            doomed.extend(entries_matching(bin, |n| is_ffmpeg_leftover(n, pid)));
        }
    }
    doomed.extend(entries_matching(&crate::update::downloads_dir(), |n| is_old_update_dir(n, pid)));
    doomed.extend(
        entries_matching(&crate::settings::config_dir(), |n| is_temp_save(n, pid))
            .into_iter()
            .filter(|p| older_than(p, STALE)),
    );
    doomed.extend(
        entries_matching(&crate::workspace::dir(app), |n| is_note_temp(n, pid))
            .into_iter()
            .filter(|p| p.is_file() && older_than(p, STALE)),
    );
    let removed = doomed.iter().filter(|p| remove(p)).count() + crate::files::sweep_inbox();
    if removed == 0 {
        Outcome::Ok
    } else {
        Outcome::Repaired(Note::LeftoversRemoved(removed))
    }
}

/// The program a startup entry runs, without its arguments ("C:\…\pod.exe --autostart").
fn entry_program(entry: &str) -> String {
    let entry = entry.trim();
    if let Some(rest) = entry.strip_prefix('"') {
        return rest.split('"').next().unwrap_or(rest).to_string();
    }
    let lower = entry.to_ascii_lowercase();
    match lower.find(".exe") {
        Some(i) => entry[..i + 4].to_string(),
        None => entry.split_whitespace().next().unwrap_or("").to_string(),
    }
}

/// What to say about the startup entry: `wanted` is the setting, `enabled`
/// what the system says, `entry` the command it would run (Windows), `exe`
/// this copy of Pod. Reported only — never rewritten (see lib.rs).
fn autostart_note(wanted: bool, enabled: bool, entry: Option<&str>, exe: &str) -> Option<Note> {
    if let Some(entry) = entry {
        let program = entry_program(entry);
        if !program.is_empty() && !program.eq_ignore_ascii_case(exe) {
            return Some(Note::AutostartStale(program));
        }
    }
    match (wanted, enabled) {
        (true, false) => Some(Note::AutostartBlocked),
        (false, true) => Some(Note::AutostartLeftover),
        _ => None,
    }
}

fn check_autostart(app: &AppHandle) -> Outcome {
    use tauri_plugin_autostart::ManagerExt;
    let wanted = current_settings(app).autostart;
    let Ok(enabled) = app.autolaunch().is_enabled() else { return Outcome::Ok };
    #[cfg(windows)]
    let entry = crate::webview_check::reg_string(
        false,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        &app.package_info().name,
    );
    #[cfg(not(windows))]
    let entry: Option<String> = None;
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    match autostart_note(wanted, enabled, entry.as_deref(), &exe) {
        Some(note) => Outcome::Warning(note),
        None => Outcome::Ok,
    }
}

fn check_webview() -> Outcome {
    use crate::webview_check::Health;
    match crate::webview_check::detect() {
        Health::Ready(version) => Outcome::Info(Note::WebviewVersion(version)),
        Health::Broken(install) => Outcome::Warning(Note::WebviewBroken(install.version)),
        Health::Missing => Outcome::Warning(Note::WebviewMissing),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Settings → General → Health.
#[tauri::command]
pub fn heal_status(app: AppHandle) -> HealthReport {
    report(&app)
}

/// "Check now": every check at once, with self-repair switched off too (a click).
#[tauri::command]
pub async fn heal_check(app: AppHandle) -> Result<HealthReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(&app, true);
        report(&app)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn the_first_check_runs_at_launch_and_the_next_ones_every_six_hours_while_away() {
        let away = AWAY + MIN;
        // Launch: due at once, the user being there or not, paused or not.
        assert!(due(None, 1_000, true, false, false, Duration::ZERO));
        assert!(due(None, 1_000, true, false, true, Duration::ZERO));
        // Never while switched off or while a job works on files.
        assert!(!due(None, 1_000, false, false, false, away));
        assert!(!due(None, 1_000, true, true, false, away));
        assert!(!due(Some(0), INTERVAL * 2, true, true, false, away));
        // Six hours on, and only while away and not paused.
        assert!(!due(Some(0), INTERVAL - 1, true, false, false, away));
        assert!(due(Some(0), INTERVAL, true, false, false, away));
        assert!(!due(Some(0), INTERVAL, true, false, false, AWAY - MIN));
        assert!(!due(Some(0), INTERVAL, true, false, true, away));
        // A clock set back doesn't wait for the old time to come round.
        assert!(due(Some(10_000), 5_000, true, false, false, away));
    }

    #[test]
    fn only_pods_own_temporary_names_count_as_leftovers() {
        let pid = 4242;
        assert!(is_ffmpeg_leftover("ffmpeg-download.zip.part", pid));
        assert!(is_ffmpeg_leftover("ffmpeg-extract-17", pid));
        assert!(!is_ffmpeg_leftover("ffmpeg-extract-4242", pid), "this run's own");
        assert!(!is_ffmpeg_leftover("ffmpeg.exe", pid));
        assert!(!is_ffmpeg_leftover("ffmpeg-extract-", pid));
        assert!(!is_ffmpeg_leftover("ffmpeg-extract-x1", pid));

        assert!(is_old_update_dir("17-123456789", pid));
        assert!(!is_old_update_dir("4242-123456789", pid), "a download of this run");
        assert!(!is_old_update_dir("17-", pid));
        assert!(!is_old_update_dir("17-12a", pid));
        assert!(!is_old_update_dir("Pod_0.2.0_x64-setup.exe", pid));
        assert!(!is_old_update_dir("my-folder", pid));

        assert!(is_temp_save("settings.json.pod-17", pid));
        assert!(is_temp_save("update.json.pod-17", pid));
        assert!(is_temp_save("reminders.json.tmp", pid));
        assert!(!is_temp_save("settings.json.pod-4242", pid));
        assert!(!is_temp_save("settings.json", pid));
        // What settings.rs and reminders.rs set aside is the user's: kept.
        assert!(!is_temp_save("settings.json.corrupt-20261104-101500", pid));
        assert!(!is_temp_save("reminders.json.bad-20261104-101500", pid));
        assert!(!is_temp_save("settings.json.pod-", pid));

        assert!(is_note_temp(".Groceries.txt.17.tmp", pid));
        assert!(!is_note_temp(".Groceries.txt.4242.tmp", pid));
        assert!(!is_note_temp("Groceries.txt.17.tmp", pid), "no leading dot: not ours");
        assert!(!is_note_temp(".17.tmp", pid));
        assert!(!is_note_temp(".draft.tmp", pid));
        assert!(!is_note_temp(".notes.v2.tmp", pid));
        assert!(!is_note_temp("report.tmp", pid));
    }

    #[test]
    fn a_downloaded_ffmpeg_is_damaged_when_it_is_no_longer_a_program() {
        assert!(looks_like_program(100 * MIN_PROGRAM, b"MZ\x90\x00", b"MZ"));
        assert!(!looks_like_program(100 * MIN_PROGRAM, b"\0\0\0\0", b"MZ"), "zeroed");
        assert!(!looks_like_program(MIN_PROGRAM - 1, b"MZ\x90\x00", b"MZ"), "cut short");
        assert!(!looks_like_program(0, b"", b"MZ"));
        assert!(looks_like_program(MIN_PROGRAM, b"\x7fELF", b"\x7fELF"));
    }

    #[cfg(windows)]
    #[test]
    fn a_shelf_folder_on_a_drive_that_is_gone_is_told_apart() {
        let none = |_: &Path| false;
        let all = |_: &Path| true;
        assert_eq!(mount_point(Path::new(r"E:\Stash\Pod")), Some(Path::new(r"E:\")));
        assert_eq!(mount_point(Path::new(r"\\nas\share\Pod")), Some(Path::new(r"\\nas\share\")));
        assert!(drive_missing(Path::new(r"E:\Stash"), none));
        assert!(!drive_missing(Path::new(r"E:\Stash"), all));
        // The drive is there: a missing folder is simply created again.
        assert!(!drive_missing(Path::new(r"C:\Users\me\Pod Shelf"), |p| p == Path::new(r"C:\")));
        assert_eq!(mount_point(Path::new(r"E:\")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_shelf_folder_on_a_drive_that_is_gone_is_told_apart() {
        assert_eq!(mount_point(Path::new("/media/me/USB/Pod")), Some(Path::new("/media/me/USB")));
        assert_eq!(mount_point(Path::new("/run/media/me/USB/a/b")), Some(Path::new("/run/media/me/USB")));
        assert_eq!(mount_point(Path::new("/mnt/data/Pod")), Some(Path::new("/mnt/data")));
        assert_eq!(mount_point(Path::new("/home/me/Pod Shelf")), None);
        assert_eq!(mount_point(Path::new("/media/me/USB")), None);
        assert!(drive_missing(Path::new("/media/me/USB/Pod"), |_| false));
        assert!(!drive_missing(Path::new("/home/me/Pod Shelf"), |_| false));
    }

    #[test]
    fn the_startup_entry_is_reported_never_rewritten() {
        let exe = r"C:\Users\me\AppData\Local\Pod\pod.exe";
        let ours = r"C:\Users\me\AppData\Local\Pod\pod.exe --autostart";
        assert_eq!(autostart_note(true, true, Some(ours), exe), None);
        assert_eq!(autostart_note(true, true, Some(&ours.to_uppercase()), exe), None, "paths compare without case");
        assert_eq!(autostart_note(false, false, None, exe), None);
        assert_eq!(
            autostart_note(true, true, Some(r"D:\Old\Pod\pod.exe --autostart"), exe),
            Some(Note::AutostartStale(r"D:\Old\Pod\pod.exe".into()))
        );
        assert_eq!(
            autostart_note(true, true, Some(r#""D:\Old Pod\pod.exe" --autostart"#), exe),
            Some(Note::AutostartStale(r"D:\Old Pod\pod.exe".into()))
        );
        // On, but the system won't (Task Manager's Startup apps turned it off).
        assert_eq!(autostart_note(true, false, Some(ours), exe), Some(Note::AutostartBlocked));
        assert_eq!(autostart_note(false, true, Some(ours), exe), Some(Note::AutostartLeftover));
        assert_eq!(entry_program(r"C:\Program Files\Pod\pod.exe --autostart"), r"C:\Program Files\Pod\pod.exe");
        assert_eq!(entry_program("/usr/bin/pod --autostart"), "/usr/bin/pod");
    }

    #[test]
    fn repairs_and_warnings_read_in_the_current_language() {
        crate::i18n::set_for_test("fr");
        let text = Note::FolderCreated("D:/Stash".into()).text();
        assert!(text.contains("D:/Stash"));
        crate::i18n::set_for_test("en");
        assert_eq!(Note::LeftoversRemoved(3).text(), "Leftover files removed: 3");
        assert_eq!(Outcome::Repaired(Note::FfmpegRemoved).status(), "repaired");
        assert_eq!(Outcome::Info(Note::WebviewVersion("156.0.1.2".into())).status(), "ok");
        assert_eq!(Outcome::Ok.note(), None);
    }
}
