// "Text from image": the text in screenshots and photos dropped on the island,
// read on this computer by Windows' own OCR (Windows.Media.Ocr, in the
// languages of the user's profile). Nothing leaves the computer. The text is
// copied to the clipboard and saved as "<name> (text).txt" in the workspace
// folder, one file per picture; the card shows it.
//
// Linux has no OCR of its own: the action answers that it isn't available.
// Paths must come from a real drop (`files::take_dropped`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::archive::{cannot_write, create_unique, display_name};
use crate::i18n::{t, tf};
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrReport {
    /// All the text found, the pictures one after the other.
    pub text: String,
    /// The pictures text was found in.
    pub names: Vec<String>,
    /// The .txt files written, one per picture with text.
    pub outputs: Vec<String>,
    pub failed: Vec<Failure>,
    /// The text is on the clipboard.
    pub copied: bool,
}

/// Pictures the OCR is offered for (the decoder Windows has decides in the end).
pub(crate) const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff", "webp", "heic", "heif", "jxr", "ico"];

#[tauri::command]
pub async fn ocr_run(app: AppHandle, paths: Vec<String>) -> Result<OcrReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (inputs, failed) = crate::files::take_all_dropped(paths);
        let out = crate::workspace::output_dir(&app)?;
        let mut report = run(&inputs, &out, failed, recognize);
        if !report.text.is_empty() {
            report.copied = crate::clipboard::clipboard_set_text(report.text.clone()).is_ok();
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads each picture with `read` and saves what it found in `out`.
pub(crate) fn run(
    inputs: &[PathBuf],
    out: &Path,
    mut failed: Vec<Failure>,
    read: impl Fn(&Path) -> Result<String, String>,
) -> OcrReport {
    let _busy = crate::files::JobGuard::new();
    let mut found: Vec<(String, String)> = Vec::new();
    let mut outputs = Vec::new();
    for input in inputs {
        let name = display_name(input);
        let ext = crate::archive::extension(input).unwrap_or_default();
        if input.is_dir() || !IMAGE_EXTS.contains(&ext.as_str()) {
            failed.push(Failure { error: tf("{name} isn't a picture Pod can read text from.", &[("name", &name)]), name });
            continue;
        }
        let text = match read(input) {
            Ok(text) => tidy(&text),
            Err(error) => {
                failed.push(Failure { name, error });
                continue;
            }
        };
        if text.is_empty() {
            failed.push(Failure { error: tf("No text was found in {name}.", &[("name", &name)]), name });
            continue;
        }
        match save_text(out, input, &text) {
            Ok(dest) => outputs.push(dest.to_string_lossy().to_string()),
            Err(error) => failed.push(Failure { name: name.clone(), error }),
        }
        found.push((name, text));
    }
    if !found.is_empty() {
        crate::log::line(format!("ocr: text in {} picture(s)", found.len()));
    }
    let names = found.iter().map(|(name, _)| name.clone()).collect();
    OcrReport { text: combine(&found), names, outputs, failed, copied: false }
}

/// Lines trimmed at the end, no blank lines at either end.
pub(crate) fn tidy(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let start = lines.iter().position(|l| !l.trim().is_empty());
    let end = lines.iter().rposition(|l| !l.trim().is_empty());
    match (start, end) {
        (Some(s), Some(e)) => lines[s..=e].join("\n"),
        _ => String::new(),
    }
}

/// One picture: its text. Several: each one's text under its name.
pub(crate) fn combine(found: &[(String, String)]) -> String {
    match found {
        [] => String::new(),
        [(_, text)] => text.clone(),
        _ => found.iter().map(|(name, text)| format!("{name}\n{text}")).collect::<Vec<_>>().join("\n\n"),
    }
}

/// "shot.png" → "shot (text).txt".
pub(crate) fn output_name(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "image".into());
    format!("{stem} (text).txt")
}

fn save_text(out: &Path, input: &Path, text: &str) -> Result<PathBuf, String> {
    let name = output_name(input);
    // Notepad and every editor read UTF-8; Windows' own tools prefer CRLF.
    let body = if cfg!(windows) { text.replace('\n', "\r\n") } else { text.to_string() };
    let (dest, mut file) = create_unique(out, &name).map_err(|e| cannot_write(&name, &e))?;
    if let Err(e) = file.write_all(body.as_bytes()).and_then(|_| file.flush()) {
        drop(file);
        let _ = fs::remove_file(&dest);
        return Err(cannot_write(&name, &e));
    }
    Ok(dest)
}

