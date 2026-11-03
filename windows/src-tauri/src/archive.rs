// "Zip / Unzip": files and folders dropped on the island become one .zip in the
// workspace folder; .zip files dropped on it are extracted into a folder there.
//
// The rules, because these are the user's own files:
//   * only paths a real drop just delivered are used (files::take_dropped);
//   * nothing is ever overwritten: the archive or the folder gets " (2)", " (3)"…;
//   * an archive is checked whole before anything is written: an entry that would
//     land outside its folder (zip-slip: "..", absolute paths, drive letters) stops
//     it, symbolic links are skipped, and one that would unpack past 20 GB or with
//     an impossible compression ratio is refused;
//   * a half-made archive or a half-extracted folder is removed;
//   * everything is streamed: no file is ever held whole in memory.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::i18n::{t, tf};
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    /// "zip" when an archive was made, "unzip" when archives were extracted.
    pub mode: String,
    /// Full paths written: the .zip, or the extracted folders.
    pub outputs: Vec<String>,
    pub failed: Vec<Failure>,
}

/// Most an archive may unpack to, all entries together.
const MAX_EXTRACTED: u64 = 20_000_000_000;
/// Deflate cannot do better than about 1032:1; an entry claiming more is lying.
const MAX_RATIO: u64 = 1_100;
/// Ratios are only looked at past this size: tiny entries compress oddly.
const RATIO_FROM: u64 = 1 << 20;
const MAX_ENTRIES: usize = 1_000_000;

/// Already-compressed formats are stored as they are: deflating them again
/// costs time and saves nothing.
const STORED_EXTS: &[&str] = &[
    "zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "zst", "jpg", "jpeg", "png", "gif", "webp", "heic", "avif", "mp3",
    "m4a", "aac", "ogg", "opus", "flac", "mp4", "m4v", "mov", "mkv", "webm", "avi", "docx", "xlsx", "pptx", "odt",
    "ods", "odp", "epub", "jar", "apk", "pdf",
];

#[tauri::command]
pub async fn archive_run(app: AppHandle, paths: Vec<String>) -> Result<ArchiveReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut failed = Vec::new();
        let mut inputs = Vec::new();
        for path in paths {
            let src = PathBuf::from(&path);
            // Checked first and for every path, so each drop is good only once.
            if crate::files::take_dropped(&path) {
                inputs.push(src);
            } else {
                failed.push(Failure { name: display_name(&src), error: t("Only files dropped on the island can be used.") });
            }
        }
        let out = crate::workspace::output_dir(&app)?;
        Ok(run(&inputs, &out, failed))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Zips `inputs`, or extracts them when every one is a .zip, into `out`.
pub(crate) fn run(inputs: &[PathBuf], out: &Path, mut failed: Vec<Failure>) -> ArchiveReport {
    let _busy = crate::files::JobGuard::new();
    let mut usable = Vec::new();
    for input in inputs {
        if input.file_name().is_none() {
            failed.push(Failure { name: display_name(input), error: t("Pod can't zip a whole drive.") });
        } else {
            usable.push(input.clone());
        }
    }
    let unzip = !usable.is_empty() && usable.iter().all(|p| is_zip(p));
    let mut outputs = Vec::new();
    if unzip {
        for archive in &usable {
            match extract(archive, out) {
                Ok(dir) => outputs.push(dir.to_string_lossy().to_string()),
                Err(error) => failed.push(Failure { name: display_name(archive), error }),
            }
        }
    } else if !usable.is_empty() {
        match create(&usable, out) {
            Ok(dest) => outputs.push(dest.to_string_lossy().to_string()),
            Err(failure) => failed.push(failure),
        }
    }
    if !outputs.is_empty() {
        crate::log::line(format!("archive: {} → {} output(s)", if unzip { "unzip" } else { "zip" }, outputs.len()));
    }
    ArchiveReport { mode: if unzip { "unzip" } else { "zip" }.into(), outputs, failed }
}

