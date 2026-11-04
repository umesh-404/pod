// The PDF editor: pictures and PDF pages, gathered from drops (on the island's
// "PDF editor" tile or onto the editor itself) and the file picker, put in
// order in the Pod window and saved as one PDF on the shelf.
//
// The page never holds a path. It sees each source by number, with its pages'
// sizes, asks for thumbnails by source and page, and sends back the order to
// save; so only files the user dropped or picked are ever read. The sources
// stay with the editor until it saves or is closed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{ImageDecoder, ImageReader};
use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::archive::{display_name, extension};
use crate::i18n::{t, tf};
use crate::pdf::{self, Builder, PageCopy};
use crate::workspace::Failure;

/// The island and the Pod window are told when the editor changes.
const STATE_EVENT: &str = "pdf-studio";
const SAVED_EVENT: &str = "pdf-studio-saved";
/// More would make a page grid nobody can work with.
const MAX_PAGES: usize = 2000;
/// The long side of a thumbnail, in pixels, at most.
const MAX_THUMB: u32 = 640;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Pdf,
    Image,
}

/// One page as it shows before any turn in the editor: its size in points
/// (pictures: pixels), already turned by the page's own rotation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageSize {
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceInfo {
    pub id: u32,
    pub name: String,
    pub kind: SourceKind,
    pub pages: Vec<PageSize>,
}

/// What the editor holds. `session` changes each time it opens afresh, so the
/// page knows to start over rather than add.
#[derive(Clone, Debug, Serialize)]
pub struct StudioState {
    pub session: u64,
    pub sources: Vec<SourceInfo>,
    /// Files that couldn't be added this time, and why.
    pub failed: Vec<Failure>,
}

/// One page of the PDF to save: page `page` (from 0) of source `source`,
/// turned `turns` quarter turns clockwise on top of how it shows.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct PageRef {
    pub source: u32,
    pub page: u32,
    pub turns: i64,
}

struct Source {
    info: SourceInfo,
    path: PathBuf,
    /// Each page's own rotation (PDF pages), kept when it is turned further.
    rotations: Vec<i64>,
}

#[derive(Default)]
struct Studio {
    session: u64,
    open: bool,
    /// The Pod window was hidden when the editor opened: it hides again after.
    hide_after: bool,
    next_id: u32,
    sources: Vec<Source>,
}

static STUDIO: Mutex<Studio> = Mutex::new(Studio { session: 0, open: false, hide_after: false, next_id: 0, sources: Vec::new() });

fn studio() -> std::sync::MutexGuard<'static, Studio> {
    STUDIO.lock().unwrap_or_else(|e| e.into_inner())
}

impl Studio {
    fn state(&self, failed: Vec<Failure>) -> StudioState {
        StudioState { session: self.session, sources: self.sources.iter().map(|s| s.info.clone()).collect(), failed }
    }

