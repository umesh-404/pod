// The temporary workspace: files dropped on "Copy to shelf" are copied into
// one folder, set in Settings, and the originals stay where they were. Changing
// the folder moves everything already in the old one to the new one.
//
// The rules, because these are the user's own files and not copies:
//   * only paths a real drop just delivered can be moved in (files::take_dropped),
//     so a script in the page cannot move anything else;
//   * nothing is ever overwritten: a taken name gets " (2)", " (3)"…;
//   * across drives a move is a copy, and the original is removed only after the
//     whole copy succeeded; a half copy is removed and the original stays;
//   * the home folder, a drive root and the usual system folders are never
//     emptied or removed, even when one of them was the workspace.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::i18n::{t, tf, tn};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Absolute path of the workspace folder.
    pub dir: String,
    /// True when no folder was picked and the default one is used.
    pub is_default: bool,
    /// Entries (files and folders) directly in it; 0 when it does not exist yet.
    pub items: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub name: String,
    pub error: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub dir: String,
    /// Final names in the workspace (a number is added when the name was taken).
    pub moved: Vec<String>,
    pub failed: Vec<Failure>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub info: WorkspaceInfo,
    /// Entries moved from the old folder to the new one.
    pub moved: usize,
    pub failed: Vec<Failure>,
    /// Anything the user should know (e.g. the old folder was a system folder and was left alone).
    pub note: Option<String>,
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn workspace_info(app: AppHandle) -> WorkspaceInfo {
    info(&app)
}

