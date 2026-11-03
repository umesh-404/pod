// New downloads, for the notch's right side: a file that lands in the user's
// Downloads folder shows up with "Add to shelf".
//
// A download counts once it is finished: browser partials (.crdownload, .part…)
// are ignored, and a file is announced only after its size held still for a
// second and it opens for reading. Only announced paths can be copied to the
// shelf, so the page can't copy anything else. Nothing polls while no download
// is settling; the watcher is gone entirely when the feature is off.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::shelf::{is_hidden_name, is_temp_name, millis};

/// The `download-new` event payload.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewDownload {
    pub path: String,
    pub name: String,
    pub size: u64,
}

const STABLE: Duration = Duration::from_secs(1);
const CHECK_EVERY: Duration = Duration::from_millis(300);
/// A file still not readable after this long is forgotten.
const GIVE_UP: Duration = Duration::from_secs(30 * 60);
const REMEMBERED: usize = 500;

enum Msg {
    Fs(notify::Result<notify::Event>),
    Stop,
}

struct Running {
    _watcher: notify::RecommendedWatcher,
    stop: mpsc::Sender<Msg>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// Announced downloads (path, modified ms), oldest first.
static ANNOUNCED: Mutex<Vec<(PathBuf, u64)>> = Mutex::new(Vec::new());

/// Starts/stops watching the Downloads folder.
#[tauri::command]
pub fn downloads_watch(app: AppHandle, on: bool) {
    let mut running = RUNNING.lock().unwrap();
    if !on {
        if let Some(r) = running.take() {
            let _ = r.stop.send(Msg::Stop);
        }
        return;
    }
    if running.is_some() {
        return;
    }
    let Some(dir) = downloads_dir().filter(|d| d.is_dir()) else {
        crate::log::line("downloads: no Downloads folder".to_string());
        return;
    };
    let (tx, rx) = mpsc::channel::<Msg>();
    let fs_tx = tx.clone();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = fs_tx.send(Msg::Fs(res));
    }) {
        Ok(w) => w,
        Err(err) => {
            crate::log::line(format!("downloads: cannot watch: {err}"));
            return;
        }
    };
    if let Err(err) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        crate::log::line(format!("downloads: cannot watch {}: {err}", dir.display()));
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("downloads-watch".into())
        .spawn(move || watch_loop(app, dir, rx));
    if let Err(err) = spawned {
        crate::log::line(format!("downloads: cannot start the watcher: {err}"));
        return;
    }
    *running = Some(Running { _watcher: watcher, stop: tx });
}

/// Copies a file announced by `download-new` into the workspace; returns its name there.
#[tauri::command]
pub async fn download_to_shelf(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !ANNOUNCED.lock().unwrap().iter().any(|(p, _)| *p == src) {
        return Err(t("Only new downloads can be added to the shelf."));
    }
    let ws = crate::workspace::dir(&app);
    tauri::async_runtime::spawn_blocking(move || copy_in(&src, &ws))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| tf("Cannot copy: {error}", &[("error", &e.to_string())]))
}

/// Copies `src` into `ws` under a free name; the original stays where it is.
fn copy_in(src: &Path, ws: &Path) -> io::Result<String> {
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).ok_or(io::ErrorKind::InvalidInput)?;
    let mut from = std::fs::File::open(src)?;
    if !from.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    std::fs::create_dir_all(ws)?;
    let dest = crate::files::unique_path(ws, &name);
    // create_new: never overwrites, even if the name was taken a moment ago.
    let mut to = std::fs::File::create_new(&dest)?;
    if let Err(e) = io::copy(&mut from, &mut to).and_then(|_| to.sync_all()) {
        drop(to);
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }
    Ok(dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name))
}

/// Remembers a finished download; false when it was already announced as is.
fn remember(path: &Path, modified: u64) -> bool {
    let mut list = ANNOUNCED.lock().unwrap();
    if list.iter().any(|(p, m)| p == path && *m == modified) {
        return false;
    }
    list.retain(|(p, _)| p != path);
    list.push((path.to_path_buf(), modified));
    if list.len() > REMEMBERED {
        let extra = list.len() - REMEMBERED;
        list.drain(..extra);
    }
    true
}

pub(crate) fn is_download_candidate(name: &str) -> bool {
    !is_hidden_name(name) && !is_temp_name(name)
}

// ── Settling ────────────────────────────────────────────────────────────────

struct Seen {
    size: u64,
    since: Instant,
    first: Instant,
}

/// Files that changed lately, until their size has held still long enough.
#[derive(Default)]
pub(crate) struct Settler {
    files: HashMap<PathBuf, Seen>,
}

pub(crate) enum Settled {
    /// Size unchanged for the whole wait.
    Ready,
    Waiting,
}

impl Settler {
    pub(crate) fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub(crate) fn paths(&self) -> Vec<PathBuf> {
        self.files.keys().cloned().collect()
    }

    /// A change was seen: (re)starts the wait.
    pub(crate) fn touch(&mut self, path: PathBuf, now: Instant) {
        self.files
            .entry(path)
            .and_modify(|s| s.since = now)
            .or_insert(Seen { size: u64::MAX, since: now, first: now });
    }

    /// The current size: a new size restarts the wait.
    pub(crate) fn observe(&mut self, path: &Path, size: u64, now: Instant) -> Settled {
        let Some(seen) = self.files.get_mut(path) else { return Settled::Waiting };
        if seen.size != size {
            seen.size = size;
            seen.since = now;
            return Settled::Waiting;
        }
        if now.duration_since(seen.since) >= STABLE {
            Settled::Ready
        } else {
            Settled::Waiting
        }
    }

    pub(crate) fn forget(&mut self, path: &Path) {
        self.files.remove(path);
    }