    fn page_count(&self) -> usize {
        self.sources.iter().map(|s| s.info.pages.len()).sum()
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Files dropped on the island's "PDF editor" tile: into the editor, which
/// opens in the Pod window (or, already open, gets them at the end).
#[tauri::command]
pub async fn pdf_studio_open(app: AppHandle, paths: Vec<String>) -> Result<StudioState, String> {
    let (inputs, failed) = crate::files::take_all_dropped(paths);
    let state = add(&app, inputs, failed, true).await?;
    // On the main thread: showing and focusing a window from here can wait on
    // it forever, and the island's call would never return.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::show_hub(&handle, None));
    Ok(state)
}

/// What the editor holds now; None when it isn't open.
#[tauri::command]
pub fn pdf_studio_state() -> Option<StudioState> {
    let studio = studio();
    studio.open.then(|| studio.state(Vec::new()))
}

/// "Add files…" in the editor: the system's file picker, pictures and PDFs.
#[tauri::command]
pub async fn pdf_studio_pick(app: AppHandle) -> Result<Option<StudioState>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut exts: Vec<&str> = pdf::IMAGE_EXTS.to_vec();
        exts.push("pdf");
        picker.dialog().file().set_title(t("Add pictures or PDFs")).add_filter(t("Pictures and PDFs"), &exts).blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let paths = picked.into_iter().filter_map(|p| p.into_path().ok()).collect();
    add(&app, paths, Vec::new(), false).await.map(Some)
}

/// A thumbnail of one page, as a `data:image/…;base64,` URL at most `size`
/// pixels on its long side. None when it can't be drawn (the page then shows
/// its number on a blank sheet).
#[tauri::command]
pub async fn pdf_studio_thumb(source: u32, page: u32, size: u32) -> Option<String> {
    let (path, kind) = {
        let studio = studio();
        let s = studio.sources.iter().find(|s| s.info.id == source)?;
        if page as usize >= s.info.pages.len() {
            return None;
        }
        (s.path.clone(), s.info.kind)
    };
    let px = size.clamp(32, MAX_THUMB);
    match kind {
        SourceKind::Image => tauri::async_runtime::spawn_blocking(move || picture_thumb(&path, px)).await.ok().flatten(),
        SourceKind::Pdf => render::page(source, path, page, px).await,
    }
}

/// Saves `pages`, in that order, as one PDF on the shelf named `name`, and
/// closes the editor. Returns the file written.
#[tauri::command]
pub async fn pdf_studio_save(app: AppHandle, pages: Vec<PageRef>, name: String) -> Result<String, String> {
    if pages.is_empty() {
        return Err(t("Add at least one page first."));
    }
    let sources: HashMap<u32, (PathBuf, SourceKind, Vec<i64>)> = {
        let studio = studio();
        if !studio.open {
            return Err(t("The PDF editor was closed."));
        }
        studio.sources.iter().map(|s| (s.info.id, (s.path.clone(), s.info.kind, s.rotations.clone()))).collect()
    };
    let out = crate::workspace::output_dir(&app)?;
    let name = file_name(&name);
    let count = pages.len();
    let dest = tauri::async_runtime::spawn_blocking(move || {
        let _busy = crate::files::JobGuard::new();
        compose(&pages, &sources).and_then(|doc| pdf::save(doc, &out, &name, false))
    })
    .await
    .map_err(|e| e.to_string())??;
    let dest = dest.to_string_lossy().to_string();
    crate::log::line(format!("pdf editor: saved {count} page(s)"));
    finish(&app);
    let _ = app.emit_to(crate::island::WINDOW_LABEL, SAVED_EVENT, &dest);
    Ok(dest)
}

/// Cancel: the editor lets go of its files.
#[tauri::command]
pub fn pdf_studio_close(app: AppHandle) {
    finish(&app);
}

/// Files dropped onto the editor in the Pod window (webview_drop.rs on
/// Windows, Tauri's own drop events elsewhere); paths straight from the system.
pub fn window_drop(app: &AppHandle, paths: Vec<PathBuf>) {
    if !studio().open {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = add(&app, paths, Vec::new(), false).await {
            crate::log::line(format!("pdf editor: drop failed: {error}"));
        }
    });
}

// ── Adding files ────────────────────────────────────────────────────────────