// ── Windows.Media.Ocr ───────────────────────────────────────────────────────

/// The text Windows' OCR reads in the picture at `path`, one line per line.
#[cfg(windows)]
pub(crate) fn recognize(path: &Path) -> Result<String, String> {
    let name = display_name(path);
    let owned = path.to_path_buf();
    // A thread of its own in the multithreaded apartment: the WinRT calls are
    // waited on there (`.get()`), never on a thread that pumps messages.
    let joined = std::thread::Builder::new()
        .name("pod-ocr".into())
        .spawn(move || {
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
            let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let result = recognize_now(&owned);
            if init.is_ok() {
                unsafe { CoUninitialize() };
            }
            result
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| t("The image could not be read."))?;
    joined.map_err(|e| match e {
        OcrFailure::NoLanguage => t("Windows has no text recognition for your languages. Add a language with its optical character recognition in Settings → Time & language → Language & region."),
        OcrFailure::Decode(detail) => {
            crate::log::line(format!("ocr: cannot decode {name}: {detail}"));
            tf("{name} couldn't be opened as a picture.", &[("name", &name)])
        }
        OcrFailure::Other(detail) => {
            crate::log::line(format!("ocr: {name}: {detail}"));
            tf("Couldn't read the text in {name}: {error}", &[("name", &name), ("error", &detail)])
        }
    })
}

#[cfg(windows)]
enum OcrFailure {
    NoLanguage,
    Decode(String),
    Other(String),
}

#[cfg(windows)]
fn recognize_now(path: &Path) -> Result<String, OcrFailure> {
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform,
        ColorManagementMode, ExifOrientationMode,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let other = |e: windows::core::Error| OcrFailure::Other(e.message().to_string());
    let decode = |e: windows::core::Error| OcrFailure::Decode(e.message().to_string());

    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| OcrFailure::NoLanguage)?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))
        .and_then(|op| op.get())
        .map_err(other)?;
    let stream = file.OpenAsync(FileAccessMode::Read).and_then(|op| op.get()).map_err(other)?;
    let decoder = BitmapDecoder::CreateAsync(&stream).and_then(|op| op.get()).map_err(decode)?;

    // The OCR refuses pictures past MaxImageDimension on either side: scaled
    // down to fit, the same factor both ways.
    let transform = BitmapTransform::new().map_err(other)?;
    let (w, h) = (decoder.PixelWidth().map_err(decode)?, decoder.PixelHeight().map_err(decode)?);
    let max = OcrEngine::MaxImageDimension().unwrap_or(10_000).max(1);
    if let Some((sw, sh)) = fit_within(w, h, max) {
        transform.SetScaledWidth(sw).map_err(other)?;
        transform.SetScaledHeight(sh).map_err(other)?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant).map_err(other)?;
    }
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .and_then(|op| op.get())
        .map_err(decode)?;
    let result = engine.RecognizeAsync(&bitmap).and_then(|op| op.get()).map_err(other)?;
    let mut text = String::new();
    for line in result.Lines().map_err(other)? {
        text.push_str(&line.Text().map_err(other)?.to_string_lossy());
        text.push('\n');
    }
    Ok(text)
}

#[cfg(not(windows))]
pub(crate) fn recognize(_path: &Path) -> Result<String, String> {
    Err(t("Text from image isn't available on this system yet."))
}

