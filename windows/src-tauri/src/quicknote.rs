// Quick note: text typed in the island's Notes tab saved as a Markdown file on
// the shelf (in the workspace folder), and read back to edit.
//
// The page names a note only to rewrite or read it, and only a plain ".md" name
// of a file already in the workspace is accepted: no folders, no other files.
// A note is written whole to a temporary file and then renamed over the old
// one, so a crash never leaves half a note.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::i18n::{t, tf};
use crate::platform::LocalTime;

/// Largest note written or read: notes are typed, not dumps.
const MAX_BYTES: usize = 1024 * 1024;

/// Writes `text` to the workspace. `name` None creates "Note 2026-11-03 14.05.md"
/// (unique); Some(name) rewrites that existing note (a plain .md name in the
/// workspace, nothing else). Returns the note's name.
#[tauri::command]
pub fn note_save(app: AppHandle, name: Option<String>, text: String) -> Result<String, String> {
    if text.len() > MAX_BYTES {
        return Err(t("Notes are limited to 1 MB."));
    }
    let ws = crate::workspace::dir(&app);
    let is_new = name.is_none();
    let path = match name {
        Some(name) => existing_note(&ws, &name)?,
        None => {
            std::fs::create_dir_all(&ws).map_err(|e| save_error(&e))?;
            // Claimed (an empty file) so the rename below can't replace a file
            // that took the name since `unique_path` looked.
            let name = note_name(&crate::platform::local_time());
            let (path, _) = crate::archive::create_unique(&ws, &name).map_err(|e| save_error(&e))?;
            path
        }
    };
    if let Err(e) = write_atomic(&path, text.as_bytes()) {
        if is_new {
            // Only the empty file claimed above: no empty note is left on the shelf.
            let _ = std::fs::remove_file(&path);
        }
        return Err(save_error(&e));
    }
    Ok(file_name(&path))
}

/// Reads a .md note from the workspace (at most 1 MB).
#[tauri::command]
pub fn note_read(app: AppHandle, name: String) -> Result<String, String> {
    let path = existing_note(&crate::workspace::dir(&app), &name)?;
    let file = std::fs::File::open(&path).map_err(|e| read_error(&e))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| read_error(&e))?;
    if bytes.len() > MAX_BYTES {
        return Err(t("Notes are limited to 1 MB."));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ── Names ─────────────────────────────────────────────────────────────────────

/// "Note 2026-11-03 14.05.md": dots, not colons, which Windows refuses in names.
pub(crate) fn note_name(now: &LocalTime) -> String {
    format!(
        "Note {:04}-{:02}-{:02} {:02}.{:02}.md",
        now.year, now.month, now.day, now.hour, now.minute
    )
}

/// A plain file name ending in ".md": no folder part, nothing hidden, no
/// character Windows or Linux would read as a path.
pub(crate) fn is_note_name(name: &str) -> bool {
    let Some(stem) = name.get(..name.len().saturating_sub(3)) else { return false };
    name.len() <= 255
        && name.len() > 3
        && name[stem.len()..].eq_ignore_ascii_case(".md")
        && !stem.trim().is_empty()
        && !name.starts_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
}

/// The workspace path of the note `name`, which must be a regular file there.
fn existing_note(ws: &Path, name: &str) -> Result<PathBuf, String> {
    let missing = || t("This note can't be found on the shelf.");
    if !is_note_name(name) {
        return Err(missing());
    }
    let path = ws.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(path),
        _ => Err(missing()),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn save_error(e: &std::io::Error) -> String {
    tf("Couldn't save the note: {error}", &[("error", &e.to_string())])
}

fn read_error(e: &std::io::Error) -> String {
    tf("Couldn't read the note: {error}", &[("error", &e.to_string())])
}

// ── Writing ───────────────────────────────────────────────────────────────────

/// Writes `bytes` beside `path` and renames the copy over it: the note is
/// either the old one or the new one, never half of each.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".{}.{}.tmp", file_name(path), std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_carry_the_local_time() {
        let now = LocalTime { year: 2026, month: 11, day: 3, hour: 14, minute: 5, second: 12 };
        assert_eq!(note_name(&now), "Note 2026-11-03 14.05.md");
        assert!(is_note_name(&note_name(&now)));
    }

    #[test]
    fn only_plain_markdown_names_are_notes() {
        for good in ["Note 2026-11-03 14.05.md", "ideas.md", "Plan (2).MD", "é.md"] {
            assert!(is_note_name(good), "{good}");
        }
        for bad in [
            "", ".md", "  .md", ".hidden.md", "notes.txt", "notes.md.exe", "../x.md", "a/b.md",
            "a\\b.md", "C:x.md", "C:\\x.md", "/etc/x.md", "x.md ", "a\nb.md", "a*b.md", "..",
        ] {
            assert!(!is_note_name(bad), "{bad:?}");
        }
        assert!(!is_note_name(&format!("{}.md", "a".repeat(253))));
    }

    #[test]
    fn a_note_is_only_rewritten_when_it_is_already_there() {
        let ws = std::env::temp_dir().join(format!("pod-notes-{}", std::process::id()));
        std::fs::create_dir_all(ws.join("folder.md")).unwrap();
        assert!(existing_note(&ws, "missing.md").is_err());
        assert!(existing_note(&ws, "folder.md").is_err());

        let path = ws.join("today.md");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(existing_note(&ws, "today.md").unwrap(), path);
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        // No temporary file left behind.
        let left: Vec<_> = std::fs::read_dir(&ws).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 2, "{left:?}");
        let _ = std::fs::remove_dir_all(&ws);
    }
}
