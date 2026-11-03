// PDF tools and photos → PDF, all local (lopdf, no external tool).
// Outputs land next to the first input, never overwriting ("name (merged).pdf").
// Paths must come from a real drop (`files::take_dropped`).
//
// Merging and splitting copy pages into a fresh document: each page takes the
// objects it reaches (fonts, images, annotations), with the attributes it
// inherited from its page tree written onto it, and nothing else. Password-
// protected PDFs are left alone. A half-written output is removed.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegDecoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use lopdf::{dictionary, Dictionary, Document, LoadOptions, Object, ObjectId, Stream};
use serde::Serialize;
use tauri::AppHandle;

use crate::archive::{cannot_write, create_unique, create_unique_dir, display_name, extension, parent_dir};
use crate::i18n::{t, tf};
use crate::workspace::Failure;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PdfReport {
    /// Full paths written.
    pub outputs: Vec<String>,
    pub failed: Vec<Failure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Merge,
    Split,
    Rotate,
    Compress,
    Images,
}

impl Action {
    fn parse(action: &str) -> Option<Action> {
        Some(match action {
            "merge" => Action::Merge,
            "split" => Action::Split,
            "rotate" => Action::Rotate,
            "compress" => Action::Compress,
            "images" => Action::Images,
            _ => return None,
        })
    }
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
/// Most one stream may inflate to while loading or recompressing.
const MAX_STREAM: usize = 512 * 1024 * 1024;
/// The largest page PDF allows (200 inches); bigger pictures are scaled down to it.
const MAX_PAGE: f64 = 14_400.0;
const PAGE_KEYS: &[&[u8]] = &[b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// `action`:
/// - "merge": the PDFs, in the order given, into one;
/// - "split": each page of each PDF into its own file, in a folder "name (pages)";
/// - "rotate": every page by 90° clockwise;
/// - "compress": recompress streams and drop unused objects;
/// - "images": pictures (jpg, png, webp, bmp, gif, heic when decodable), in the order
///   given, into one PDF, one page each, sized to the picture.
#[tauri::command]
pub async fn pdf_run(_app: AppHandle, paths: Vec<String>, action: String) -> Result<PdfReport, String> {
    let action = Action::parse(&action).ok_or_else(|| tf("Unknown PDF action: {action}", &[("action", &action)]))?;
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
        Ok(run(action, &inputs, failed))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn run(action: Action, inputs: &[PathBuf], mut failed: Vec<Failure>) -> PdfReport {
    let _busy = crate::files::JobGuard::new();
    let mut outputs = Vec::new();
    let mut fail = |path: &Path, error: String| failed.push(Failure { name: display_name(path), error });

    if action == Action::Images {
        let mut pictures = Vec::new();
        for input in inputs {
            if extension(input).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str())) {
                pictures.push(input.clone());
            } else {
                fail(input, tf("{name} isn't a picture Pod can put in a PDF.", &[("name", &display_name(input))]));
            }
        }
        if let Some(first) = pictures.first() {
            let mut builder = Builder::new();
            for picture in &pictures {
                if let Err(error) = builder.add_picture(picture) {
                    fail(picture, error);
                }
            }
            if !builder.kids.is_empty() {
                match save(builder.finish(), &parent_dir(first), &format!("{} (images).pdf", stem(first)), false) {
                    Ok(dest) => outputs.push(dest),
                    Err(error) => fail(first, error),
                }
            }
        }
        return report(action, outputs, failed);
    }

    let mut pdfs = Vec::new();
    for input in inputs {
        if extension(input).as_deref() == Some("pdf") {
            pdfs.push(input.clone());
        } else {
            fail(input, tf("{name} isn't a PDF.", &[("name", &display_name(input))]));
        }
    }

    match action {
        Action::Merge => {
            let mut loaded = Vec::new();
            for path in &pdfs {
                match load(path) {
                    Ok(doc) => loaded.push((path.clone(), doc)),
                    Err(error) => fail(path, error),
                }
            }
            if loaded.len() < 2 {
                let at = loaded.first().map(|(p, _)| p.clone()).or_else(|| pdfs.first().cloned());
                fail(at.as_deref().unwrap_or(Path::new("PDF")), t("Drop at least two PDFs to merge them."));
            } else {
                let first = loaded[0].0.clone();
                match save(merge(loaded.iter().map(|(_, d)| d)), &parent_dir(&first), &format!("{} (merged).pdf", stem(&first)), false) {
                    Ok(dest) => outputs.push(dest),
                    Err(error) => fail(&first, error),
                }
            }
        }
        Action::Split => {
            for path in &pdfs {
                match load(path).and_then(|doc| split(&doc, path)) {
                    Ok(dir) => outputs.push(dir),
                    Err(error) => fail(path, error),
                }
            }
        }
        Action::Rotate => {
            for path in &pdfs {
                let done = load(path).and_then(|mut doc| {
                    rotate(&mut doc);
                    save(doc, &parent_dir(path), &format!("{} (rotated).pdf", stem(path)), false)
                });
                match done {
                    Ok(dest) => outputs.push(dest),
                    Err(error) => fail(path, error),
                }
            }
        }
        Action::Compress => {
            for path in &pdfs {
                match compress(path) {
                    Ok(dest) => outputs.push(dest),
                    Err(error) => fail(path, error),
                }
            }
        }
        Action::Images => unreachable!(),
    }
    report(action, outputs, failed)
}

fn report(action: Action, outputs: Vec<PathBuf>, failed: Vec<Failure>) -> PdfReport {
    if !outputs.is_empty() {
        crate::log::line(format!("pdf: {action:?} → {} output(s)", outputs.len()));
    }
    PdfReport { outputs: outputs.iter().map(|p| p.to_string_lossy().to_string()).collect(), failed }
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "PDF".into())
}