/// The size a `w`×`h` picture is scaled to so neither side passes `max`; None
/// when it already fits.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn fit_within(w: u32, h: u32, max: u32) -> Option<(u32, u32)> {
    let longest = w.max(h);
    if longest <= max {
        return None;
    }
    let scale = max as f64 / longest as f64;
    let side = |v: u32| ((v as f64 * scale).floor() as u32).clamp(1, max);
    Some((side(w), side(h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pod-ocr-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn text_is_tidied_and_combined() {
        assert_eq!(tidy("\n\n  Hello  \nworld\t\n\n"), "  Hello\nworld");
        assert_eq!(tidy(" \n \n"), "");
        assert_eq!(combine(&[]), "");
        assert_eq!(combine(&[("a.png".into(), "one".into())]), "one");
        assert_eq!(combine(&[("a.png".into(), "one".into()), ("b.png".into(), "two".into())]), "a.png\none\n\nb.png\ntwo");
        assert_eq!(output_name(Path::new("C:/s/Screenshot 1.png")), "Screenshot 1 (text).txt");
    }

    #[test]
    fn big_pictures_are_scaled_to_fit() {
        assert_eq!(fit_within(800, 600, 10_000), None);
        assert_eq!(fit_within(20_000, 5_000, 10_000), Some((10_000, 2_500)));
        assert_eq!(fit_within(3, 40_000, 10_000), Some((1, 10_000)));
    }

    #[test]
    fn one_text_file_per_picture_in_the_workspace_never_overwriting() {
        let dir = temp_dir("run");
        let ws = dir.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let (a, b, blank, notes) = (dir.join("a.png"), dir.join("b.jpg"), dir.join("blank.png"), dir.join("notes.txt"));
        for p in [&a, &b, &blank, &notes] {
            fs::write(p, b"x").unwrap();
        }
        fs::write(ws.join("a (text).txt"), b"taken").unwrap();
        let read = |p: &Path| -> Result<String, String> {
            match display_name(p).as_str() {
                "a.png" => Ok("Hello\nworld\n".into()),
                "b.jpg" => Ok("Second".into()),
                _ => Ok("  \n".into()),
            }
        };
        let report = run(&[a.clone(), b, blank, notes], &ws, Vec::new(), read);
        assert_eq!(report.text, "a.png\nHello\nworld\n\nb.jpg\nSecond");
        assert_eq!(report.names, vec!["a.png", "b.jpg"]);
        assert_eq!(report.outputs.len(), 2);
        assert_eq!(report.failed.len(), 2, "no text in blank.png, notes.txt isn't a picture");
        let first = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&first), "a (text) (2).txt");
        assert_eq!(first.parent().unwrap(), ws.as_path());
        let saved = fs::read_to_string(&first).unwrap();
        assert_eq!(saved.replace("\r\n", "\n"), "Hello\nworld");
        assert_eq!(fs::read(ws.join("a (text).txt")).unwrap(), b"taken");
        assert_eq!(fs::read(&a).unwrap(), b"x");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Big block letters drawn into a PNG, read back by the real Windows OCR.
    /// Needs an OCR language on the machine (English comes with Windows).
    #[cfg(windows)]
    #[test]
    fn reads_text_from_a_generated_picture() {
        use image::{Rgb, RgbImage};
        // A 5×7 font, just the letters needed.
        let glyph = |c: char| -> [&str; 7] {
            match c {
                'H' => ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
                'E' => ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
                'L' => ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
                'O' => [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
                _ => [".....", ".....", ".....", ".....", ".....", ".....", "....."],
            }
        };
        let text = "HELLO HELLO";
        let (scale, margin) = (8u32, 40u32);
        let w = margin * 2 + text.len() as u32 * 6 * scale;
        let h = margin * 2 + 7 * scale;
        let mut img = RgbImage::from_pixel(w, h, Rgb([255, 255, 255]));
        for (i, c) in text.chars().enumerate() {
            for (row, bits) in glyph(c).iter().enumerate() {
                for (col, bit) in bits.chars().enumerate() {
                    if bit != '#' {
                        continue;
                    }
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let x = margin + (i as u32 * 6 + col as u32) * scale + dx;
                            let y = margin + row as u32 * scale + dy;
                            img.put_pixel(x, y, Rgb([0, 0, 0]));
                        }
                    }
                }
            }
        }
        let dir = temp_dir("real");
        let png = dir.join("hello.png");
        img.save(&png).unwrap();
        let read = recognize(&png).expect("Windows OCR");
        let words: String = read.to_uppercase().chars().filter(|c| c.is_ascii_alphabetic()).collect();
        assert!(words.contains("HELLO"), "read {read:?}");
        let report = run(&[png], &dir, Vec::new(), recognize);
        assert_eq!(report.outputs.len(), 1, "{:?}", report.failed);
        fs::remove_dir_all(&dir).unwrap();
    }
}
