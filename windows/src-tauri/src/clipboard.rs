// Clipboard text for the smart clipboard actions (decode a JWT, pretty-print
// JSON, Base64, Unix timestamps…). The actions themselves are in
// src/core/smart-clip.ts; Rust only reads and writes the text.
//
// One arboard clipboard is kept for the app's life: on Linux the text Pod puts
// on the clipboard is served by that object, and would vanish with it.

use std::sync::Mutex;

use arboard::Clipboard;

use crate::i18n::{t, tf};

/// Larger text is not something the smart actions work on.
const MAX_BYTES: usize = 1024 * 1024;

static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);

fn with_clipboard<R>(f: impl FnOnce(&mut Clipboard) -> Result<R, arboard::Error>) -> Result<R, arboard::Error> {
    let mut guard = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Clipboard::new()?);
    }
    let clipboard = guard.as_mut().expect("just set");
    f(clipboard)
}

/// The clipboard's text, None when it holds none (or more than 1 MB).
#[tauri::command]
pub fn clipboard_text() -> Option<String> {
    let text = with_clipboard(|c| c.get_text()).ok()?;
    within_limit(text)
}

#[tauri::command]
pub fn clipboard_set_text(text: String) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err(t("Clipboard text is limited to 1 MB."));
    }
    with_clipboard(|c| c.set_text(text))
        .map_err(|e| tf("Couldn't use the clipboard: {error}", &[("error", &e.to_string())]))
}

/// Empty text counts as none, and so does text over the cap.
fn within_limit(text: String) -> Option<String> {
    (!text.is_empty() && text.len() <= MAX_BYTES).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_text_up_to_one_megabyte_is_handed_over() {
        assert_eq!(within_limit("eyJhbGciOi".into()).as_deref(), Some("eyJhbGciOi"));
        assert_eq!(within_limit(String::new()), None);
        assert!(within_limit("x".repeat(MAX_BYTES)).is_some());
        assert_eq!(within_limit("x".repeat(MAX_BYTES + 1)), None);
    }
}