fn encrypted() -> String {
    t("This PDF is password-protected, so Pod can't change it.")
}

/// The PDF at `path`, refused when it is encrypted (even with an empty user
/// password: its owner asked for it not to be changed) or has no page.
pub(crate) fn load(path: &Path) -> Result<Document, String> {
    match Document::load_with_options(path, LoadOptions::with_max_decompressed_size(MAX_STREAM)) {
        Ok(doc) if doc.is_encrypted() || doc.was_encrypted() => Err(encrypted()),
        Ok(doc) if doc.get_pages().is_empty() => Err(t("This PDF has no pages.")),
        Ok(doc) => Ok(doc),
        Err(lopdf::Error::Decryption(_) | lopdf::Error::InvalidPassword) => Err(encrypted()),
        Err(e) => Err(tf("Cannot open this PDF: {error}", &[("error", &e.to_string())])),
    }
}

/// Writes `doc` to `dir/name` (or "name (2)"…); removes it again on failure.
/// `modern` packs objects into object streams (PDF 1.5), which is smaller.
fn save(mut doc: Document, dir: &Path, name: &str, modern: bool) -> Result<PathBuf, String> {
    let (dest, file) = create_unique(dir, name).map_err(|e| cannot_write(name, &e))?;
    let mut writer = BufWriter::new(file);
    let written = if modern { doc.save_modern(&mut writer) } else { doc.save_to(&mut writer) }
        .map_err(|e| e.to_string())
        .and_then(|_| writer.flush().map_err(|e| e.to_string()));
    drop(writer);
    match written {
        Ok(()) => Ok(dest),
        Err(e) => {
            let _ = fs::remove_file(&dest);
            Err(cannot_write(&display_name(&dest), &e))
        }
    }
}

// ── Copying pages into a new document ───────────────────────────────────────

/// A new document filled page by page.
struct Builder {
    doc: Document,
    pages_id: ObjectId,
    kids: Vec<Object>,
}

fn is_type(dict: &Dictionary, name: &[u8]) -> bool {
    dict.get(b"Type").and_then(Object::as_name).is_ok_and(|n| n == name)
}