// ── Shared helpers (resize.rs and pdf.rs use them too) ──────────────────────

pub(crate) fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Lowercase extension of `path`, if any.
pub(crate) fn extension(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).filter(|e| !e.is_empty())
}

pub(crate) fn cannot_write(name: &str, error: &dyn std::fmt::Display) -> String {
    tf("Cannot write {name}: {error}", &[("name", name), ("error", &error.to_string())])
}

/// Creates `dir/name` (or "name (2)"…) for writing. `create_new` means a file
/// that appeared since `unique_path` looked is never overwritten: the next
/// number is tried instead.
pub(crate) fn create_unique(dir: &Path, name: &str) -> io::Result<(PathBuf, File)> {
    for _ in 0..32 {
        let path = crate::files::unique_path(dir, name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

/// `create_unique` for a folder: a new, empty folder that is ours to fill.
pub(crate) fn create_unique_dir(dir: &Path, name: &str) -> io::Result<PathBuf> {
    for _ in 0..32 {
        let path = crate::files::unique_path(dir, name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

fn is_zip(path: &Path) -> bool {
    extension(path).as_deref() == Some("zip") && path.is_file()
}

// ── Zipping ─────────────────────────────────────────────────────────────────

/// "photos.zip" for one folder, "report.zip" for one file (as Windows' "Send to
/// compressed folder"), "Archive.zip" for several.
fn archive_name(inputs: &[PathBuf]) -> String {
    match inputs {
        [one] => {
            let base = if one.is_dir() { one.file_name() } else { one.file_stem().or(one.file_name()) };
            match base.map(|b| b.to_string_lossy().to_string()).filter(|b| !b.is_empty()) {
                Some(base) => format!("{base}.zip"),
                None => "Archive.zip".into(),
            }
        }
        _ => "Archive.zip".into(),
    }
}

fn create(inputs: &[PathBuf], out: &Path) -> Result<PathBuf, Failure> {
    let name = archive_name(inputs);
    let (dest, file) =
        create_unique(out, &name).map_err(|e| Failure { name: name.clone(), error: cannot_write(&name, &e) })?;
    match write_zip(file, inputs, &dest) {
        Ok(()) => Ok(dest),
        Err(error) => {
            let _ = fs::remove_file(&dest);
            Err(Failure { name: display_name(&dest), error })
        }
    }
}

fn write_zip(file: File, inputs: &[PathBuf], dest: &Path) -> Result<(), String> {
    let dest_name = display_name(dest);
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let mut taken = HashSet::new();
    for input in inputs {
        let top = unique_entry(&mut taken, &display_name(input));
        let meta = fs::symlink_metadata(input).map_err(|e| cannot_read(&top, &e))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            add_tree(&mut zip, input, &top, dest)?;
        } else {
            add_file(&mut zip, input, &top, &meta)?;
        }
    }
    let mut writer = zip.finish().map_err(|e| cannot_write(&dest_name, &e))?;
    writer.flush().map_err(|e| cannot_write(&dest_name, &e))?;
    Ok(())
}

/// Two dropped "notes.txt" from different folders become "notes.txt" and "notes (2).txt".
fn unique_entry(taken: &mut HashSet<String>, name: &str) -> String {
    let mut candidate = name.to_string();
    let as_path = Path::new(name);
    let (stem, ext) = match (as_path.file_stem(), as_path.extension()) {
        (Some(stem), Some(ext)) => (stem.to_string_lossy().to_string(), format!(".{}", ext.to_string_lossy())),
        _ => (name.to_string(), String::new()),
    };
    let mut i = 2;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = format!("{stem} ({i}){ext}");
        i += 1;
    }
    candidate
}

fn cannot_read(name: &str, error: &dyn std::fmt::Display) -> String {
    tf("Cannot read {path}: {error}", &[("path", name), ("error", &error.to_string())])
}

fn options_for(meta: &fs::Metadata, path: &Path) -> SimpleFileOptions {
    let stored = extension(path).is_some_and(|e| STORED_EXTS.contains(&e.as_str()));
    let mut options = SimpleFileOptions::default()
        .compression_method(if stored { CompressionMethod::Stored } else { CompressionMethod::Deflated })
        .large_file(meta.len() >= u32::MAX as u64);
    if let Some(time) = zip_time(meta) {
        options = options.last_modified_time(time);
    }
    options
}

/// The file's local modification time, as zip stores it (1980–2107).
fn zip_time(meta: &fs::Metadata) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let local: chrono::DateTime<chrono::Local> = meta.modified().ok()?.into();
    zip::DateTime::from_date_and_time(
        u16::try_from(local.year()).ok()?,
        local.month() as u8,
        local.day() as u8,
        local.hour() as u8,
        local.minute() as u8,
        local.second() as u8,
    )
    .ok()
}

fn add_file<W: Write + Seek>(zip: &mut ZipWriter<W>, path: &Path, entry: &str, meta: &fs::Metadata) -> Result<(), String> {
    let mut src = File::open(path).map_err(|e| cannot_read(entry, &e))?;
    zip.start_file(entry, options_for(meta, path)).map_err(|e| cannot_read(entry, &e))?;
    io::copy(&mut src, zip).map_err(|e| cannot_read(entry, &e))?;
    Ok(())
}

/// A folder and everything in it, with paths relative to the folder's parent.
/// Links are skipped (never followed), and so is the archive being written.
fn add_tree<W: Write + Seek>(zip: &mut ZipWriter<W>, root: &Path, top: &str, dest: &Path) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), top.to_string())];
    while let Some((dir, prefix)) = stack.pop() {
        let meta = fs::symlink_metadata(&dir).map_err(|e| cannot_read(&prefix, &e))?;
        let mut options = SimpleFileOptions::default();
        if let Some(time) = zip_time(&meta) {
            options = options.last_modified_time(time);
        }
        zip.add_directory(format!("{prefix}/"), options).map_err(|e| cannot_read(&prefix, &e))?;
        let mut children: Vec<_> = fs::read_dir(&dir)
            .map_err(|e| cannot_read(&prefix, &e))?
            .filter_map(|entry| entry.ok())
            .collect();
        children.sort_by_key(|entry| entry.file_name());
        let mut subdirs = Vec::new();
        for child in children {
            let path = child.path();
            if path == dest {
                continue;
            }
            let entry = format!("{prefix}/{}", child.file_name().to_string_lossy());
            let meta = fs::symlink_metadata(&path).map_err(|e| cannot_read(&entry, &e))?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                subdirs.push((path, entry));
            } else {
                add_file(zip, &path, &entry, &meta)?;
            }
        }
        // Reversed so the stack hands them back in name order.
        stack.extend(subdirs.into_iter().rev());
    }
    Ok(())
}

