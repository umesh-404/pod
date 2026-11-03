// "Batch rename": the files dropped on the island are renamed where they are,
// from a pattern typed in the island ("Trip {n}", "{date} {name}"), with a
// preview before anything changes and an Undo afterwards.
//
//   * only paths a real drop delivered are renamed (`rename_prepare` takes
//     them, the page then only names the job); Undo works only on what this
//     job renamed;
//   * nothing is ever overwritten: a taken name gets " (2)", " (3)"…, and the
//     rename itself refuses to replace a file that appeared meanwhile;
//   * the files stay in their folders: a name is never a path.
//
// Pattern words: {name} (the old name without its extension), {ext} (the
// extension, without the dot), {n} (1, 2, 3…, zero-padded to the count: 01…12),
// {n:3} (padded to 3 digits), {date} (the file's last-modified day, 2026-11-03).
// Without {ext}, the old extension is kept.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use serde::Serialize;

use crate::archive::display_name;
use crate::i18n::{t, tf};
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameJob {
    pub id: u64,
    /// The dropped names, in order.
    pub names: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameRow {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameReport {
    /// What changed name (old → new); for Undo, new → old.
    pub renamed: Vec<RenameRow>,
    /// Files left as they were: already named so, or the rename failed.
    pub unchanged: usize,
    pub failed: Vec<Failure>,
}

struct Job {
    paths: Vec<PathBuf>,
    created: Instant,
    /// (old path, new path) of what `rename_apply` did, for Undo.
    done: Option<Vec<(PathBuf, PathBuf)>>,
}

const MAX_JOBS: usize = 16;
/// The most files one rename takes.
const MAX_FILES: usize = 1000;
const MAX_PATTERN: usize = 200;

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static JOBS: Mutex<Option<HashMap<u64, Job>>> = Mutex::new(None);

fn with_jobs<R>(f: impl FnOnce(&mut HashMap<u64, Job>) -> R) -> R {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn gone() -> String {
    t("This rename is no longer available. Drop the files again.")
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Dropped on "Rename": takes the paths (they must all come from a real drop).
/// The rename commands run off the UI thread: a thousand files on a network
/// share would otherwise freeze every window while they are looked at.
#[tauri::command(async)]
pub fn rename_prepare(paths: Vec<String>) -> Result<RenameJob, String> {
    if paths.is_empty() {
        return Err(t("Drop the files to rename."));
    }
    // Every path is checked (and so used up), even after one is refused.
    let all_dropped = paths.iter().fold(true, |ok, p| crate::files::take_dropped(p) && ok);
    if !all_dropped {
        return Err(t("Only files dropped on the island can be renamed."));
    }
    if paths.len() > MAX_FILES {
        return Err(tf("Rename at most {count} files at once.", &[("count", &MAX_FILES.to_string())]));
    }
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    for path in &paths {
        if path.file_name().is_none() || path.parent().is_none() {
            return Err(t("A whole drive can't be renamed."));
        }
        std::fs::symlink_metadata(path).map_err(|e| {
            tf("Cannot read {path}: {error}", &[("path", &display_name(path)), ("error", &e.to_string())])
        })?;
    }
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let names = paths.iter().map(|p| display_name(p)).collect();
    with_jobs(|jobs| {
        while jobs.len() >= MAX_JOBS {
            let Some(oldest) = jobs.iter().min_by_key(|(_, j)| j.created).map(|(k, _)| *k) else { break };
            jobs.remove(&oldest);
        }
        jobs.insert(id, Job { paths, created: Instant::now(), done: None });
    });
    Ok(RenameJob { id, names })
}

/// The new names `pattern` gives, without renaming anything.
#[tauri::command(async)]
pub fn rename_preview(id: u64, pattern: String) -> Result<Vec<RenameRow>, String> {
    let paths = with_jobs(|jobs| jobs.get(&id).map(|j| j.paths.clone())).ok_or_else(gone)?;
    let planned = plan(&paths, &pattern, &DiskInfo)?;
    Ok(planned.iter().map(|(from, to)| RenameRow { from: display_name(from), to: display_name(to) }).collect())
}

/// Renames the files as the preview showed (worked out again, in case a name was taken meanwhile).
#[tauri::command(async)]
pub fn rename_apply(id: u64, pattern: String) -> Result<RenameReport, String> {
    let paths = with_jobs(|jobs| match jobs.get(&id) {
        Some(job) if job.done.is_some() => Err(t("These files were already renamed.")),
        Some(job) => Ok(job.paths.clone()),
        None => Err(gone()),
    })?;
    let _busy = crate::files::JobGuard::new();
    let planned = plan(&paths, &pattern, &DiskInfo)?;
    let mut report = RenameReport { renamed: Vec::new(), unchanged: 0, failed: Vec::new() };
    let mut done = Vec::new();
    for (from, to) in planned {
        if from == to {
            report.unchanged += 1;
            continue;
        }
        match rename_no_replace(&from, &to) {
            Ok(()) => {
                report.renamed.push(RenameRow { from: display_name(&from), to: display_name(&to) });
                done.push((from, to));
            }
            Err(e) => {
                report.unchanged += 1;
                report.failed.push(Failure { name: display_name(&from), error: rename_error(&to, &e) });
            }
        }
    }
    if !done.is_empty() {
        crate::log::line(format!("rename: {} file(s)", done.len()));
    }
    with_jobs(|jobs| {
        if let Some(job) = jobs.get_mut(&id) {
            job.done = Some(done);
        }
    });
    Ok(report)
}

/// Undo: every file this job renamed gets its old name back, unless that
/// name was taken since (then it keeps the new one). Undo works once.
#[tauri::command(async)]
pub fn rename_undo(id: u64) -> Result<RenameReport, String> {
    let done = with_jobs(|jobs| jobs.remove(&id).and_then(|j| j.done)).ok_or_else(gone)?;
    let _busy = crate::files::JobGuard::new();
    let mut report = RenameReport { renamed: Vec::new(), unchanged: 0, failed: Vec::new() };
    for (old, new) in done.iter().rev() {
        match rename_no_replace(new, old) {
            Ok(()) => report.renamed.push(RenameRow { from: display_name(new), to: display_name(old) }),
            Err(e) => {
                report.unchanged += 1;
                report.failed.push(Failure { name: display_name(new), error: rename_error(old, &e) });
            }
        }
    }
    report.renamed.reverse();
    Ok(report)
}

fn rename_error(to: &Path, e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::AlreadyExists {
        tf("{name} is already taken.", &[("name", &display_name(to))])
    } else {
        tf("Couldn't rename it: {error}", &[("error", &e.to_string())])
    }
}

// ── Planning (pure but for the disk lookups, which `Info` answers) ──────────

/// What planning needs to know about the disk.
pub(crate) trait Info {
    fn exists(&self, path: &Path) -> bool;
    /// The last-modified time, for {date}.
    fn modified(&self, path: &Path) -> Option<SystemTime>;
    fn is_dir(&self, path: &Path) -> bool;
}

struct DiskInfo;

impl Info for DiskInfo {
    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }
    fn modified(&self, path: &Path) -> Option<SystemTime> {
        std::fs::metadata(path).and_then(|m| m.modified()).ok()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

/// What one file brings to the pattern.
pub(crate) struct Fields<'a> {
    pub stem: &'a str,
    pub ext: &'a str,
    /// 1-based.
    pub n: usize,
    pub count: usize,
    pub date: &'a str,
}

/// Why a pattern can't be used, in the user's words.
fn pattern_error(kind: PatternError) -> String {
    match kind {
        PatternError::Empty => t("Type a name for the files."),
        PatternError::Unknown(word) => tf("{word} isn't a word Pod knows. Use {name}, {n}, {date} or {ext}.", &[("word", &word)]),
        PatternError::BadChar(c) => tf("A name can't contain {char}.", &[("char", &c.to_string())]),
        PatternError::Reserved(name) => tf("{name} is a name Windows keeps for itself.", &[("name", &name)]),
        PatternError::TooLong => t("That name is too long."),
        PatternError::Same => t("Every file would get the same name. Add {n} to number them."),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PatternError {
    Empty,
    Unknown(String),
    BadChar(char),
    Reserved(String),
    TooLong,
    Same,
}

/// The pattern filled in for one file: the new name, its extension included.
pub(crate) fn expand(pattern: &str, f: &Fields) -> Result<String, PatternError> {
    let mut out = String::new();
    let mut has_ext = false;
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            return Err(PatternError::Unknown(rest[open..].to_string()));
        };
        let word = &after[..close];
        match word.trim() {
            "name" => out.push_str(f.stem),
            "ext" => {
                has_ext = true;
                out.push_str(f.ext);
            }
            "date" => out.push_str(f.date),
            w if w == "n" || w.starts_with("n:") => {
                let width = match w.strip_prefix("n:") {
                    None => f.count.max(1).to_string().len(),
                    Some(digits) => match digits.parse::<usize>() {
                        Ok(d) if (1..=9).contains(&d) => d,
                        _ => return Err(PatternError::Unknown(format!("{{{word}}}"))),
                    },
                };
                out.push_str(&format!("{:0width$}", f.n, width = width));
            }
            _ => return Err(PatternError::Unknown(format!("{{{word}}}"))),
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    if !has_ext && !f.ext.is_empty() {
        let base = out.trim_end_matches([' ', '.']).to_string();
        out = format!("{base}.{}", f.ext);
    }
    check_name(&out)
}

/// A file name that works on Windows and Linux, or why not. Spaces and dots at
/// the end go (Windows drops them anyway).
pub(crate) fn check_name(name: &str) -> Result<String, PatternError> {
    let name = name.trim_start_matches(' ').trim_end_matches([' ', '.']);
    if name.is_empty() || name == "." || name == ".." {
        return Err(PatternError::Empty);
    }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()) {
        return Err(PatternError::BadChar(c));
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(PatternError::Reserved(stem));
    }
    if name.len() > 240 {
        return Err(PatternError::TooLong);
    }
    Ok(name.to_string())
}

/// Two names are the same file name here (Windows and macOS ignore case).
fn same_name(a: &str, b: &str) -> bool {
    if cfg!(target_os = "linux") {
        a == b
    } else {
        a.to_lowercase() == b.to_lowercase()
    }
}

fn key(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    if cfg!(target_os = "linux") { s } else { s.to_lowercase() }
}

/// Where each file goes: (old path, new path), in the dropped order; the same
/// path when the name doesn't change. A name taken on disk or by an earlier
/// file of the batch gets " (2)", " (3)"…
pub(crate) fn plan(paths: &[PathBuf], pattern: &str, info: &dyn Info) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(pattern_error(PatternError::Empty));
    }
    if pattern.chars().count() > MAX_PATTERN {
        return Err(pattern_error(PatternError::TooLong));
    }
    let count = paths.len();
    let mut wanted = Vec::with_capacity(count);
    for (i, path) in paths.iter().enumerate() {
        let name = display_name(path);
        let folder = info.is_dir(path);
        let (stem, ext) = match (folder, name.rfind('.')) {
            (false, Some(dot)) if dot > 0 => (&name[..dot], &name[dot + 1..]),
            _ => (name.as_str(), ""),
        };
        let date = info
            .modified(path)
            .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let fields = Fields { stem, ext, n: i + 1, count, date: &date };
        wanted.push(expand(pattern, &fields).map_err(pattern_error)?);
    }
    // Several files, one name for all: almost surely a missing {n}.
    if count > 1 && wanted.iter().all(|w| same_name(w, &wanted[0])) {
        let dirs: HashSet<String> = paths.iter().map(|p| key(p.parent().unwrap_or(Path::new("")))).collect();
        if dirs.len() == 1 {
            return Err(pattern_error(PatternError::Same));
        }
    }
    let mut claimed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(count);
    for (path, name) in paths.iter().zip(wanted) {
        let dir = path.parent().unwrap_or(Path::new(""));
        let current = display_name(path);
        let first = dir.join(&name);
        // The same file: no change, or only its case (allowed as is).
        let target = if same_name(&name, &current) && !claimed.contains(&key(&first)) {
            first
        } else {
            free_name(dir, &name, info, &claimed)
        };
        claimed.insert(key(&target));
        out.push((path.clone(), target));
    }
    Ok(out)
}

/// `dir/name`, or `dir/stem (2).ext`… when the disk or the batch has it.
fn free_name(dir: &Path, name: &str, info: &dyn Info, claimed: &HashSet<String>) -> PathBuf {
    let taken = |p: &Path| info.exists(p) || claimed.contains(&key(p));
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (2..100_000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !taken(p)).unwrap_or(first)
}

// ── Renaming without ever replacing ─────────────────────────────────────────

/// Renames `from` to `to`, failing with AlreadyExists rather than replacing a
/// file there (`std::fs::rename` would replace it). A change of case only is
/// allowed on case-insensitive file systems.
#[cfg(windows)]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};
    // No MOVEFILE_REPLACE_EXISTING, no MOVEFILE_COPY_ALLOWED: same volume, never over a file.
    unsafe { MoveFileExW(&HSTRING::from(from.as_os_str()), &HSTRING::from(to.as_os_str()), MOVE_FILE_FLAGS(0)) }.map_err(|e| {
        let code = e.code().0 as u32 & 0xFFFF;
        // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
        if code == 80 || code == 183 {
            io::Error::from(io::ErrorKind::AlreadyExists)
        } else {
            io::Error::from_raw_os_error(code as i32)
        }
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    const RENAME_NOREPLACE: libc::c_uint = 1;
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
    let (a, b) = (c(from)?, c(to)?);
    let rc = unsafe {
        libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), RENAME_NOREPLACE)
    };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        // Old kernels or file systems without RENAME_NOREPLACE: look, then rename.
        Some(libc::ENOSYS) | Some(libc::EINVAL) => {
            if std::fs::symlink_metadata(to).is_ok() {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            std::fs::rename(from, to)
        }
        Some(libc::EEXIST) => Err(io::Error::from(io::ErrorKind::AlreadyExists)),
        _ => Err(err),
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() && !same_name(&display_name(from), &display_name(to)) {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeDisk {
        files: HashSet<String>,
    }

    impl Info for FakeDisk {
        fn exists(&self, path: &Path) -> bool {
            self.files.contains(&key(path))
        }
        fn modified(&self, _: &Path) -> Option<SystemTime> {
            None
        }
        fn is_dir(&self, path: &Path) -> bool {
            display_name(path) == "folder.v2"
        }
    }

    fn fields<'a>(stem: &'a str, ext: &'a str, n: usize, count: usize) -> Fields<'a> {
        Fields { stem, ext, n, count, date: "2026-11-03" }
    }

    #[test]
    fn pattern_words() {
        let f = fields("IMG_0042", "JPG", 3, 12);
        assert_eq!(expand("Trip {n}", &f).unwrap(), "Trip 03.JPG");
        assert_eq!(expand("{date} {name}", &f).unwrap(), "2026-11-03 IMG_0042.JPG");
        assert_eq!(expand("{name}-{n:4}", &f).unwrap(), "IMG_0042-0003.JPG");
        assert_eq!(expand("{n}.{ext}", &f).unwrap(), "03.JPG");
        assert_eq!(expand("photo.jpeg", &fields("a", "", 1, 1)).unwrap(), "photo.jpeg");
        assert_eq!(expand("{name}.png", &f).unwrap(), "IMG_0042.png.JPG", "without {{ext}} the extension stays");
        assert_eq!(expand("{name}.{ext}.bak", &f).unwrap(), "IMG_0042.JPG.bak");
        assert_eq!(expand("Trip {n}", &fields("a", "txt", 9, 9)).unwrap(), "Trip 9.txt");
        assert_eq!(expand("Trip {n}", &fields("a", "txt", 100, 100)).unwrap(), "Trip 100.txt");
        assert_eq!(expand("Trip.  ", &fields("a", "txt", 1, 1)).unwrap(), "Trip.txt");
        assert_eq!(expand("{ n }", &fields("a", "", 2, 5)).unwrap(), "2");
    }

    #[test]
    fn bad_patterns() {
        let f = fields("a", "jpg", 1, 2);
        assert_eq!(expand("{nope}", &f), Err(PatternError::Unknown("{nope}".into())));
        assert_eq!(expand("open {name", &f), Err(PatternError::Unknown("{name".into())));
        assert_eq!(expand("{n:0}", &f), Err(PatternError::Unknown("{n:0}".into())));
        assert_eq!(expand("a/b {n}", &f), Err(PatternError::BadChar('/')));
        assert_eq!(expand("why? {n}", &f), Err(PatternError::BadChar('?')));
        assert_eq!(expand("CON", &f), Err(PatternError::Reserved("CON".into())));
        assert_eq!(expand("lpt1", &f), Err(PatternError::Reserved("LPT1".into())));
        assert!(expand("COM0", &f).is_ok());
        assert_eq!(expand("  ", &fields("a", "", 1, 1)), Err(PatternError::Empty));
        assert_eq!(expand(&"x".repeat(300), &f), Err(PatternError::TooLong));
    }

    #[test]
    fn the_plan_numbers_keeps_folders_and_never_reuses_a_name() {
        let dir = PathBuf::from("/photos");
        let paths: Vec<PathBuf> = ["b.jpg", "a.png", "folder.v2", "c.jpg"].iter().map(|n| dir.join(n)).collect();
        // "Trip 2.png" is already on disk.
        let disk = FakeDisk { files: [key(&dir.join("Trip 2.png"))].into_iter().collect() };
        let planned = plan(&paths, "Trip {n}", &disk).unwrap();
        let names: Vec<String> = planned.iter().map(|(_, to)| display_name(to)).collect();
        assert_eq!(names, vec!["Trip 1.jpg", "Trip 2 (2).png", "Trip 3", "Trip 4.jpg"]);
        assert!(planned.iter().all(|(from, to)| from.parent() == to.parent()));

        // Names that collide inside the batch: numbered.
        let planned = plan(&paths, "Holiday", &disk).unwrap();
        let names: Vec<String> = planned.iter().map(|(_, to)| display_name(to)).collect();
        assert_eq!(names, vec!["Holiday.jpg", "Holiday.png", "Holiday", "Holiday (2).jpg"]);
        // The very same name for every file: refused (a missing {n}).
        let two = vec![dir.join("x.txt"), dir.join("y.txt")];
        assert!(plan(&two, "Holiday", &disk).is_err());
        let planned = plan(&two, "{n:1}", &FakeDisk { files: HashSet::new() }).unwrap();
        assert_eq!(display_name(&planned[1].1), "2.txt");
        assert!(plan(&two, "", &disk).is_err());
        assert!(plan(&two, "{bad}", &disk).is_err());
    }

    #[test]
    fn an_unchanged_name_stays_put() {
        let paths = vec![PathBuf::from("/d/Trip 1.jpg"), PathBuf::from("/d/x.jpg")];
        let disk = FakeDisk { files: ["/d/Trip 1.jpg", "/d/x.jpg"].iter().map(|s| key(Path::new(s))).collect() };
        let planned = plan(&paths, "Trip {n:1}", &disk).unwrap();
        assert_eq!(planned[0].0, planned[0].1, "already named so");
        assert_eq!(display_name(&planned[1].1), "Trip 2.jpg");
    }

    #[test]
    fn renames_on_disk_without_replacing_then_undoes() {
        let dir = std::env::temp_dir().join(format!("pod-rename-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.txt"), dir.join("b.txt"));
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"B").unwrap();
        // Never replaces.
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&b).unwrap(), b"B");

        crate::files::allow_dropped([a.to_string_lossy().to_string(), b.to_string_lossy().to_string()]);
        let job = rename_prepare(vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()]).unwrap();
        assert_eq!(job.names, vec!["a.txt", "b.txt"]);
        // Paths that weren't dropped are refused.
        assert!(rename_prepare(vec![a.to_string_lossy().to_string()]).is_err());

        let preview = rename_preview(job.id, "Note {n}".into()).unwrap();
        assert_eq!(preview, vec![
            RenameRow { from: "a.txt".into(), to: "Note 1.txt".into() },
            RenameRow { from: "b.txt".into(), to: "Note 2.txt".into() },
        ]);
        assert!(a.exists(), "a preview renames nothing");
        let done = rename_apply(job.id, "Note {n}".into()).unwrap();
        assert_eq!(done.renamed.len(), 2);
        assert_eq!(std::fs::read(dir.join("Note 1.txt")).unwrap(), b"A");
        assert_eq!(std::fs::read(dir.join("Note 2.txt")).unwrap(), b"B");
        assert!(rename_apply(job.id, "Again {n}".into()).is_err(), "once");

        // Someone took "a.txt" meanwhile: that one keeps its new name.
        std::fs::write(&a, b"new").unwrap();
        let undone = rename_undo(job.id).unwrap();
        assert_eq!(undone.renamed, vec![RenameRow { from: "Note 2.txt".into(), to: "b.txt".into() }]);
        assert_eq!(undone.failed.len(), 1);
        assert_eq!(std::fs::read(&a).unwrap(), b"new");
        assert_eq!(std::fs::read(&b).unwrap(), b"B");
        assert_eq!(std::fs::read(dir.join("Note 1.txt")).unwrap(), b"A");
        assert!(rename_undo(job.id).is_err(), "undo works once");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