/// The page dictionary with what it inherits from the page tree (resources,
/// boxes, rotation) written onto it, since it is leaving that tree.
fn standalone_page(src: &Document, page_id: ObjectId) -> Dictionary {
    let mut dict = src.get_dictionary(page_id).cloned().unwrap_or_else(|_| Dictionary::new());
    let mut parent = dict.get(b"Parent").and_then(Object::as_reference).ok();
    for _ in 0..64 {
        let Some(id) = parent else { break };
        let Ok(node) = src.get_dictionary(id) else { break };
        for key in PAGE_KEYS {
            if !dict.has(key) {
                if let Ok(value) = node.get(key) {
                    dict.set(key.to_vec(), value.clone());
                }
            }
        }
        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    if !dict.has(b"MediaBox") {
        // US Letter, what readers assume when a broken file has none.
        dict.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
    }
    dict.remove(b"Parent");
    dict
}

/// Points every reference in `obj` at the new document, queueing the objects
/// not copied yet. References to pages not being copied (links, annotation
/// owners) and to the old page tree become null.
fn remap(
    obj: &mut Object,
    src: &Document,
    out: &mut Document,
    map: &mut HashMap<ObjectId, ObjectId>,
    queue: &mut VecDeque<(ObjectId, ObjectId)>,
) {
    match obj {
        Object::Reference(id) => {
            if let Some(new) = map.get(id) {
                *id = *new;
                return;
            }
            match src.get_object(*id) {
                Ok(Object::Dictionary(d)) if is_type(d, b"Page") || is_type(d, b"Pages") => *obj = Object::Null,
                Err(_) => *obj = Object::Null,
                Ok(_) => {
                    let new = out.new_object_id();
                    map.insert(*id, new);
                    queue.push_back((*id, new));
                    *id = new;
                }
            }
        }
        Object::Array(items) => items.iter_mut().for_each(|o| remap(o, src, out, map, queue)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, o)| remap(o, src, out, map, queue)),
        Object::Stream(stream) => stream.dict.iter_mut().for_each(|(_, o)| remap(o, src, out, map, queue)),
        _ => {}
    }
}

impl Builder {
    fn new() -> Builder {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        Builder { doc, pages_id, kids: Vec::new() }
    }

    /// Copies `pages` of `src`, in that order. Objects they share (a font used
    /// on every page) are copied once.
    fn add_pages(&mut self, src: &Document, pages: &[ObjectId]) {
        let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
        // Pages first, so links between the copied pages keep working.
        for page in pages {
            let new = self.doc.new_object_id();
            map.insert(*page, new);
        }
        let mut queue = VecDeque::new();
        for page in pages {
            let new = map[page];
            let mut obj = Object::Dictionary(standalone_page(src, *page));
            remap(&mut obj, src, &mut self.doc, &mut map, &mut queue);
            if let Object::Dictionary(dict) = &mut obj {
                dict.set("Parent", self.pages_id);
            }
            self.doc.objects.insert(new, obj);
            self.kids.push(new.into());
        }
        // Iterative, so a long chain of objects cannot overflow the stack.
        while let Some((old, new)) = queue.pop_front() {
            let mut obj = src.get_object(old).cloned().unwrap_or(Object::Null);
            remap(&mut obj, src, &mut self.doc, &mut map, &mut queue);
            self.doc.objects.insert(new, obj);
        }
    }

    fn finish(mut self) -> Document {
        let count = self.kids.len() as i64;
        let pages = dictionary! { "Type" => "Pages", "Kids" => self.kids, "Count" => count };
        self.doc.objects.insert(self.pages_id, Object::Dictionary(pages));
        let catalog = self.doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
        self.doc.trailer.set("Root", catalog);
        self.doc.compress();
        self.doc
    }
}

fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

pub(crate) fn merge<'a>(docs: impl Iterator<Item = &'a Document>) -> Document {
    let mut builder = Builder::new();
    for doc in docs {
        builder.add_pages(doc, &page_ids(doc));
    }
    builder.finish()
}

