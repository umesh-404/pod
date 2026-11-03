// "SHA-256": the checksum of files dropped on the island, to compare with the
// one a download page publishes. Files are streamed (never held whole in
// memory) on a worker thread, with progress for big ones; nothing is written.
// The card compares the result with a hash on the clipboard (views/files.ts).
//
// Paths must come from a real drop (`files::take_dropped`).

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::archive::display_name;
use crate::i18n::tf;
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHash {
    pub name: String,
    /// Lowercase hex, 64 digits.
    pub sha256: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HashReport {
    pub hashes: Vec<FileHash>,
    pub failed: Vec<Failure>,
    pub cancelled: bool,
}

/// `hash-progress`: the job's fraction over all its files, 0…1.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct HashProgress {
    id: u64,
    fraction: f64,
}

const CHUNK: usize = 1024 * 1024;
/// Progress events, at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(120);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static RUNNING: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);

fn running<R>(f: impl FnOnce(&mut HashMap<u64, Arc<AtomicBool>>) -> R) -> R {
    let mut guard = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// A new job id: the page passes it to `hash_run` and, to stop it, `hash_cancel`.
#[tauri::command]
pub fn hash_new_job() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

/// Hashes the dropped files in order. `hash-progress` events carry `id`.
#[tauri::command]
pub async fn hash_run(app: AppHandle, id: u64, paths: Vec<String>) -> Result<HashReport, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    running(|jobs| jobs.insert(id, cancel.clone()));
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _busy = crate::files::JobGuard::new();
        let (inputs, mut failed) = crate::files::take_all_dropped(paths);
        let sizes: Vec<u64> = inputs.iter().map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)).collect();
        let total: u64 = sizes.iter().sum::<u64>().max(1);
        let mut before: u64 = 0;
        let mut last = Instant::now();
        let mut hashes = Vec::new();
        let mut cancelled = false;
        for (path, size) in inputs.iter().zip(&sizes) {
            let mut on_bytes = |done: u64| {
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    let fraction = ((before + done) as f64 / total as f64).clamp(0.0, 1.0);
                    let _ = app.emit("hash-progress", HashProgress { id, fraction });
                }
            };
            match hash_file(path, &cancel, &mut on_bytes) {
                Ok(Some(sha256)) => hashes.push(FileHash { name: display_name(path), sha256, size: *size }),
                Ok(None) => {
                    cancelled = true;
                    break;
                }
                Err(error) => failed.push(Failure { name: display_name(path), error }),
            }
            before += size;
        }
        HashReport { hashes, failed, cancelled }
    })
    .await
    .map_err(|e| e.to_string());
    running(|jobs| jobs.remove(&id));
    result
}

#[tauri::command]
pub fn hash_cancel(id: u64) {
    running(|jobs| {
        if let Some(flag) = jobs.get(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    });
}

/// SHA-256 of `path`, streamed; None when cancelled. `on_bytes` gets the bytes read so far.
fn hash_file(path: &Path, cancel: &AtomicBool, on_bytes: &mut dyn FnMut(u64)) -> Result<Option<String>, String> {
    let name = display_name(path);
    let meta = std::fs::metadata(path).map_err(|e| cannot_read(&name, &e))?;
    if meta.is_dir() {
        return Err(tf("{name} is a folder: drop the files inside it.", &[("name", &name)]));
    }
    let file = File::open(path).map_err(|e| cannot_read(&name, &e))?;
    hash_reader(file, cancel, on_bytes).map_err(|e| cannot_read(&name, &e))
}

/// SHA-256 of everything `reader` gives, a chunk at a time; None when cancelled.
fn hash_reader(mut reader: impl Read, cancel: &AtomicBool, on_bytes: &mut dyn FnMut(u64)) -> io::Result<Option<String>> {
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        context.update(&buf[..n]);
        done += n as u64;
        on_bytes(done);
    }
    Ok(Some(hex(context.finish().as_ref())))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cannot_read(name: &str, error: &dyn std::fmt::Display) -> String {
    tf("Cannot read {path}: {error}", &[("path", name), ("error", &error.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(data: &[u8]) -> String {
        hash_reader(data, &AtomicBool::new(false), &mut |_| {}).unwrap().unwrap()
    }

    #[test]
    fn known_digests() {
        assert_eq!(sha(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn streams_in_chunks_with_progress_and_the_same_digest() {
        // Bigger than one chunk, not a multiple of it.
        let data: Vec<u8> = (0..(CHUNK * 2 + 12_345)).map(|i| (i % 251) as u8).collect();
        let whole = hex(ring::digest::digest(&ring::digest::SHA256, &data).as_ref());
        let mut seen = Vec::new();
        let got = hash_reader(&data[..], &AtomicBool::new(false), &mut |n| seen.push(n)).unwrap().unwrap();
        assert_eq!(got, whole);
        assert_eq!(*seen.last().unwrap(), data.len() as u64);
        assert!(seen.len() >= 3 && seen.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn cancelled_gives_nothing() {
        assert_eq!(hash_reader(&b"abc"[..], &AtomicBool::new(true), &mut |_| {}).unwrap(), None);
    }

    #[test]
    fn files_and_folders() {
        let dir = std::env::temp_dir().join(format!("pod-hash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"abc").unwrap();
        let flag = AtomicBool::new(false);
        assert_eq!(
            hash_file(&file, &flag, &mut |_| {}).unwrap().as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert!(hash_file(&dir, &flag, &mut |_| {}).is_err(), "a folder");
        assert!(hash_file(&dir.join("missing"), &flag, &mut |_| {}).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