#[tauri::command]
pub async fn workspace_move_in(app: AppHandle, paths: Vec<String>) -> Result<MoveReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = crate::files::JobGuard::new();
        let ws = dir(&app);
        std::fs::create_dir_all(&ws).map_err(|e| cannot_create(&ws, &e))?;
        let home = canon(&crate::platform::home_dir());
        let mut report = MoveReport { dir: display(&ws), moved: Vec::new(), failed: Vec::new() };
        for path in paths {
            let src = PathBuf::from(&path);
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            // Checked first and for every path, so each drop is good only once.
            if !crate::files::take_dropped(&path) {
                let error = t("Only files dropped on the island can be moved.");
                report.failed.push(Failure { name, error });
                continue;
            }
            match move_in(&src, &ws, &home) {
                Ok(dest) => report.moved.push(file_name(&dest)),
                Err(error) => report.failed.push(Failure { name, error }),
            }
        }
        if !report.moved.is_empty() {
            crate::log::line(format!("workspace: copied {} item(s) in", report.moved.len()));
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_change(app: AppHandle) -> Result<Option<WorkspaceChange>, String> {
    // The pickers and the confirmation block, so never on the main thread.
    tauri::async_runtime::spawn_blocking(move || change(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn workspace_open(app: AppHandle) -> Result<(), String> {
    let ws = dir(&app);
    std::fs::create_dir_all(&ws).map_err(|e| cannot_create(&ws, &e))?;
    crate::platform::reveal_folder(&display(&ws));
    Ok(())
}

// ── Where the workspace is ──────────────────────────────────────────────────

fn default_dir() -> PathBuf {
    crate::platform::home_dir().join("Pod Shelf")
}

/// The configured folder, else the default one.
pub(crate) fn dir(app: &AppHandle) -> PathBuf {
    let configured = app.state::<crate::Shared>().settings.lock().unwrap().workspace_dir.clone();
    if configured.trim().is_empty() {
        default_dir()
    } else {
        PathBuf::from(configured)
    }
}

/// Where every drop action saves what it makes (converted files, archives,
/// resized pictures, PDFs, text, clean copies): the workspace, created when
/// missing.
pub(crate) fn output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let ws = dir(app);
    std::fs::create_dir_all(&ws).map_err(|e| cannot_create(&ws, &e))?;
    Ok(ws)
}

fn info(app: &AppHandle) -> WorkspaceInfo {
    let ws = dir(app);
    let configured = app.state::<crate::Shared>().settings.lock().unwrap().workspace_dir.clone();
    WorkspaceInfo {
        dir: display(&ws),
        is_default: configured.trim().is_empty(),
        items: entries(&ws).len(),
    }
}

/// Saves the new folder, empty when it is the default one, and tells every window.
fn store(app: &AppHandle, folder: &Path) {
    let value = if same(folder, &default_dir()) { String::new() } else { display(folder) };
    let shared = app.state::<crate::Shared>();
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.workspace_dir = value;
        if let Err(err) = crate::settings::save(&current) {
            crate::log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
}

// ── Changing the folder ─────────────────────────────────────────────────────

fn change(app: &AppHandle) -> Result<Option<WorkspaceChange>, String> {
    let old = dir(app);
    let home = crate::platform::home_dir();
    let start = if old.is_dir() { old.clone() } else { home.clone() };
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(t("Choose the shelf folder"))
        .set_directory(&start)
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let new = picked.into_path().map_err(|e| e.to_string())?;
    let new = PathBuf::from(strip_verbatim(&new.to_string_lossy()));

    if same(&new, &old) {
        return Ok(Some(WorkspaceChange { info: info(app), moved: 0, failed: Vec::new(), note: None }));
    }
    let (new_key, old_key) = (key(&canon(&new)), key(&canon(&old)));
    if new_key.starts_with(&old_key) {
        return Err(t("The new folder is inside the current shelf folder. Pick a folder outside it."));
    }
    if old_key.starts_with(&new_key) {
        return Err(t("The current shelf folder is inside that folder. Pick another folder."));
    }

    let items = entries(&old);
    let mut moved = 0;
    let mut failed = Vec::new();
    let mut note = None;
    if !items.is_empty() {
        let old_shown = display(&old);
        if is_protected(&canon(&home), &canon(&old)) {
            // Emptying the home folder or Downloads because it once was the
            // workspace would be a disaster: switch, and leave the files alone.
            note = Some(tf(
                "{folder} is a system folder, so its files were left where they are.",
                &[("folder", &old_shown)],
            ));
        } else {
            let new_shown = display(&new);
            let question = tn(
                "Move {count} item from {old} to {new}?",
                "Move {count} items from {old} to {new}?",
                items.len() as u64,
                &[("old", &old_shown), ("new", &new_shown)],
            );
            let ok = app
                .dialog()
                .message(question)
                .title(t("Change the shelf folder"))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(t("Move"), t("Cancel")))
                .blocking_show();
            if !ok {
                return Ok(None);
            }
            std::fs::create_dir_all(&new).map_err(|e| cannot_create(&new, &e))?;
            for item in &items {
                let name = file_name(item);
                match move_entry(item, &crate::files::unique_path(&new, &name)) {
                    Ok(()) => moved += 1,
                    Err(error) => failed.push(Failure { name, error }),
                }
            }
            if failed.is_empty() {
                // Only the folder Pod emptied itself, and only when it is empty.
                let _ = std::fs::remove_dir(&old);
            } else {
                note = Some(tn(
                    "{count} item could not be moved and is still in {folder}.",
                    "{count} items could not be moved and are still in {folder}.",
                    failed.len() as u64,
                    &[("folder", &old_shown)],
                ));
            }
            crate::log::line(format!("workspace: moved {moved} item(s), {} failed", failed.len()));
        }
    }

    store(app, &new);
    Ok(Some(WorkspaceChange { info: info(app), moved, failed, note }))
}

// ── Moving ──────────────────────────────────────────────────────────────────

/// Copies one dropped file or folder into `ws` (which exists); returns where the copy landed.
fn move_in(src: &Path, ws: &Path, home: &Path) -> Result<PathBuf, String> {
    let Some(name) = src.file_name() else {
        return Err(t("A whole drive can't be moved."));
    };
    if std::fs::symlink_metadata(src).is_err() {
        return Err(t("It no longer exists."));
    }
    // The parent is resolved but not the item itself: a dropped shortcut or link
    // is moved as a link, never as what it points at.
    let parent = src.parent().map(canon).unwrap_or_default();
    let src_canon = parent.join(name);
    let ws_canon = canon(ws);
    let (src_key, ws_key) = (key(&src_canon), key(&ws_canon));
    if src_key == ws_key {
        return Err(t("That is the shelf folder itself."));
    }
    if ws_key.starts_with(&src_key) {
        return Err(t("This folder contains the shelf folder."));
    }
    if src_key.parent() == Some(ws_key.as_path()) {
        return Err(t("Already on the shelf"));
    }
    if is_protected(home, &src_canon) {
        return Err(t("This is a system folder; Pod won't move it."));
    }
    // A copy: the dropped original stays where it was. A name taken since
    // `unique_path` looked (another drop, another job) is skipped, never used.
    let name = name.to_string_lossy();
    for _ in 0..32 {
        let dest = crate::files::unique_path(ws, &name);
        match copy_fresh(src, &dest) {
            Ok(()) => return Ok(dest),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists).to_string())
}

/// Renames `src` to `dest`, or copies then removes it when they are on
/// different drives. `dest` must not exist.
fn move_entry(src: &Path, dest: &Path) -> Result<(), String> {
    let taken = || tf("{path} already exists.", &[("path", &display(dest))]);
    if std::fs::symlink_metadata(dest).is_ok() {
        return Err(taken());
    }
    // `std::fs::rename` would replace a file that appeared there meanwhile.
    match crate::rename::rename_no_replace(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(taken()),
        Err(e) if crosses_devices(&e) => copy_then_remove(src, dest),
        Err(e) => Err(e.to_string()),
    }
}

fn crosses_devices(e: &io::Error) -> bool {
    // ERROR_NOT_SAME_DEVICE on Windows, EXDEV elsewhere.
    let code = if cfg!(windows) { 17 } else { 18 };
    e.kind() == io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(code)
}

/// The move across drives: the original goes only once the copy is complete.
fn copy_then_remove(src: &Path, dest: &Path) -> Result<(), String> {
    copy_fresh(src, dest).map_err(|e| e.to_string())?;
    if let Err(e) = remove_original(src) {
        // The copy is whole, so nothing is lost; some of the original stays behind.
        crate::log::line(format!("workspace: copied {} but could not remove it: {e}", src.display()));
    }
    Ok(())
}

/// Copies `src` to `dest`, which must not exist. `dest` is created first and
/// exclusively (a new file, folder or link): something that appeared there
/// since `unique_path` looked is never written over, and the copy then fails
/// with AlreadyExists without removing it. A copy that fails later removes
/// only what it made itself.
fn copy_fresh(src: &Path, dest: &Path) -> io::Result<()> {
    let kind = std::fs::symlink_metadata(src)?.file_type();
    if kind.is_symlink() {
        // Making the link is the whole copy, and it never replaces anything.
        return copy_link(src, dest);
    }
    if kind.is_dir() {
        std::fs::create_dir(dest)?;
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(dest)?;
    }
    // Everything at `dest` is ours from here on.
    let filled = if kind.is_dir() { copy_children(src, dest) } else { std::fs::copy(src, dest).map(|_| ()) };
    if let Err(e) = filled {
        remove_tree(dest);
        // Not AlreadyExists any more: that kind means "`dest` was taken".
        return Err(if e.kind() == io::ErrorKind::AlreadyExists { io::Error::other(e) } else { e });
    }
    Ok(())
}

/// Copies what is in the folder `src` into the folder `dest`, which is ours.
fn copy_children(src: &Path, dest: &Path) -> io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
    }
    Ok(())
}

fn copy_tree(src: &Path, dest: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        copy_link(src, dest)
    } else if kind.is_dir() {
        std::fs::create_dir(dest)?;
        copy_children(src, dest)
    } else {
        std::fs::copy(src, dest).map(|_| ())
    }
}