/// Each page in its own file, "name (pages)/name p1.pdf"…; the folder is
/// removed again when a page cannot be written.
fn split(doc: &Document, path: &Path) -> Result<PathBuf, String> {
    let base = stem(path);
    let folder = format!("{base} (pages)");
    let dir = create_unique_dir(&parent_dir(path), &folder).map_err(|e| cannot_write(&folder, &e))?;
    for (i, page) in page_ids(doc).into_iter().enumerate() {
        let mut builder = Builder::new();
        builder.add_pages(doc, &[page]);
        if let Err(error) = save(builder.finish(), &dir, &format!("{base} p{}.pdf", i + 1), false) {
            // A folder this call just created: removing it only removes what we wrote.
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
    }
    Ok(dir)
}

/// The rotation a page shows with, its own or inherited, as 0, 90, 180 or 270.
fn page_rotation(doc: &Document, page_id: ObjectId) -> i64 {
    let mut id = Some(page_id);
    for _ in 0..64 {
        let Some(current) = id else { break };
        let Ok(dict) = doc.get_dictionary(current) else { break };
        if let Ok(value) = dict.get(b"Rotate").and_then(|o| doc.dereference(o)).and_then(|(_, o)| o.as_i64()) {
            return (value / 90 * 90).rem_euclid(360);
        }
        id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }
    0
}

/// Every page a quarter turn clockwise, on top of how it already shows.
pub(crate) fn rotate(doc: &mut Document) {
    for page in page_ids(doc) {
        let turned = (page_rotation(doc, page) + 90) % 360;
        if let Ok(dict) = doc.get_dictionary_mut(page) {
            dict.set("Rotate", turned);
        }
    }
}

/// Inflates plain Flate streams and deflates them again at the best level,
/// keeping the result only when it is smaller.
fn recompress_streams(doc: &mut Document) {
    for obj in doc.objects.values_mut() {
        let Object::Stream(stream) = obj else { continue };
        let plain_flate = stream.filters().is_ok_and(|f| f.len() == 1 && f[0] == b"FlateDecode")
            && !stream.dict.has(b"DecodeParms");
        if !plain_flate {
            continue;
        }
        let Ok(content) = stream.decompressed_content_with_limit(MAX_STREAM) else { continue };
        let mut dict = stream.dict.clone();
        dict.remove(b"Filter");
        let mut fresh = Stream::new(dict, content);
        if fresh.compress().is_ok() && fresh.dict.has(b"Filter") && fresh.content.len() < stream.content.len() {
            *stream = fresh;
        }
    }
}

fn compress(path: &Path) -> Result<PathBuf, String> {
    let before = fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX);
    let mut doc = load(path)?;
    recompress_streams(&mut doc);
    doc.compress();
    doc.prune_objects();
    doc.renumber_objects();
    let dest = save(doc, &parent_dir(path), &format!("{} (compressed).pdf", stem(path)), true)?;
    let after = fs::metadata(&dest).map(|m| m.len()).unwrap_or(u64::MAX);
    if after >= before {
        let _ = fs::remove_file(&dest);
        return Err(t("This PDF is already as small as Pod can make it."));
    }
    Ok(dest)
}

// ── Pictures → PDF ──────────────────────────────────────────────────────────

/// Width, height and colour components of a baseline or progressive 8-bit
/// JPEG, read from its frame header; None for anything a PDF reader may not
/// take as it is (arithmetic coding, 12-bit, CMYK is decided by the caller).
fn jpeg_frame(data: &[u8]) -> Option<(u32, u32, u8)> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            return None;
        }
        let marker = data[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        match marker {
            0xC0..=0xC2 => {
                let s = i + 4;
                let header = data.get(s..s + 6)?;
                let (precision, h, w, comps) = (
                    header[0],
                    u16::from_be_bytes([header[1], header[2]]) as u32,
                    u16::from_be_bytes([header[3], header[4]]) as u32,
                    header[5],
                );
                return (precision == 8 && w > 0 && h > 0).then_some((w, h, comps));
            }
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF | 0xDA | 0xD9 => return None,
            _ => i += 2 + len,
        }
    }
    None
}