// ── Unzipping ───────────────────────────────────────────────────────────────

/// `name` as a path inside the target folder, or None when it could land
/// anywhere else: absolute paths, "..", drive letters and stream names (":"),
/// names Windows would fold into ".." ("..." or ". .").
pub(crate) fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('\0') || name.starts_with('/') || name.starts_with('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part.contains(':') || part.trim_end_matches(['.', ' ']).is_empty() {
            return None;
        }
        out.push(part);
    }
    let all_normal = out.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    (all_normal && out.components().next().is_some()).then_some(out)
}

#[derive(Debug, PartialEq)]
enum EntryKind {
    Dir,
    File { size: u64 },
}

#[derive(Debug)]
struct Planned {
    index: usize,
    rel: PathBuf,
    kind: EntryKind,
}

fn zip_error(error: ZipError) -> String {
    match error {
        ZipError::UnsupportedArchive(msg) if msg == ZipError::PASSWORD_REQUIRED => {
            t("This archive is password-protected, so Pod can't open it.")
        }
        ZipError::InvalidPassword => t("This archive is password-protected, so Pod can't open it."),
        other => tf("This isn't a zip archive Pod can open: {error}", &[("error", &other.to_string())]),
    }
}

fn damaged() -> String {
    t("This archive looks damaged or unsafe, so it wasn't extracted.")
}