/// A link is recreated, never followed (it could point at the whole disk).
#[cfg(unix)]
fn copy_link(src: &Path, dest: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(src)?, dest)
}

#[cfg(windows)]
fn copy_link(src: &Path, dest: &Path) -> io::Result<()> {
    let target = std::fs::read_link(src)?;
    if std::fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, dest)
    } else {
        std::os::windows::fs::symlink_file(target, dest)
    }
}

fn remove_original(src: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(src)
    } else {
        // A link to a folder is a directory entry on Windows.
        std::fs::remove_file(src).or_else(|_| std::fs::remove_dir(src))
    }
}

fn remove_tree(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    let _ = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path))
    };
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// Direct entries of `dir`; none when it does not exist.
fn entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|list| list.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Resolved when it exists, else as given; without the `\\?\` prefix either way.
fn canon(path: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    PathBuf::from(strip_verbatim(&resolved.to_string_lossy()))
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\server\share` → `\\server\share`.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// A form of the path to compare with: case-insensitive on Windows, as the file system is.
fn key(path: &Path) -> PathBuf {
    let text = strip_verbatim(&path.to_string_lossy());
    if cfg!(windows) {
        PathBuf::from(text.replace('/', "\\").to_lowercase())
    } else {
        PathBuf::from(text)
    }
}