/// The `cm` matrix drawing a `w`×`h` picture (in page units) upright on a page
/// sized to it, for each EXIF orientation: the pixels are never re-encoded.
pub(crate) fn placement(orientation: Orientation, w: f64, h: f64) -> [f64; 6] {
    match orientation {
        Orientation::NoTransforms => [w, 0.0, 0.0, h, 0.0, 0.0],
        Orientation::FlipHorizontal => [-w, 0.0, 0.0, h, w, 0.0],
        Orientation::Rotate180 => [-w, 0.0, 0.0, -h, w, h],
        Orientation::FlipVertical => [w, 0.0, 0.0, -h, 0.0, h],
        Orientation::Rotate90FlipH => [0.0, -w, -h, 0.0, h, w],
        Orientation::Rotate90 => [0.0, -w, h, 0.0, 0.0, w],
        Orientation::Rotate270FlipH => [0.0, w, h, 0.0, 0.0, 0.0],
        Orientation::Rotate270 => [0.0, w, -h, 0.0, h, 0.0],
    }
}

fn number(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == 0.0 { "0".into() } else { format!("{rounded}") }
}

fn image_stream(w: u32, h: u32, color_space: &str, filter: Option<&str>, content: Vec<u8>) -> Stream {
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => w as i64,
        "Height" => h as i64,
        "ColorSpace" => color_space,
        "BitsPerComponent" => 8,
    };
    if let Some(filter) = filter {
        dict.set("Filter", filter);
    }
    let mut stream = Stream::new(dict, content);
    if filter.is_none() {
        let _ = stream.compress();
    }
    stream.with_compression(false)
}

impl Builder {
    /// One page holding the picture at `path`, one pixel to a point.
    fn add_picture(&mut self, path: &Path) -> Result<(), String> {
        let name = display_name(path);
        let unreadable = |e: &dyn std::fmt::Display| tf("Cannot read {path}: {error}", &[("path", &name), ("error", &e.to_string())]);
        let reader = ImageReader::open(path).map_err(|e| unreadable(&e))?.with_guessed_format().map_err(|e| unreadable(&e))?;

        if reader.format() == Some(ImageFormat::Jpeg) {
            let data = fs::read(path).map_err(|e| unreadable(&e))?;
            if let Some((w, h, comps @ (1 | 3))) = jpeg_frame(&data) {
                let orientation = JpegDecoder::new(Cursor::new(&data))
                    .and_then(|mut d| d.orientation())
                    .unwrap_or(Orientation::NoTransforms);
                let space = if comps == 1 { "DeviceGray" } else { "DeviceRGB" };
                let stream = image_stream(w, h, space, Some("DCTDecode"), data);
                self.add_image_page(stream, None, w, h, orientation);
                return Ok(());
            }
        }

        let mut decoder = reader.into_decoder().map_err(|e| crate::resize::decode_error(&e))?;
        let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
        let img = DynamicImage::from_decoder(decoder).map_err(|e| crate::resize::decode_error(&e))?;
        let (w, h) = (img.width(), img.height());
        let gray = !img.color().has_color();
        let (space, pixels, alpha) = match (gray, img.color().has_alpha()) {
            (true, false) => ("DeviceGray", img.into_luma8().into_raw(), None),
            (false, false) => ("DeviceRGB", img.into_rgb8().into_raw(), None),
            (true, true) => {
                let la = img.into_luma_alpha8().into_raw();
                ("DeviceGray", la.iter().step_by(2).copied().collect(), Some(la.iter().skip(1).step_by(2).copied().collect::<Vec<u8>>()))
            }
            (false, true) => {
                let rgba = img.into_rgba8().into_raw();
                let rgb = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
                ("DeviceRGB", rgb, Some(rgba.chunks_exact(4).map(|p| p[3]).collect::<Vec<u8>>()))
            }
        };
        // A fully opaque alpha channel is dropped: it would only cost bytes.
        let mask = alpha.filter(|a| a.iter().any(|&v| v != 255)).map(|a| image_stream(w, h, "DeviceGray", None, a));
        self.add_image_page(image_stream(w, h, space, None, pixels), mask, w, h, orientation);
        Ok(())
    }