/// Reads `paths` into the editor (opening it when `open`) and tells the Pod
/// window what it holds now.
async fn add(app: &AppHandle, paths: Vec<PathBuf>, mut failed: Vec<Failure>, open: bool) -> Result<StudioState, String> {
    let read = tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|p| (inspect(&p), p)).collect::<Vec<_>>())
        .await
        .map_err(|e| e.to_string())?;
    let state = {
        let mut studio = studio();
        if !studio.open {
            if !open {
                return Err(t("The PDF editor was closed."));
            }
            studio.open = true;
            studio.session += 1;
            studio.sources.clear();
            studio.hide_after = !crate::hub_visible();
        }
        for (result, path) in read {
            match result {
                Ok((kind, pages, rotations)) => {
                    if studio.page_count() + pages.len() > MAX_PAGES {
                        failed.push(Failure {
                            name: display_name(&path),
                            error: tf("The editor holds up to {count} pages.", &[("count", &MAX_PAGES.to_string())]),
                        });
                        continue;
                    }
                    let id = studio.next_id;
                    studio.next_id += 1;
                    let info = SourceInfo { id, name: display_name(&path), kind, pages };
                    studio.sources.push(Source { info, path, rotations });
                }
                Err(error) => failed.push(Failure { name: display_name(&path), error }),
            }
        }
        studio.state(failed)
    };
    let _ = app.emit_to(crate::HUB_LABEL, STATE_EVENT, &state);
    Ok(state)
}

/// What a file is for the editor: its kind, each page's size as it shows,
/// and each page's own rotation.
fn inspect(path: &Path) -> Result<(SourceKind, Vec<PageSize>, Vec<i64>), String> {
    let ext = extension(path).unwrap_or_default();
    if ext == "pdf" {
        let doc = pdf::load(path)?;
        let mut sizes = Vec::new();
        let mut rotations = Vec::new();
        for id in pdf::page_ids(&doc) {
            let rotation = pdf::page_rotation(&doc, id);
            let (w, h) = page_box(&doc, &pdf::standalone_page(&doc, id));
            let size = if rotation % 180 == 90 { PageSize { w: h, h: w } } else { PageSize { w, h } };
            sizes.push(size);
            rotations.push(rotation);
        }
        return Ok((SourceKind::Pdf, sizes, rotations));
    }
    if !pdf::IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(tf("{name} isn't a picture or a PDF.", &[("name", &display_name(path))]));
    }
    let unreadable = |e: &dyn std::fmt::Display| tf("Cannot read {path}: {error}", &[("path", &display_name(path)), ("error", &e.to_string())]);
    let mut decoder = ImageReader::open(path)
        .map_err(|e| unreadable(&e))?
        .with_guessed_format()
        .map_err(|e| unreadable(&e))?
        .into_decoder()
        .map_err(|e| crate::resize::decode_error(&e))?;
    let (w, h) = decoder.dimensions();
    let turned = decoder.orientation().is_ok_and(|o| {
        use image::metadata::Orientation::*;
        matches!(o, Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH)
    });
    let size = if turned { PageSize { w: h as f32, h: w as f32 } } else { PageSize { w: w as f32, h: h as f32 } };
    Ok((SourceKind::Image, vec![size], vec![0]))
}

/// Width and height of a page's crop box (else its media box), in points.
fn page_box(doc: &Document, page: &lopdf::Dictionary) -> (f32, f32) {
    let number = |o: &Object| -> Option<f32> {
        let o = doc.dereference(o).map(|(_, o)| o).unwrap_or(o);
        o.as_float().ok().or_else(|| o.as_i64().ok().map(|v| v as f32))
    };
    for key in [b"CropBox".as_slice(), b"MediaBox".as_slice()] {
        let Ok(value) = page.get(key) else { continue };
        let value = doc.dereference(value).map(|(_, o)| o).unwrap_or(value);
        let Ok(items) = value.as_array() else { continue };
        let v: Vec<f32> = items.iter().filter_map(number).collect();
        if v.len() == 4 {
            let (w, h) = ((v[2] - v[0]).abs(), (v[3] - v[1]).abs());
            if w > 0.0 && h > 0.0 {
                return (w, h);
            }
        }
    }
    (612.0, 792.0)
}

// ── Saving ──────────────────────────────────────────────────────────────────

