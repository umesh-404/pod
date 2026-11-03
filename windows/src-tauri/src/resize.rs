// "Resize image": pictures dropped on the island get a smaller copy in the
// workspace folder, "photo (1280px).jpg". Pure Rust (the `image` crate), no ffmpeg needed.
//
// The original is never touched and nothing is overwritten. The copy is upright
// (EXIF orientation applied), in the same format, never larger than the
// original: a picture already small enough is copied as it is.

use std::fs::{self, File};
use std::io::{self, BufWriter, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader};
use serde::Serialize;
use tauri::AppHandle;

use crate::archive::{create_unique, display_name, extension};
use crate::i18n::{t, tf};
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResizeReport {
    /// Full paths written.
    pub outputs: Vec<String>,
    pub failed: Vec<Failure>,
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const JPEG_QUALITY: u8 = 85;
/// Pictures resized at once: each one can take a few hundred MB decoded.
const MAX_WORKERS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Preset {
    Half,
    /// Longest side, in pixels.
    Longest(u32),
}

impl Preset {
    pub(crate) fn parse(preset: &str) -> Option<Preset> {
        match preset.trim() {
            "half" => Some(Preset::Half),
            n => n.parse::<u32>().ok().filter(|n| *n >= 16).map(Preset::Longest),
        }
    }

    fn label(self) -> String {
        match self {
            Preset::Half => "50%".into(),
            Preset::Longest(n) => format!("{n}px"),
        }
    }
}

/// `preset`: "half" (50 %), "1920", "1280" or "800" (longest side in pixels; a
/// picture already smaller is copied as it is, never enlarged). Paths must come
/// from a real drop (`files::take_dropped`).
#[tauri::command]
pub async fn resize_run(app: AppHandle, paths: Vec<String>, preset: String) -> Result<ResizeReport, String> {
    let preset = Preset::parse(&preset).ok_or_else(|| tf("Unknown size: {preset}", &[("preset", &preset)]))?;
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
        Ok(run(&inputs, preset, &out, failed))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resizes every picture in `inputs` into `out`, a couple at a time; outputs keep the input order.
pub(crate) fn run(inputs: &[PathBuf], preset: Preset, out: &Path, mut failed: Vec<Failure>) -> ResizeReport {
    let _busy = crate::files::JobGuard::new();
    let mut work = Vec::new();
    for input in inputs {
        if extension(input).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str())) {
            work.push(input.clone());
        } else {
            let name = display_name(input);
            failed.push(Failure { error: tf("{name} isn't a picture Pod can resize.", &[("name", &name)]), name });
        }
    }

    let results: Vec<Mutex<Option<Result<PathBuf, String>>>> = work.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let workers = MAX_WORKERS.min(std::thread::available_parallelism().map_or(1, |n| n.get())).min(work.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = work.get(i) else { break };
                let result = resize_one(path, preset, out);
                *results[i].lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
            });
        }
    });

    let mut outputs = Vec::new();
    for (path, slot) in work.iter().zip(results) {
        match slot.into_inner().unwrap_or_else(|e| e.into_inner()) {
            Some(Ok(dest)) => outputs.push(dest.to_string_lossy().to_string()),
            Some(Err(error)) => failed.push(Failure { name: display_name(path), error }),
            None => failed.push(Failure { name: display_name(path), error: t("The image could not be read.") }),
        }
    }
    if !outputs.is_empty() {
        crate::log::line(format!("resize: {} picture(s) at {}", outputs.len(), preset.label()));
    }
    ResizeReport { outputs, failed }
}

/// The new size for a `w`×`h` picture, or None when it is already small enough
/// (it is copied as it is: never enlarged).
pub(crate) fn target_size(w: u32, h: u32, preset: Preset) -> Option<(u32, u32)> {
    let (nw, nh) = match preset {
        Preset::Half => (w.div_ceil(2).max(1), h.div_ceil(2).max(1)),
        Preset::Longest(cap) => {
            let longest = w.max(h);
            if longest <= cap {
                return None;
            }
            let scale = cap as f64 / longest as f64;
            let fit = |side: u32| ((side as f64 * scale).round() as u32).clamp(1, cap);
            if w >= h { (cap, fit(h)) } else { (fit(w), cap) }
        }
    };
    (nw < w || nh < h).then_some((nw, nh))
}

/// "photo.jpg" → "photo (1280px).jpg", "photo (50%).jpg".
pub(crate) fn output_name(path: &Path, preset: Preset) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "image".into());
    match path.extension() {
        Some(ext) => format!("{stem} ({}).{}", preset.label(), ext.to_string_lossy()),
        None => format!("{stem} ({})", preset.label()),
    }
}

fn swaps_sides(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH
    )
}

pub(crate) fn decode_error(error: &ImageError) -> String {
    match error {
        ImageError::Limits(_) => t("The image is too large."),
        _ => t("The image could not be read."),
    }
}

fn save_error(error: &dyn std::fmt::Display) -> String {
    tf("Could not save the image: {error}", &[("error", &error.to_string())])
}