    fn add_image_page(&mut self, mut image: Stream, mask: Option<Stream>, w: u32, h: u32, orientation: Orientation) {
        if let Some(mask) = mask {
            let mask_id = self.doc.add_object(mask);
            image.dict.set("SMask", mask_id);
        }
        let image_id = self.doc.add_object(image);
        let swapped = matches!(
            orientation,
            Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH
        );
        let (pw, ph) = if swapped { (h as f64, w as f64) } else { (w as f64, h as f64) };
        let scale = (MAX_PAGE / pw.max(ph)).min(1.0);
        let m = placement(orientation, w as f64 * scale, h as f64 * scale);
        let content = format!("q {} cm /Im0 Do Q", m.iter().map(|v| number(*v)).collect::<Vec<_>>().join(" "));
        let content_id = self.doc.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
        let page = dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real((pw * scale) as f32), Object::Real((ph * scale) as f32)],
            "Contents" => content_id,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
        };
        let page_id = self.doc.add_object(page);
        self.kids.push(page_id.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pod-pdf-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A PDF of `pages` pages, each with its number as text, sharing one font
    /// and inheriting MediaBox and Rotate from the page tree.
    fn make_pdf(path: &Path, pages: usize, rotate: i64) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let mut kids = Vec::new();
        for i in 0..pages {
            let text = format!("BT /F1 24 Tf 72 720 Td (Page {}) Tj ET", i + 1);
            let content = doc.add_object(Stream::new(Dictionary::new(), text.into_bytes()));
            let page = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            });
            kids.push(Object::from(page));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => pages as i64,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
                "Rotate" => rotate,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        doc.save(path).unwrap();
    }

    fn page_text(doc: &Document, page: ObjectId) -> String {
        String::from_utf8_lossy(&doc.get_page_content(page)).to_string()
    }

    #[test]
    fn merge_keeps_order_and_inherited_attributes() {
        let dir = temp_dir("merge");
        let (a, b) = (dir.join("a.pdf"), dir.join("b.pdf"));
        make_pdf(&a, 2, 0);
        make_pdf(&b, 3, 180);
        let report = run(Action::Merge, &[a, b], Vec::new());
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(report.outputs[0].ends_with("a (merged).pdf"));
        let merged = load(Path::new(&report.outputs[0])).unwrap();
        let pages = page_ids(&merged);
        assert_eq!(pages.len(), 5);
        assert!(page_text(&merged, pages[1]).contains("Page 2"));
        assert!(page_text(&merged, pages[2]).contains("Page 1"));
        assert_eq!(page_rotation(&merged, pages[3]), 180);
        assert!(merged.get_dictionary(pages[4]).unwrap().has(b"MediaBox"));
        assert_eq!(merged.get_page_fonts(pages[4]).unwrap().len(), 1);

        let lonely = run(Action::Merge, &[dir.join("a.pdf")], Vec::new());
        assert!(lonely.outputs.is_empty());
        assert_eq!(lonely.failed.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn split_writes_one_file_per_page() {
        let dir = temp_dir("split");
        let src = dir.join("report.pdf");
        make_pdf(&src, 3, 90);
        let report = run(Action::Split, &[src], Vec::new());
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let out = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&out), "report (pages)");
        for n in 1..=3 {
            let page = load(&out.join(format!("report p{n}.pdf"))).unwrap();
            let ids = page_ids(&page);
            assert_eq!(ids.len(), 1);
            assert!(page_text(&page, ids[0]).contains(&format!("Page {n}")));
            assert_eq!(page_rotation(&page, ids[0]), 90);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rotate_adds_a_quarter_turn() {
        let dir = temp_dir("rotate");
        let src = dir.join("scan.pdf");
        make_pdf(&src, 2, 270);
        let report = run(Action::Rotate, &[src.clone(), dir.join("notes.txt")], Vec::new());
        assert_eq!(report.failed.len(), 1, "the .txt is refused");
        assert!(report.outputs[0].ends_with("scan (rotated).pdf"));
        let rotated = load(Path::new(&report.outputs[0])).unwrap();
        assert!(page_ids(&rotated).iter().all(|p| page_rotation(&rotated, *p) == 0));
        // Rotating again, from the original: 270 + 90 → 0, and the name is not reused.
        let again = run(Action::Rotate, &[src], Vec::new());
        assert!(again.outputs[0].ends_with("scan (rotated) (2).pdf"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compress_never_keeps_a_bigger_file() {
        let dir = temp_dir("compress");
        let src = dir.join("doc.pdf");
        make_pdf(&src, 40, 0);
        let report = run(Action::Compress, &[src.clone()], Vec::new());
        assert_eq!(report.outputs.len() + report.failed.len(), 1);
        if let Some(out) = report.outputs.first() {
            assert!(fs::metadata(out).unwrap().len() < fs::metadata(&src).unwrap().len());
            assert_eq!(page_ids(&load(Path::new(out)).unwrap()).len(), 40);
        } else {
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "the bigger output was removed");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pictures_become_pages() {
        let dir = temp_dir("images");
        let jpg = dir.join("photo.jpg");
        RgbImage::from_pixel(300, 200, Rgb([200, 100, 50])).save(&jpg).unwrap();
        let png = dir.join("shot.png");
        image::RgbaImage::from_fn(40, 80, |x, _| image::Rgba([0, 0, 255, (x * 6) as u8])).save(&png).unwrap();
        let report = run(Action::Images, &[jpg.clone(), png, dir.join("x.doc")], Vec::new());
        assert_eq!(report.failed.len(), 1);
        assert!(report.outputs[0].ends_with("photo (images).pdf"));
        let doc = load(Path::new(&report.outputs[0])).unwrap();
        let pages = page_ids(&doc);
        assert_eq!(pages.len(), 2);
        let media = |p: ObjectId| -> Vec<f32> {
            doc.get_dictionary(p).unwrap().get(b"MediaBox").unwrap().as_array().unwrap().iter().map(|o| o.as_float().unwrap()).collect()
        };
        assert_eq!(media(pages[0]), vec![0.0, 0.0, 300.0, 200.0]);
        assert_eq!(media(pages[1]), vec![0.0, 0.0, 40.0, 80.0]);
        // The JPEG went in untouched.
        let images = doc.get_page_images(pages[0]).unwrap();
        assert_eq!(images[0].content, &fs::read(&jpg).unwrap()[..]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The placement matrix puts every source pixel where apply_orientation does.
    #[test]
    fn placement_matches_exif_orientation() {
        let (w, h) = (3u32, 2u32);
        let src = RgbImage::from_fn(w, h, |x, y| Rgb([x as u8, y as u8, 0]));
        for exif in 1..=8 {
            let orientation = Orientation::from_exif(exif).unwrap();
            let mut shown = DynamicImage::ImageRgb8(src.clone());
            shown.apply_orientation(orientation);
            let shown = shown.into_rgb8();
            let m = placement(orientation, w as f64, h as f64);
            for y in 0..h {
                for x in 0..w {
                    let (u, v) = ((x as f64 + 0.5) / w as f64, 1.0 - (y as f64 + 0.5) / h as f64);
                    let px = m[0] * u + m[2] * v + m[4];
                    let py = m[1] * u + m[3] * v + m[5];
                    let (sx, sy) = (px.floor() as u32, (shown.height() as f64 - py).floor() as u32);
                    assert_eq!(shown.get_pixel(sx, sy), src.get_pixel(x, y), "orientation {exif}, pixel ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn jpeg_frame_reads_the_header() {
        let mut bytes = Vec::new();
        RgbImage::from_pixel(17, 9, Rgb([1, 2, 3]))
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)
            .unwrap();
        assert_eq!(jpeg_frame(&bytes), Some((17, 9, 3)));
        assert_eq!(jpeg_frame(b"not a jpeg"), None);
    }

    #[test]
    fn unwritable_output_is_reported() {
        let missing = std::env::temp_dir().join("pod-pdf-test-no-such-dir").join("deeper");
        assert!(save(Document::with_version("1.7"), &missing, "x.pdf", false).is_err());
    }
}