/// "name.pdf", made safe as a file name; "PDF.pdf" when nothing usable is left.
pub(crate) fn file_name(name: &str) -> String {
    let name = name.trim();
    let stem = name.strip_suffix(".pdf").or_else(|| name.strip_suffix(".PDF")).unwrap_or(name).trim();
    let stem = if stem.is_empty() { "PDF" } else { stem };
    let safe = crate::files::safe_drop_name(stem);
    let safe = if safe == "dropped file" && stem != "dropped file" { "PDF".to_string() } else { safe };
    format!("{safe}.pdf")
}

/// The new document: every page in `pages`, in order, turned as asked.
fn compose(pages: &[PageRef], sources: &HashMap<u32, (PathBuf, SourceKind, Vec<i64>)>) -> Result<Document, String> {
    let mut docs: HashMap<u32, (Document, Vec<lopdf::ObjectId>, PageCopy)> = HashMap::new();
    let mut builder = Builder::new();
    // Every PDF page is given its new id first, so links between pages kept survive.
    for r in pages {
        let (path, kind, _) = sources.get(&r.source).ok_or_else(|| t("A page's file is no longer in the editor."))?;
        if *kind != SourceKind::Pdf {
            continue;
        }
        if !docs.contains_key(&r.source) {
            let doc = pdf::load(path)?;
            let ids = pdf::page_ids(&doc);
            docs.insert(r.source, (doc, ids, PageCopy::default()));
        }
    }
    for r in pages {
        if let Some((_, ids, copy)) = docs.get_mut(&r.source) {
            let id = *ids.get(r.page as usize).ok_or_else(|| t("A page's file is no longer in the editor."))?;
            builder.reserve(copy, &[id]);
        }
    }
    for r in pages {
        let (path, kind, rotations) = &sources[&r.source];
        let (added, base) = match kind {
            SourceKind::Pdf => {
                let (doc, ids, copy) = docs.get_mut(&r.source).expect("loaded above");
                let id = ids[r.page as usize];
                (builder.add_reserved_page(doc, copy, id), rotations.get(r.page as usize).copied().unwrap_or(0))
            }
            SourceKind::Image => {
                builder.add_picture(path)?;
                (builder.last_page().ok_or_else(|| t("No file was written."))?, 0)
            }
        };
        if r.turns.rem_euclid(4) != 0 || base != 0 {
            builder.set_rotation(added, base + 90 * r.turns.rem_euclid(4));
        }
    }
    for (doc, _, copy) in docs.values_mut() {
        builder.copy_queued(doc, copy);
    }
    Ok(builder.finish())
}

/// Closes the editor and hides the Pod window again if it opened for it.
fn finish(app: &AppHandle) {
    let hide = {
        let mut studio = studio();
        let hide = studio.open && studio.hide_after;
        studio.open = false;
        studio.sources.clear();
        hide
    };
    render::forget();
    if hide {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::hide_hub(&handle));
    }
    let _ = app.emit_to(crate::HUB_LABEL, "pdf-studio-closed", ());
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

/// A picture, turned upright by its EXIF orientation, at most `px` on its long side.
fn picture_thumb(path: &Path, px: u32) -> Option<String> {
    let mut decoder = ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    let small = img.thumbnail(px, px).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&small).ok()?;
    Some(format!("data:image/jpeg;base64,{}", crate::media::base64(&out)))
}

