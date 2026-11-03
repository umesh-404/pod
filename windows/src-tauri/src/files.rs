// Dropped files are copied into %LOCALAPPDATA%\Pod\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// Jobs working on the user's files right now (a conversion, a zip, a resize,
/// PDF tools): an automatic update waits until there are none (update.rs).
static ACTIVE_JOBS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Held for as long as a job works on files.
pub(crate) struct JobGuard(());

impl JobGuard {
    pub(crate) fn new() -> Self {
        ACTIVE_JOBS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        JobGuard(())
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        ACTIVE_JOBS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Some job is working on files.
pub(crate) fn busy() -> bool {
    ACTIVE_JOBS.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// The paths of `paths` a real drop delivered (each used up, every one checked),
/// and a failure for each of the others.
pub(crate) fn take_all_dropped(paths: Vec<String>) -> (Vec<PathBuf>, Vec<crate::workspace::Failure>) {
    let mut inputs = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        let src = PathBuf::from(&path);
        if take_dropped(&path) {
            inputs.push(src);
        } else {
            let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(path);
            failed.push(crate::workspace::Failure { name, error: crate::i18n::t("Only files dropped on the island can be used.") });
        }
    }
    (inputs, failed)
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

// ── Paths a real drop delivered ─────────────────────────────────────────────
//
// `ingest_file` is callable from the page, so on its own it would copy any file
// the user can read (a script injected into the page could pull in ~/.ssh).
// Only paths the OS just delivered through a real drop are accepted: WebView2's
// drop objects on Windows (webview_drop.rs), Tauri's drag-drop window event
// elsewhere (lib.rs). Each is good once, for a couple of minutes.

const DROP_VALID_FOR: Duration = Duration::from_secs(120);
const DROP_MAX_PENDING: usize = 64;

static DROPPED: std::sync::Mutex<Vec<(String, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// Records paths that came from a real drop.
pub fn allow_dropped<I: IntoIterator<Item = String>>(paths: I) {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    for p in paths {
        list.push((p, now));
    }
    let excess = list.len().saturating_sub(DROP_MAX_PENDING);
    list.drain(..excess);
}

/// True (once) when `path` was delivered by a drop in the last couple of minutes.
pub(crate) fn take_dropped(path: &str) -> bool {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    match list.iter().position(|(p, _)| p == path) {
        Some(i) => {
            list.remove(i);
            true
        }
        None => false,
    }
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    if !take_dropped(source) {
        return Err(crate::i18n::t("Only files dropped on the island can be added."));
    }
    let src = Path::new(source);
    let meta = std::fs::metadata(src)
        .map_err(|e| crate::i18n::tf("Cannot read {path}: {error}", &[("path", source), ("error", &e.to_string())]))?;
    if meta.is_dir() {
        return Err(crate::i18n::t("Folders can't be dropped yet."));
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let dest = unique_path(&dir, &name);

    std::fs::copy(src, &dest).map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// `dir/name`, or `dir/stem (2).ext`, `(3)`… when that is taken: nothing is
/// ever overwritten. A folder's name keeps its dots ("v1.2" → "v1.2 (2)").
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let as_path = Path::new(name);
    let (stem, ext) = match (as_path.file_stem(), as_path.extension()) {
        (Some(stem), Some(ext)) if !first.is_dir() => {
            (stem.to_string_lossy().to_string(), format!(".{}", ext.to_string_lossy()))
        }
        _ => (name.to_string(), String::new()),
    };
    (2..10_000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ── Files a browser drops (no path of their own) ─────────────────────────────

/// Largest dropped file taken from its bytes (a picture or a short clip from a web page).
const MAX_BYTES_DROP: usize = 512 * 1024 * 1024;

/// A file dragged out of a browser (a WhatsApp Web picture, an image on a
/// page) is a "virtual" file: WebView2 hands over its bytes but no path. The
/// page sends those bytes here (raw body, the name in `x-pod-name`,
/// URI-encoded); they are saved in the inbox under a safe, unique name and
/// that path counts as dropped, so every drop action can work on it.
#[tauri::command]
pub fn drop_save(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(crate::i18n::t("The dropped file couldn't be read."));
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES_DROP {
        return Err(crate::i18n::t("The dropped file couldn't be read."));
    }
    let raw = request.headers().get("x-pod-name").and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = safe_drop_name(&percent_decode(raw));
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = unique_path(&dir, &name);
    std::fs::write(&dest, bytes).map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    let path = dest.to_string_lossy().to_string();
    allow_dropped([path.clone()]);
    crate::log::line(format!("drop: saved a browser file ({} bytes)", bytes.len()));
    Ok(path)
}

/// `%XX` escapes (encodeURIComponent's output) back to text; anything malformed stays as is.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // Byte-wise: slicing the str could split a multi-byte character.
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A plain file name from whatever the page says: no folders, no characters
/// Windows refuses, not empty, not too long.
fn safe_drop_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']);
    let name = if trimmed.is_empty() { "dropped file" } else { trimmed };
    name.chars().take(120).collect()
}

#[cfg(test)]
mod drop_save_tests {
    use super::*;

    #[test]
    fn names_from_the_page_become_plain_safe_file_names() {
        assert_eq!(safe_drop_name("WhatsApp Image 2026-11-03.jpeg"), "WhatsApp Image 2026-11-03.jpeg");
        assert_eq!(safe_drop_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(safe_drop_name("a/b/c.png"), "c.png");
        assert_eq!(safe_drop_name("what?.png"), "what_.png");
        assert_eq!(safe_drop_name(""), "dropped file");
        assert_eq!(safe_drop_name("..."), "dropped file");
        assert_eq!(safe_drop_name(&"x".repeat(300)).len(), 120);
    }

    #[test]
    fn uri_escapes_decode() {
        assert_eq!(percent_decode("WhatsApp%20Image%20%C3%A9.jpeg"), "WhatsApp Image é.jpeg");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("%é1"), "%é1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("pod-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let drop = |p: &Path| allow_dropped([p.to_string_lossy().to_string()]);
        drop(&source);
        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        drop(&source);
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        drop(&tmp);
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        drop(&old_source);
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    // One test: the list is process-wide and tests run in parallel.
    #[test]
    fn only_a_dropped_path_is_ingested_once_and_the_list_stays_bounded() {
        let p = "/tmp/pod-test-not-dropped.txt".to_string();
        assert!(ingest(&p).is_err(), "never dropped");
        allow_dropped([p.clone()]);
        assert!(take_dropped(&p));
        assert!(!take_dropped(&p), "good once");

        allow_dropped((0..200).map(|i| format!("/tmp/bounded-{i}")));
        assert!(DROPPED.lock().unwrap().len() <= DROP_MAX_PENDING);
        assert!(take_dropped("/tmp/bounded-199"));
        assert!(!take_dropped("/tmp/bounded-0"));
    }
}