fn same(a: &Path, b: &Path) -> bool {
    key(&canon(a)) == key(&canon(b))
}

/// The folders Pod never empties or moves: the home folder and anything
/// above it, a drive root, and the usual folders in home (also under OneDrive,
/// where Windows often moves them). Both paths should already be resolved.
fn is_protected(home: &Path, dir: &Path) -> bool {
    const SYSTEM: [&str; 6] = ["desktop", "documents", "downloads", "pictures", "music", "videos"];
    let (home, dir) = (key(home), key(dir));
    if dir.parent().is_none() || home.starts_with(&dir) {
        return true;
    }
    let lower = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let name = lower(&dir);
    let Some(parent) = dir.parent() else { return true };
    if parent == home {
        return SYSTEM.contains(&name.as_str()) || name.starts_with("onedrive");
    }
    parent.parent() == Some(home.as_path()) && lower(parent).starts_with("onedrive") && SYSTEM.contains(&name.as_str())
}

fn display(path: &Path) -> String {
    strip_verbatim(&path.to_string_lossy())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| display(path))
}

fn cannot_create(path: &Path, e: &io::Error) -> String {
    tf("Cannot create {path}: {error}", &[("path", &display(path)), ("error", &e.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A fresh folder under the temp dir, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("pod-ws-test-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(canon(&dir))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn copies_a_file_and_keeps_the_original() {
        let s = Scratch::new();
        let (ws, home) = (s.0.join("ws"), s.0.join("home"));
        std::fs::create_dir_all(&ws).unwrap();
        let src = s.0.join("out").join("note.txt");
        write(&src, "hello");
        let dest = move_in(&src, &ws, &home).unwrap();
        assert_eq!(dest, ws.join("note.txt"));
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(dest).unwrap(), "hello");
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let s = Scratch::new();
        let (ws, home) = (s.0.join("ws"), s.0.join("home"));
        write(&ws.join("note.txt"), "old");
        let src = s.0.join("out").join("note.txt");
        write(&src, "new");
        let dest = move_in(&src, &ws, &home).unwrap();
        assert_eq!(file_name(&dest), "note (2).txt");
        assert_eq!(std::fs::read_to_string(ws.join("note.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(dest).unwrap(), "new");
    }

    #[test]
    fn copies_a_folder_with_nested_files() {
        let s = Scratch::new();
        let (ws, home) = (s.0.join("ws"), s.0.join("home"));
        std::fs::create_dir_all(&ws).unwrap();
        let src = s.0.join("out").join("project");
        write(&src.join("a.txt"), "a");
        write(&src.join("sub").join("b.txt"), "b");
        let dest = move_in(&src, &ws, &home).unwrap();
        assert!(src.join("sub").join("b.txt").is_file());
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dest.join("sub").join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn copy_then_remove_moves_a_tree() {
        let s = Scratch::new();
        let src = s.0.join("project");
        write(&src.join("a.txt"), "a");
        write(&src.join("sub").join("deep").join("b.txt"), "b");
        std::fs::create_dir_all(src.join("empty")).unwrap();
        let dest = s.0.join("copied");
        copy_then_remove(&src, &dest).unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dest.join("sub").join("deep").join("b.txt")).unwrap(), "b");
        assert!(dest.join("empty").is_dir());

        let file = s.0.join("single.txt");
        write(&file, "one");
        copy_then_remove(&file, &s.0.join("single (2).txt")).unwrap();
        assert!(!file.exists());
        assert_eq!(std::fs::read_to_string(s.0.join("single (2).txt")).unwrap(), "one");
    }

    #[test]
    fn a_failed_copy_keeps_the_original_and_leaves_nothing() {
        let s = Scratch::new();
        let src = s.0.join("project");
        write(&src.join("a.txt"), "a");
        // The destination's parent does not exist, so the copy fails at once.
        let dest = s.0.join("missing").join("project");
        assert!(copy_then_remove(&src, &dest).is_err());
        assert!(src.join("a.txt").exists());
        assert!(!dest.exists());
    }

    #[test]
    fn a_name_taken_meanwhile_is_never_written_over_or_removed() {
        // `unique_path` found the name free, then something else (another
        // drop, another job) took it before the copy started.
        let s = Scratch::new();
        let theirs = s.0.join("project");
        write(&theirs.join("keep.txt"), "theirs");
        let src = s.0.join("out").join("project");
        write(&src.join("a.txt"), "ours");
        let err = copy_fresh(&src, &theirs).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(theirs.join("keep.txt")).unwrap(), "theirs");
        assert!(!theirs.join("a.txt").exists());
        // The cross-drive move refuses it too, and keeps the original.
        assert!(copy_then_remove(&src, &theirs).is_err());
        assert!(theirs.join("keep.txt").is_file() && src.join("a.txt").is_file());

        let file = s.0.join("note.txt");
        write(&file, "theirs");
        let other = s.0.join("out").join("note.txt");
        write(&other, "ours");
        assert_eq!(copy_fresh(&other, &file).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");
    }

    #[test]
    fn never_overwrites() {
        let s = Scratch::new();
        let (src, dest) = (s.0.join("a.txt"), s.0.join("b.txt"));
        write(&src, "a");
        write(&dest, "b");
        assert!(move_entry(&src, &dest).is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "b");
        assert!(src.exists());
    }

    #[test]
    fn refuses_the_workspace_its_ancestors_and_its_own_items() {
        let s = Scratch::new();
        let home = s.0.join("home");
        let ws = s.0.join("parent").join("ws");
        write(&ws.join("inside.txt"), "x");
        assert!(move_in(&ws, &ws, &home).is_err());
        assert!(move_in(&s.0.join("parent"), &ws, &home).is_err());
        assert_eq!(move_in(&ws.join("inside.txt"), &ws, &home).unwrap_err(), t("Already on the shelf"));
        assert!(move_in(&s.0.join("nothing-here"), &ws, &home).is_err());
        assert!(s.0.join("parent").exists() && ws.join("inside.txt").exists());

        // Something deeper inside may be pulled up to the top.
        write(&ws.join("sub").join("deep.txt"), "d");
        assert!(move_in(&ws.join("sub").join("deep.txt"), &ws, &home).is_ok());
    }

    #[test]
    fn refuses_protected_folders() {
        let s = Scratch::new();
        let home = s.0.join("home");
        let ws = s.0.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        assert!(move_in(&home.join("Downloads"), &ws, &home).is_err());
        assert!(home.join("Downloads").is_dir());
    }

    #[test]
    fn protected_folders() {
        let home = std::env::temp_dir().join("someone");
        assert!(is_protected(&home, &home));
        assert!(is_protected(&home, home.parent().unwrap()));
        for name in ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "OneDrive"] {
            assert!(is_protected(&home, &home.join(name)), "{name}");
        }
        assert!(is_protected(&home, &home.join("OneDrive - Acme")));
        assert!(is_protected(&home, &home.join("OneDrive").join("Documents")));
        assert!(!is_protected(&home, &home.join("Notch Workspace")));
        assert!(!is_protected(&home, &home.join("Downloads").join("stuff")));
        assert!(!is_protected(&home, &home.join("OneDrive").join("work")));
        #[cfg(windows)]
        {
            assert!(is_protected(&home, Path::new(r"D:\")));
            assert!(is_protected(Path::new(r"C:\Users\Someone"), Path::new(r"c:/users/someone/desktop")));
        }
        #[cfg(unix)]
        assert!(is_protected(&home, Path::new("/")));
    }

    #[test]
    fn inside_checks_compare_whole_components() {
        assert!(key(Path::new("/a/b/c")).starts_with(key(Path::new("/a/b"))));
        assert!(!key(Path::new("/a/bc")).starts_with(key(Path::new("/a/b"))));
        #[cfg(windows)]
        assert!(key(Path::new(r"\\?\C:\Users\X\Work")).starts_with(key(Path::new("c:/users/x"))));
    }

    #[test]
    fn strips_the_verbatim_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\x"), r"C:\Users\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share"), r"\\server\share");
        assert_eq!(strip_verbatim("/home/x"), "/home/x");
    }
}