#[cfg(windows)]
mod render {
    // PDF pages are drawn by Windows.Data.Pdf on one thread of their own, which
    // keeps each open document for the next page instead of reading it again.

    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::OnceLock;

    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};

    enum Job {
        Page { source: u32, path: PathBuf, page: u32, px: u32, reply: tokio::sync::oneshot::Sender<Option<Vec<u8>>> },
        Forget,
    }

    fn worker() -> &'static mpsc::Sender<Job> {
        static TX: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
        TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            let _ = std::thread::Builder::new().name("pdf-editor-pages".into()).spawn(move || {
                // Windows.Data.Pdf needs the thread in COM, as the shelf's thumbnail thread is.
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                let mut open: HashMap<u32, PdfDocument> = HashMap::new();
                while let Ok(job) = rx.recv() {
                    match job {
                        Job::Page { source, path, page, px, reply } => {
                            if !open.contains_key(&source) {
                                if let Some(doc) = load(&path) {
                                    open.insert(source, doc);
                                }
                            }
                            let png = open.get(&source).and_then(|doc| draw(doc, page, px));
                            let _ = reply.send(png);
                        }
                        Job::Forget => open.clear(),
                    }
                }
            });
            tx
        })
    }

    fn load(path: &std::path::Path) -> Option<PdfDocument> {
        // StorageFile takes only backslashes; a dropped path can have either.
        let path = path.to_string_lossy().replace('/', "\\");
        let opened = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
            .and_then(|op| op.get())
            .and_then(|file| PdfDocument::LoadFromFileAsync(&file))
            .and_then(|op| op.get());
        opened.map_err(|e| crate::log::line(format!("pdf editor: can't open a PDF to draw: {e}"))).ok()
    }

    fn draw(doc: &PdfDocument, index: u32, px: u32) -> Option<Vec<u8>> {
        let drawn = (|| -> windows::core::Result<Option<Vec<u8>>> {
            if index >= doc.PageCount()? {
                return Ok(None);
            }
            let page = doc.GetPage(index)?;
            let size = page.Size()?;
            let long = size.Width.max(size.Height);
            if !(long > 0.0) {
                return Ok(None);
            }
            let scale = px as f32 / long;
            let options = PdfPageRenderOptions::new()?;
            options.SetDestinationWidth((size.Width * scale).round().max(1.0) as u32)?;
            options.SetDestinationHeight((size.Height * scale).round().max(1.0) as u32)?;
            // PNG is the default encoding, so the stream holds a finished PNG file.
            let stream = InMemoryRandomAccessStream::new()?;
            page.RenderWithOptionsToStreamAsync(&stream, &options)?.get()?;
            let len = u32::try_from(stream.Size()?).unwrap_or(0);
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            reader.LoadAsync(len)?.get()?;
            let mut png = vec![0u8; len as usize];
            reader.ReadBytes(&mut png)?;
            Ok(Some(png))
        })();
        drawn.map_err(|e| crate::log::line(format!("pdf editor: can't draw page {}: {e}", index + 1))).ok().flatten()
    }

    pub(super) async fn page(source: u32, path: PathBuf, page: u32, px: u32) -> Option<String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        worker().send(Job::Page { source, path, page, px, reply }).ok()?;
        let png = answer.await.ok().flatten()?;
        Some(format!("data:image/png;base64,{}", crate::media::base64(&png)))
    }

    /// The editor closed: its documents are let go.
    pub(super) fn forget() {
        let _ = worker().send(Job::Forget);
    }
}

#[cfg(not(windows))]
mod render {
    // Linux has no PDF renderer of its own: pages show as numbered sheets.
    pub(super) async fn page(_source: u32, _path: std::path::PathBuf, _page: u32, _px: u32) -> Option<String> {
        None
    }