    /// Ready but not yet readable: wait another round, unless it's been too long.
    fn retry(&mut self, path: &Path, now: Instant) {
        if let Some(seen) = self.files.get_mut(path) {
            if now.duration_since(seen.first) > GIVE_UP {
                self.files.remove(path);
            } else {
                seen.since = now;
            }
        }
    }
}

fn watch_loop(app: AppHandle, dir: PathBuf, rx: mpsc::Receiver<Msg>) {
    let mut settler = Settler::default();
    loop {
        let msg = if settler.is_empty() {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            rx.recv_timeout(CHECK_EVERY)
        };
        match msg {
            Ok(Msg::Fs(Ok(event))) => {
                if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
                    continue;
                }
                let now = Instant::now();
                for path in event.paths {
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    if path.parent() == Some(dir.as_path()) && is_download_candidate(&name) {
                        settler.touch(path, now);
                    }
                }
            }
            Ok(Msg::Fs(Err(err))) => crate::log::line(format!("downloads: watch error: {err}")),
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }

        let now = Instant::now();
        for path in settler.paths() {
            let meta = match std::fs::metadata(&path) {
                Ok(m) if m.is_file() => m,
                _ => {
                    settler.forget(&path);
                    continue;
                }
            };
            if let Settled::Waiting = settler.observe(&path, meta.len(), now) {
                continue;
            }
            // An empty file is a browser's placeholder; the real one comes with
            // a later change (the partial renamed onto it).
            if meta.len() == 0 {
                settler.forget(&path);
                continue;
            }
            if std::fs::File::open(&path).is_err() {
                settler.retry(&path, now);
                continue;
            }
            settler.forget(&path);
            if remember(&path, millis(meta.modified().ok())) {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let payload = NewDownload { path: path.to_string_lossy().to_string(), name, size: meta.len() };
                let _ = app.emit("download-new", payload);
            }
        }
    }
}

// ── Where Downloads is ──────────────────────────────────────────────────────

#[cfg(windows)]
fn downloads_dir() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let path = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        path.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
fn downloads_dir() -> Option<PathBuf> {
    let home = crate::platform::home_dir();
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    std::fs::read_to_string(config.join("user-dirs.dirs"))
        .ok()
        .and_then(|text| xdg_download_dir(&text, &home))
        .or_else(|| Some(home.join("Downloads")))
}

/// XDG_DOWNLOAD_DIR from a user-dirs.dirs file.
#[cfg(not(windows))]
pub(crate) fn xdg_download_dir(text: &str, home: &Path) -> Option<PathBuf> {
    let line = text.lines().map(str::trim).find(|l| l.starts_with("XDG_DOWNLOAD_DIR="))?;
    let value = line["XDG_DOWNLOAD_DIR=".len()..].trim().trim_matches('"');
    let path = if let Some(rest) = value.strip_prefix("$HOME") {
        home.join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(value)
    };
    // "$HOME/" alone means the feature is off.
    (path.is_absolute() && path != home).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partials_are_not_downloads() {
        for partial in ["Unconfirmed 123.crdownload", "movie.mkv.part", "a.partial", "x.tmp", "y.download", "~$doc.docx", ".hidden"] {
            assert!(!is_download_candidate(partial), "{partial}");
        }
        for done in ["movie.mkv", "report.pdf", "setup.exe"] {
            assert!(is_download_candidate(done), "{done}");
        }
    }

    #[test]
    fn waits_until_the_size_holds_still() {
        let t0 = Instant::now();
        let p = PathBuf::from("file.zip");
        let mut s = Settler::default();
        assert!(matches!(s.observe(&p, 10, t0), Settled::Waiting)); // not tracked
        s.touch(p.clone(), t0);
        assert!(matches!(s.observe(&p, 10, t0), Settled::Waiting));
        assert!(matches!(s.observe(&p, 20, t0 + Duration::from_millis(900)), Settled::Waiting));
        assert!(matches!(s.observe(&p, 20, t0 + Duration::from_millis(1500)), Settled::Waiting));
        assert!(matches!(s.observe(&p, 20, t0 + Duration::from_millis(1900)), Settled::Ready));
        s.touch(p.clone(), t0 + Duration::from_millis(2000));
        assert!(matches!(s.observe(&p, 20, t0 + Duration::from_millis(2500)), Settled::Waiting));
        s.forget(&p);
        assert!(s.is_empty());
    }

    #[test]
    fn announces_each_file_once() {
        let p = std::env::temp_dir().join("pod-downloads-test-once.bin");
        assert!(remember(&p, 1));
        assert!(!remember(&p, 1));
        assert!(remember(&p, 2));
        assert_eq!(ANNOUNCED.lock().unwrap().iter().filter(|(q, _)| *q == p).count(), 1);
    }

    #[test]
    fn copies_without_touching_the_original() {
        let dir = std::env::temp_dir().join(format!("pod-downloads-test-{}", std::process::id()));
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let src = dir.join("file.txt");
        std::fs::write(&src, "new").unwrap();
        std::fs::write(ws.join("file.txt"), "old").unwrap();
        assert_eq!(copy_in(&src, &ws).unwrap(), "file (2).txt");
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(ws.join("file.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(ws.join("file (2).txt")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn reads_user_dirs() {
        let home = Path::new("/home/me");
        let text = "# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Téléchargements\"\n";
        assert_eq!(xdg_download_dir(text, home), Some(PathBuf::from("/home/me/Téléchargements")));
        assert_eq!(xdg_download_dir("XDG_DOWNLOAD_DIR=\"/data/dl\"", home), Some(PathBuf::from("/data/dl")));
        assert_eq!(xdg_download_dir("XDG_DOWNLOAD_DIR=\"$HOME/\"", home), None);
        assert_eq!(xdg_download_dir("", home), None);
    }
}