fn resize_one(path: &Path, preset: Preset, dir: &Path) -> Result<PathBuf, String> {
    let name = display_name(path);
    let reader = ImageReader::open(path)
        .map_err(|e| tf("Cannot read {path}: {error}", &[("path", &name), ("error", &e.to_string())]))?
        .with_guessed_format()
        .map_err(|e| tf("Cannot read {path}: {error}", &[("path", &name), ("error", &e.to_string())]))?;
    // Written in the format its extension says, so the name never lies.
    let format = ImageFormat::from_path(path).map_err(|e| decode_error(&e))?;
    let mut decoder = reader.into_decoder().map_err(|e| decode_error(&e))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (w, h) = decoder.dimensions();
    let (w, h) = if swaps_sides(orientation) { (h, w) } else { (w, h) };
    let out_name = output_name(path, preset);

    let Some((tw, th)) = target_size(w, h, preset) else {
        drop(decoder);
        return copy_as_is(path, dir, &out_name);
    };
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| decode_error(&e))?;
    img.apply_orientation(orientation);
    let img = img.resize_exact(tw, th, FilterType::Lanczos3);

    let (dest, file) = create_unique(dir, &out_name).map_err(|e| save_error(&e))?;
    let mut writer = BufWriter::new(file);
    let written = encode(&img, format, &mut writer).and_then(|_| writer.flush().map_err(ImageError::IoError));
    match written {
        Ok(()) => Ok(dest),
        Err(e) => {
            drop(writer);
            let _ = fs::remove_file(&dest);
            Err(save_error(&e))
        }
    }
}

fn copy_as_is(path: &Path, dir: &Path, out_name: &str) -> Result<PathBuf, String> {
    let (dest, mut file) = create_unique(dir, out_name).map_err(|e| save_error(&e))?;
    let copied = File::open(path).and_then(|mut src| io::copy(&mut src, &mut file)).and_then(|_| file.flush());
    match copied {
        Ok(()) => Ok(dest),
        Err(e) => {
            drop(file);
            let _ = fs::remove_file(&dest);
            Err(save_error(&e))
        }
    }
}

fn encode<W: Write + Seek>(img: &DynamicImage, format: ImageFormat, w: &mut W) -> image::ImageResult<()> {
    let gray = !img.color().has_color();
    let alpha = img.color().has_alpha();
    match format {
        ImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(w, JPEG_QUALITY);
            if gray { encoder.encode_image(&img.to_luma8()) } else { encoder.encode_image(&img.to_rgb8()) }
        }
        // The WebP and GIF encoders take 8-bit RGB(A) only.
        ImageFormat::WebP if alpha => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(w, format),
        ImageFormat::WebP => DynamicImage::ImageRgb8(img.to_rgb8()).write_to(w, format),
        ImageFormat::Gif => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(w, format),
        ImageFormat::Bmp if alpha => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(w, format),
        ImageFormat::Bmp => DynamicImage::ImageRgb8(img.to_rgb8()).write_to(w, format),
        _ => img.write_to(w, format),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pod-resize-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn presets_parse() {
        assert_eq!(Preset::parse("half"), Some(Preset::Half));
        assert_eq!(Preset::parse("1280"), Some(Preset::Longest(1280)));
        assert_eq!(Preset::parse("0"), None);
        assert_eq!(Preset::parse("big"), None);
    }

    #[test]
    fn dimension_math() {
        assert_eq!(target_size(4000, 3000, Preset::Longest(1280)), Some((1280, 960)));
        assert_eq!(target_size(3000, 4000, Preset::Longest(1280)), Some((960, 1280)));
        assert_eq!(target_size(1920, 1080, Preset::Longest(1920)), None, "already small: copied");
        assert_eq!(target_size(800, 600, Preset::Longest(1920)), None, "never enlarged");
        assert_eq!(target_size(10_000, 10, Preset::Longest(800)), Some((800, 1)));
        assert_eq!(target_size(1001, 501, Preset::Half), Some((501, 251)));
        assert_eq!(target_size(1, 1, Preset::Half), None);
    }

    #[test]
    fn naming() {
        assert_eq!(output_name(Path::new("C:/p/photo.jpg"), Preset::Longest(1280)), "photo (1280px).jpg");
        assert_eq!(output_name(Path::new("/p/Shot.v2.PNG"), Preset::Half), "Shot.v2 (50%).PNG");
    }

    #[test]
    fn resizes_and_copies_without_overwriting() {
        let dir = temp_dir("files");
        let big = dir.join("big.png");
        RgbImage::from_fn(400, 200, |x, _| Rgb([(x % 256) as u8, 0, 0])).save(&big).unwrap();
        let small = dir.join("small.jpg");
        RgbImage::from_pixel(100, 50, Rgb([10, 200, 30])).save(&small).unwrap();
        let text = dir.join("notes.txt");
        fs::write(&text, b"hi").unwrap();
        // Into the workspace (`ws`), not next to the originals.
        let ws = dir.join("ws");
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("big (200px).png"), b"taken").unwrap();

        let report = run(&[big.clone(), small.clone(), text], Preset::Longest(200), &ws, Vec::new());
        assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
        assert_eq!(report.outputs.len(), 2);
        let resized = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&resized), "big (200px) (2).png");
        assert_eq!(resized.parent().unwrap(), ws.as_path());
        assert_eq!(image::image_dimensions(&resized).unwrap(), (200, 100));
        assert_eq!(fs::read(ws.join("big (200px).png")).unwrap(), b"taken");
        let copied = PathBuf::from(&report.outputs[1]);
        assert_eq!(display_name(&copied), "small (200px).jpg");
        assert_eq!(fs::read(&copied).unwrap(), fs::read(&small).unwrap(), "small enough: copied as is");

        let report = run(&[small], Preset::Half, &ws, Vec::new());
        assert_eq!(image::image_dimensions(&report.outputs[0]).unwrap(), (50, 25));
        fs::remove_dir_all(&dir).unwrap();
    }
}