fn too_big() -> String {
    t("This archive would unpack to more than 20 GB, so it wasn't extracted.")
}

/// Every entry, checked before anything is written.
fn plan<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Vec<Planned>, String> {
    if archive.len() > MAX_ENTRIES {
        return Err(damaged());
    }
    let mut planned = Vec::with_capacity(archive.len());
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_error)?;
        let Some(rel) = safe_relative(entry.name()) else {
            return Err(t("This archive has files that would land outside its folder, so nothing was extracted."));
        };
        if entry.is_symlink() {
            continue;
        }
        if entry.is_dir() {
            planned.push(Planned { index, rel, kind: EntryKind::Dir });
            continue;
        }
        let size = entry.size();
        total = total.saturating_add(size);
        if total > MAX_EXTRACTED {
            return Err(too_big());
        }
        if size > RATIO_FROM && size / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(damaged());
        }
        planned.push(Planned { index, rel, kind: EntryKind::File { size } });
    }
    Ok(planned)
}

fn extract(zip_path: &Path, out: &Path) -> Result<PathBuf, String> {
    let name = display_name(zip_path);
    let file = File::open(zip_path).map_err(|e| cannot_read(&name, &e))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(zip_error)?;
    let planned = plan(&mut archive)?;
    let folder = zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Archive".into());
    let target = create_unique_dir(out, &folder).map_err(|e| cannot_write(&folder, &e))?;
    match unpack(&mut archive, &planned, &target) {
        Ok(()) => Ok(target),
        Err(error) => {
            // The folder is one this call just created: removing it only removes what we wrote.
            let _ = fs::remove_dir_all(&target);
            Err(error)
        }
    }
}