    pub(super) fn forget() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pod-pdfstudio-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A PDF whose pages say "Page 1", "Page 2"… and share one font; page 2 is
    /// landscape and every page inherits Rotate `rotate`.
    fn make_pdf(path: &Path, pages: usize, rotate: i64) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let mut kids = Vec::new();
        for i in 0..pages {
            let text = format!("BT /F1 24 Tf 72 720 Td (Page {}) Tj ET", i + 1);
            let content = doc.add_object(Stream::new(lopdf::Dictionary::new(), text.into_bytes()));
            let mut page = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            };
            if i == 1 {
                page.set("MediaBox", vec![0.into(), 0.into(), 842.into(), 595.into()]);
            }
            kids.push(Object::from(doc.add_object(page)));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => kids, "Count" => pages as i64,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()], "Rotate" => rotate,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        doc.save(path).unwrap();
    }

    fn page_texts(doc: &Document) -> Vec<String> {
        pdf::page_ids(doc)
            .into_iter()
            .map(|id| {
                let content = doc.get_page_content(id);
                let text = String::from_utf8_lossy(&content).to_string();
                text.split('(').nth(1).and_then(|s| s.split(')').next()).unwrap_or("").to_string()
            })
            .collect()
    }

    #[test]
    fn a_pdf_is_read_with_each_pages_size_as_it_shows() {
        let dir = temp_dir("inspect");
        let path = dir.join("a.pdf");
        make_pdf(&path, 3, 90);
        let (kind, sizes, rotations) = inspect(&path).unwrap();
        assert_eq!(kind, SourceKind::Pdf);
        assert_eq!(rotations, [90, 90, 90]);
        // Turned a quarter: portrait pages show landscape and the other way round.
        assert_eq!(sizes[0], PageSize { w: 842.0, h: 595.0 });
        assert_eq!(sizes[1], PageSize { w: 595.0, h: 842.0 });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn other_files_are_refused_with_a_reason() {
        let dir = temp_dir("refuse");
        let path = dir.join("notes.txt");
        std::fs::write(&path, "hello").unwrap();
        assert!(inspect(&path).unwrap_err().contains("notes.txt"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pages_are_saved_in_the_new_order_turned_and_from_several_files() {
        let dir = temp_dir("compose");
        let (a, b) = (dir.join("a.pdf"), dir.join("b.pdf"));
        make_pdf(&a, 3, 0);
        make_pdf(&b, 2, 90);
        let picture = dir.join("photo.png");
        image::RgbImage::from_pixel(40, 20, image::Rgb([200, 30, 30])).save(&picture).unwrap();
        let sources = HashMap::from([
            (0, (a.clone(), SourceKind::Pdf, vec![0, 0, 0])),
            (1, (b.clone(), SourceKind::Pdf, vec![90, 90])),
            (2, (picture.clone(), SourceKind::Image, vec![0])),
        ]);
        let order = [
            PageRef { source: 0, page: 2, turns: 0 },
            PageRef { source: 2, page: 0, turns: 1 },
            PageRef { source: 1, page: 0, turns: 1 },
            PageRef { source: 0, page: 0, turns: 0 },
        ];
        let doc = compose(&order, &sources).unwrap();
        let saved = pdf::save(doc, &dir, "out.pdf", false).unwrap();
        let doc = Document::load(&saved).unwrap();
        let ids = pdf::page_ids(&doc);
        assert_eq!(ids.len(), 4);
        let texts = page_texts(&doc);
        assert_eq!(texts[0], "Page 3");
        assert_eq!(texts[2], "Page 1");
        assert_eq!(texts[3], "Page 1");
        assert_eq!(pdf::page_rotation(&doc, ids[0]), 0);
        assert_eq!(pdf::page_rotation(&doc, ids[1]), 90, "the picture turned once");
        assert_eq!(pdf::page_rotation(&doc, ids[2]), 180, "its own 90 plus one turn");
        // One font object for the pages of a.pdf, not one per page.
        let fonts = doc.objects.values().filter(|o| o.as_dict().is_ok_and(|d| d.get(b"BaseFont").is_ok())).count();
        assert_eq!(fonts, 2, "one font from each PDF");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_page_from_a_file_not_in_the_editor_is_refused() {
        let order = [PageRef { source: 9, page: 0, turns: 0 }];
        assert!(compose(&order, &HashMap::new()).is_err());
    }

    #[test]
    fn names_become_safe_pdf_file_names() {
        assert_eq!(file_name("Trip photos"), "Trip photos.pdf");
        assert_eq!(file_name("report.pdf"), "report.pdf");
        assert_eq!(file_name("  "), "PDF.pdf");
        assert_eq!(file_name("a/b:c"), "b_c.pdf");
        assert_eq!(file_name("CON"), "_CON.pdf");
    }
}