fn unpack<R: Read + Seek>(archive: &mut ZipArchive<R>, planned: &[Planned], target: &Path) -> Result<(), String> {
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    for entry in planned {
        let out = target.join(&entry.rel);
        if !out.starts_with(target) {
            return Err(damaged());
        }
        let shown = entry.rel.to_string_lossy().to_string();
        let EntryKind::File { size } = entry.kind else {
            fs::create_dir_all(&out).map_err(|e| cannot_write(&shown, &e))?;
            continue;
        };
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| cannot_write(&shown, &e))?;
        }
        let file = match OpenOptions::new().write(true).create_new(true).open(&out) {
            Ok(file) => file,
            // The same name twice in one archive (or twice once case is folded):
            // the first one stays.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(cannot_write(&shown, &e)),
        };
        let mut writer = BufWriter::new(file);
        let mut reader = archive.by_index(entry.index).map_err(zip_error)?;
        let mut written: u64 = 0;
        loop {
            // A read error here is a bad checksum or broken data.
            let n = reader.read(&mut buf).map_err(|_| damaged())?;
            if n == 0 {
                break;
            }
            written += n as u64;
            total += n as u64;
            if total > MAX_EXTRACTED {
                return Err(too_big());
            }
            // More than the entry said it holds: the header lies.
            if written > size {
                return Err(damaged());
            }
            writer.write_all(&buf[..n]).map_err(|e| cannot_write(&shown, &e))?;
        }
        writer.flush().map_err(|e| cannot_write(&shown, &e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pod-archive-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn zip_slip_names_are_rejected() {
        for bad in [
            "../evil.txt",
            "a/../../evil.txt",
            "/etc/passwd",
            "\\Windows\\evil.dll",
            "C:\\evil.txt",
            "C:evil.txt",
            "a\\..\\..\\evil",
            "...",
            "a/. ./b",
            "file.txt:stream",
            "",
            "./",
        ] {
            assert_eq!(safe_relative(bad), None, "{bad:?} should be rejected");
        }
        assert_eq!(safe_relative("a/b/c.txt"), Some(PathBuf::from("a").join("b").join("c.txt")));
        assert_eq!(safe_relative("./a\\b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(safe_relative("dir/"), Some(PathBuf::from("dir")));
        assert_eq!(safe_relative("v1.2/.hidden"), Some(PathBuf::from("v1.2").join(".hidden")));
    }

    #[test]
    fn zip_slip_archive_extracts_nothing() {
        let dir = temp_dir("slip");
        let zip_path = dir.join("evil.zip");
        {
            let mut zip = ZipWriter::new(File::create(&zip_path).unwrap());
            zip.start_file("fine.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"ok").unwrap();
            zip.start_file("../escaped.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"bad").unwrap();
            zip.finish().unwrap();
        }
        let report = run(&[zip_path], &dir, Vec::new());
        assert_eq!(report.mode, "unzip");
        assert!(report.outputs.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(!dir.join("evil").exists(), "nothing is left behind");
        assert!(!dir.parent().unwrap().join("escaped.txt").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_are_chosen_like_windows() {
        let dir = temp_dir("names");
        let folder = dir.join("photos.v1");
        fs::create_dir(&folder).unwrap();
        let file = dir.join("report.pdf");
        fs::write(&file, b"x").unwrap();
        assert_eq!(archive_name(std::slice::from_ref(&folder)), "photos.v1.zip");
        assert_eq!(archive_name(std::slice::from_ref(&file)), "report.zip");
        assert_eq!(archive_name(&[folder, file]), "Archive.zip");

        let mut taken = HashSet::new();
        assert_eq!(unique_entry(&mut taken, "notes.txt"), "notes.txt");
        assert_eq!(unique_entry(&mut taken, "Notes.txt"), "Notes (2).txt");
        assert_eq!(unique_entry(&mut taken, "notes.txt"), "notes (3).txt");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zip_then_unzip_round_trip() {
        let dir = temp_dir("round");
        let folder = dir.join("project");
        fs::create_dir_all(folder.join("sub").join("empty")).unwrap();
        fs::write(folder.join("a.txt"), b"hello").unwrap();
        let big: Vec<u8> = (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect();
        fs::write(folder.join("sub").join("b.bin"), &big).unwrap();
        let loose = dir.join("loose.txt");
        fs::write(&loose, b"loose").unwrap();
        // Something already has the name: it must not be overwritten.
        fs::write(dir.join("Archive.zip"), b"keep me").unwrap();

        // Outputs go to the workspace (`ws`), not next to the originals.
        let ws = dir.join("ws");
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("Archive.zip"), b"keep me").unwrap();
        let report = run(&[folder.clone(), loose.clone()], &ws, Vec::new());
        assert_eq!(report.mode, "zip");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let made = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&made), "Archive (2).zip");
        assert_eq!(made.parent().unwrap(), ws.as_path());
        assert_eq!(fs::read(ws.join("Archive.zip")).unwrap(), b"keep me");
        assert_eq!(fs::read(dir.join("Archive.zip")).unwrap(), b"keep me");

        let report = run(&[made], &ws, Vec::new());
        assert_eq!(report.mode, "unzip");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let out = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&out), "Archive (2)");
        assert_eq!(out.parent().unwrap(), ws.as_path());
        assert_eq!(fs::read(out.join("project").join("a.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(out.join("project").join("sub").join("b.bin")).unwrap(), big);
        assert!(out.join("project").join("sub").join("empty").is_dir());
        assert_eq!(fs::read(out.join("loose.txt")).unwrap(), b"loose");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mixed_drop_zips_everything() {
        let dir = temp_dir("mixed");
        let zip_path = dir.join("old.zip");
        {
            let mut zip = ZipWriter::new(File::create(&zip_path).unwrap());
            zip.start_file("x.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        let other = dir.join("note.txt");
        fs::write(&other, b"n").unwrap();
        let report = run(&[zip_path, other], &dir, Vec::new());
        assert_eq!(report.mode, "zip");
        assert_eq!(report.outputs.len(), 1);
        assert!(report.outputs[0].ends_with("Archive.zip"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
