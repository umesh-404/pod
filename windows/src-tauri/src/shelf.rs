// The shelf: what is in the workspace folder, shown in the island so files can
// be dragged back out into whatever the user is working in. A drag out copies:
// the file stays on the shelf until it is removed.
//
// The rules:
//   * a name from the page is one path component that exists directly in the
//     workspace — never a path, never `..` — so the page can't reach anything else;
//   * a drag offers DROPEFFECT_COPY only, so no drop target can move the file;
//   * removing goes to the Recycle Bin (Trash), never a permanent delete;
//   * the folder is watched with notify, nothing polls: 0 % CPU while nothing changes.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Window};
use tokio::sync::oneshot;

use crate::i18n::{t, tf};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    /// Name in the workspace folder — the item's id for the other commands.
    pub name: String,
    pub is_dir: bool,
    /// Bytes; 0 for folders.
    pub size: u64,
    /// Last modified, milliseconds since the Unix epoch.
    pub modified: u64,
    /// Lowercase extension without the dot, "" for none and for folders.
    pub ext: String,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Newest first.
#[tauri::command]
pub fn shelf_list(app: AppHandle) -> Vec<ShelfItem> {
    list(&crate::workspace::dir(&app))
}

/// Starts a native drag (copy) of these shelf items out of the island window.
///
/// Async on purpose: a sync command already runs on the main thread, where
/// `run_on_main_thread` would start the (modal) drag inside the IPC call. From
/// here the drag is queued to the event loop and the call returns at once.
#[tauri::command(async)]
pub fn shelf_drag(app: AppHandle, window: Window, names: Vec<String>) -> Result<(), String> {
    let ws = crate::workspace::dir(&app);
    let mut paths = Vec::with_capacity(names.len());
    for name in &names {
        paths.push(resolve(&ws, name)?);
    }
    if paths.is_empty() {
        return Ok(());
    }
    let preview = drag_preview(&app, &ws, &names[0]);
    app.run_on_main_thread(move || start_drag(window, paths, preview)).map_err(|e| e.to_string())
}

/// Sends these shelf items to the Recycle Bin (Trash on Linux).
#[tauri::command]
pub fn shelf_remove(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    let ws = crate::workspace::dir(&app);
    let paths = names.iter().map(|n| resolve(&ws, n)).collect::<Result<Vec<_>, _>>()?;
    for (path, name) in paths.iter().zip(&names) {
        trash::delete(path)
            .map_err(|e| tf("Could not remove {path}: {error}", &[("path", name), ("error", &e.to_string())]))?;
    }
    Ok(())
}

/// A thumbnail for a shelf item, as a `data:image/png;base64,` URL at most `size`
/// pixels on its long side: the shell's own thumbnail on Windows (pictures, videos,
/// Office files…), a PDF's first page. Cached by name + modified time; None when
/// there is no real picture of the file, and the shelf draws its own placeholder
/// (a cropped file-type icon looks broken in a tile).
#[tauri::command]
pub async fn shelf_thumb(app: AppHandle, name: String, size: u32) -> Option<String> {
    let path = resolve(&crate::workspace::dir(&app), &name).ok()?;
    let meta = std::fs::metadata(&path).ok()?;
    let key = ThumbKey {
        name,
        modified: millis(meta.modified().ok()),
        size: if meta.is_dir() { 0 } else { meta.len() },
        px: size.clamp(16, 512),
    };
    thumb(key, path).await.map(|png| data_url(&png))
}

/// Starts watching the workspace folder (called once from setup): `shelf-changed`
/// (with the new `shelf_list`) whenever something is added, removed or renamed
/// there, coalesced over 250 ms. Follows the folder when the workspace moves.
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<Msg>();
    let on_settings = tx.clone();
    app.listen_any("settings-changed", move |_| {
        let _ = on_settings.send(Msg::Retarget);
    });
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("shelf-watch".into())
        .spawn(move || watch_loop(app, tx, rx));
    if let Err(err) = spawned {
        crate::log::line(format!("shelf: cannot start the watcher: {err}"));
    }
}

/// Opens a shelf item with its default app.
/// "Add files": the system's file picker, the picked files COPIED into the
/// workspace (unique names, never overwriting). Returns the new shelf names;
/// empty when the picker was cancelled.
#[tauri::command(async)]
pub fn shelf_add(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(t("Add files to the shelf"))
        .set_directory(crate::platform::home_dir())
        .blocking_pick_files()
    else {
        return Ok(Vec::new());
    };
    let ws = crate::workspace::dir(&app);
    std::fs::create_dir_all(&ws).map_err(|e| tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    let mut added = Vec::new();
    for file in picked {
        let src = file.into_path().map_err(|e| e.to_string())?;
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        let dest = crate::files::copy_new(&src, &ws, &name).map_err(|e| tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
        if let Some(n) = dest.file_name() {
            added.push(n.to_string_lossy().into_owned());
        }
    }
    crate::log::line(format!("shelf: added {} file(s) from the picker", added.len()));
    Ok(added)
}

#[tauri::command]
pub fn shelf_open(app: AppHandle, name: String) -> Result<(), String> {
    let path = resolve(&crate::workspace::dir(&app), &name)?;
    let shown = path.to_string_lossy().to_string();
    if path.is_dir() {
        crate::platform::reveal_folder(&shown);
    } else {
        crate::platform::open_url(&shown);
    }
    Ok(())
}

// ── Listing and names ───────────────────────────────────────────────────────

pub(crate) fn list(ws: &Path) -> Vec<ShelfItem> {
    let Ok(entries) = std::fs::read_dir(ws) else { return Vec::new() };
    let mut items: Vec<ShelfItem> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden_name(&name) || is_temp_name(&name) {
                return None;
            }
            let path = entry.path();
            let link = std::fs::symlink_metadata(&path).ok()?;
            if has_hidden_attribute(&link) {
                return None;
            }
            // A link shows what it points at; a broken one shows as itself.
            let meta = std::fs::metadata(&path).unwrap_or(link);
            let is_dir = meta.is_dir();
            let ext = if is_dir {
                String::new()
            } else {
                Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
            };
            Some(ShelfItem {
                size: if is_dir { 0 } else { meta.len() },
                modified: millis(meta.modified().ok()),
                is_dir,
                ext,
                name,
            })
        })
        .collect();
    items.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    items
}

/// One plain path component: no separators, no `.`/`..`, no drive or stream (`:`).
pub(crate) fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.contains(['/', '\\', '\0']) || (cfg!(windows) && name.contains(':')) {
        return false;
    }
    let mut parts = Path::new(name).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None))
}

/// The item's path when `name` is valid and exists directly in `ws`.
pub(crate) fn resolve(ws: &Path, name: &str) -> Result<PathBuf, String> {
    let gone = || t("This item is no longer on the shelf.");
    if !valid_name(name) {
        return Err(gone());
    }
    let path = ws.join(name);
    std::fs::symlink_metadata(&path).map_err(|_| gone())?;
    Ok(path)
}

/// Dot files and the files Windows and macOS leave in every folder.
pub(crate) fn is_hidden_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.') || matches!(lower.as_str(), "desktop.ini" | "thumbs.db" | "ehthumbs.db" | "icon\r")
}

/// Files still being written: browser partials, editor and Office temp files.
pub(crate) fn is_temp_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.starts_with("~$") || lower.starts_with(".~lock.") || lower.ends_with('~') {
        return true;
    }
    let ext = Path::new(&lower).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    matches!(ext.as_str(), "crdownload" | "part" | "partial" | "tmp" | "download" | "opdownload")
}

#[cfg(windows)]
fn has_hidden_attribute(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn has_hidden_attribute(_meta: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn millis(time: Option<SystemTime>) -> u64 {
    time.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ── Watching ────────────────────────────────────────────────────────────────

enum Msg {
    Fs(notify::Result<notify::Event>),
    Retarget,
}

/// The first change opens a 250 ms window; one list goes out when it closes,
/// however many changes landed in it.
pub(crate) struct Coalescer {
    window: Duration,
    due: Option<Instant>,
}

impl Coalescer {
    pub(crate) fn new(window: Duration) -> Self {
        Coalescer { window, due: None }
    }

    pub(crate) fn poke(&mut self, now: Instant) {
        self.due.get_or_insert(now + self.window);
    }

    /// How long to wait for the next message: None = until one comes.
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        self.due.map(|due| due.saturating_duration_since(now))
    }

    /// True once when the window has closed.
    pub(crate) fn take_due(&mut self, now: Instant) -> bool {
        match self.due {
            Some(due) if now >= due => {
                self.due = None;
                true
            }
            _ => false,
        }
    }
}

/// What to watch for `ws`: the folder itself, or its parent until it exists.
fn watch_target(ws: &Path) -> Option<PathBuf> {
    if ws.is_dir() {
        Some(ws.to_path_buf())
    } else {
        ws.parent().filter(|p| p.is_dir()).map(Path::to_path_buf)
    }
}

fn watch_loop(app: AppHandle, tx: mpsc::Sender<Msg>, rx: mpsc::Receiver<Msg>) {
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(Msg::Fs(res));
    }) {
        Ok(w) => w,
        Err(err) => {
            crate::log::line(format!("shelf: cannot watch the workspace: {err}"));
            return;
        }
    };
    let mut ws = crate::workspace::dir(&app);
    let mut watched: Option<PathBuf> = None;
    let mut coalescer = Coalescer::new(Duration::from_millis(250));
    let mut last: Option<Vec<ShelfItem>> = None;

    loop {
        // Re-aim when the folder moved, appeared or disappeared.
        let target = watch_target(&ws);
        if target != watched {
            if let Some(old) = watched.take() {
                let _ = watcher.unwatch(&old);
            }
            if let Some(new) = &target {
                match watcher.watch(new, RecursiveMode::NonRecursive) {
                    Ok(()) => watched = target.clone(),
                    Err(err) => crate::log::line(format!("shelf: cannot watch {}: {err}", new.display())),
                }
            }
            coalescer.poke(Instant::now());
        }

        let msg = match coalescer.wait(Instant::now()) {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(wait) => rx.recv_timeout(wait),
        };
        match msg {
            Ok(Msg::Fs(Ok(event))) => {
                let watching_ws = watched.as_deref() == Some(ws.as_path());
                let relevant = !matches!(event.kind, EventKind::Access(_))
                    && (watching_ws || event.paths.iter().any(|p| p == &ws));
                if relevant {
                    coalescer.poke(Instant::now());
                }
            }
            Ok(Msg::Fs(Err(err))) => {
                crate::log::line(format!("shelf: watch error: {err}"));
                coalescer.poke(Instant::now());
            }
            Ok(Msg::Retarget) => {
                let now = crate::workspace::dir(&app);
                if now != ws {
                    ws = now;
                    coalescer.poke(Instant::now());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }

        if coalescer.take_due(Instant::now()) {
            let items = list(&ws);
            if last.as_ref() != Some(&items) {
                let _ = app.emit("shelf-changed", &items);
                last = Some(items);
            }
        }
    }
}

// ── Dragging out ────────────────────────────────────────────────────────────

/// On the main thread, from the event loop.
fn start_drag(window: Window, paths: Vec<PathBuf>, preview: Vec<u8>) {
    // The drag follows the held button; once it is up there is nothing to drag
    // (and Windows would drop the files on whatever is under the cursor).
    #[cfg(windows)]
    if !crate::platform::left_button_down() {
        return;
    }
    let options = drag::Options { skip_animatation_on_cancel_or_failure: false, mode: drag::DragMode::Copy };
    let item = drag::DragItem::Files(paths);
    let image = drag::Image::Raw(preview);
    let done = |_result: drag::DragResult, _at: drag::CursorPosition| {};

    #[cfg(target_os = "linux")]
    let result = match window.gtk_window() {
        Ok(gtk_window) => drag::start_drag(&gtk_window, item, image, done, options),
        Err(err) => {
            crate::log::line(format!("shelf: no window for the drag: {err}"));
            return;
        }
    };
    #[cfg(not(target_os = "linux"))]
    let result = drag::start_drag(&window, item, image, done, options);

    if let Err(err) = result {
        crate::log::line(format!("shelf: drag failed: {err}"));
    }
}

const PREVIEW_PX: u32 = 96;

/// The first item's cached thumbnail, else the app icon, as a small PNG.
fn drag_preview(app: &AppHandle, ws: &Path, name: &str) -> Vec<u8> {
    let cached = std::fs::metadata(ws.join(name)).ok().and_then(|meta| {
        let (modified, size) = (millis(meta.modified().ok()), if meta.is_dir() { 0 } else { meta.len() });
        let state = thumbs().lock().unwrap();
        state
            .cache
            .best(|k| k.name == name && k.modified == modified && k.size == size, |k| k.px)
            .flatten()
    });
    if let Some(png) = cached.and_then(|png| fit_png(&png, PREVIEW_PX)) {
        return png;
    }
    app.default_window_icon()
        .and_then(|icon| {
            let img = image::RgbaImage::from_raw(icon.width(), icon.height(), icon.rgba().to_vec())?;
            encode_png(&image::DynamicImage::ImageRgba8(img).thumbnail(PREVIEW_PX, PREVIEW_PX).to_rgba8())
        })
        .unwrap_or_default()
}

/// `png` scaled down to fit `px`, re-encoded.
fn fit_png(png: &[u8], px: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let img = if img.width() > px || img.height() > px { img.thumbnail(px, px) } else { img };
    encode_png(&img.to_rgba8())
}

fn encode_png(img: &image::RgbaImage) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

#[derive(Hash, PartialEq, Eq, Clone, Debug)]
pub(crate) struct ThumbKey {
    name: String,
    modified: u64,
    size: u64,
    px: u32,
}

type Png = Option<Arc<Vec<u8>>>;

/// A small least-recently-used map.
pub(crate) struct Lru<K, V> {
    cap: usize,
    tick: u64,
    map: HashMap<K, (V, u64)>,
}

impl<K: Hash + Eq + Clone, V: Clone> Lru<K, V> {
    pub(crate) fn new(cap: usize) -> Self {
        Lru { cap: cap.max(1), tick: 0, map: HashMap::new() }
    }

    pub(crate) fn get(&mut self, key: &K) -> Option<V> {
        self.tick += 1;
        let tick = self.tick;
        self.map.get_mut(key).map(|(v, used)| {
            *used = tick;
            v.clone()
        })
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        self.tick += 1;
        if !self.map.contains_key(&key) && self.map.len() >= self.cap {
            if let Some(oldest) = self.map.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| k.clone()) {
                self.map.remove(&oldest);
            }
        }
        self.map.insert(key, (value, self.tick));
    }

    /// Among the entries `matches` accepts, the one with the largest `rank`.
    pub(crate) fn best(&self, matches: impl Fn(&K) -> bool, rank: impl Fn(&K) -> u32) -> Option<V> {
        self.map.iter().filter(|(k, _)| matches(k)).max_by_key(|(k, _)| rank(k)).map(|(_, (v, _))| v.clone())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

struct ThumbState {
    cache: Lru<ThumbKey, Png>,
    /// Requests being rendered, with whoever else is waiting for the same one.
    pending: HashMap<ThumbKey, Vec<oneshot::Sender<Png>>>,
}

fn thumbs() -> &'static Mutex<ThumbState> {
    static STATE: OnceLock<Mutex<ThumbState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ThumbState { cache: Lru::new(200), pending: HashMap::new() }))
}

/// Clears the pending entry and wakes the waiters even if the render is
/// cancelled half way, so nobody waits forever.
struct Leader {
    key: Option<ThumbKey>,
}

impl Leader {
    fn finish(mut self, png: Png) {
        if let Some(key) = self.key.take() {
            let mut state = thumbs().lock().unwrap();
            state.cache.insert(key.clone(), png.clone());
            for waiter in state.pending.remove(&key).unwrap_or_default() {
                let _ = waiter.send(png.clone());
            }
        }
    }
}

impl Drop for Leader {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            if let Ok(mut state) = thumbs().lock() {
                state.pending.remove(&key);
            }
        }
    }
}

async fn thumb(key: ThumbKey, path: PathBuf) -> Png {
    let waiting = {
        let mut state = thumbs().lock().unwrap();
        if let Some(hit) = state.cache.get(&key) {
            return hit;
        }
        match state.pending.get_mut(&key) {
            Some(waiters) => {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                Some(rx)
            }
            None => {
                state.pending.insert(key.clone(), Vec::new());
                None
            }
        }
    };
    if let Some(rx) = waiting {
        return rx.await.ok().flatten();
    }
    let leader = Leader { key: Some(key.clone()) };
    let png = render(path, key.px).await.map(Arc::new);
    leader.finish(png.clone());
    png
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64(png))
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Shell bitmaps are BGRA, usually with premultiplied alpha; thumbnails of
/// opaque pictures often carry no alpha at all (all 0). Out: straight RGBA.
pub(crate) fn bgra_to_rgba(px: &mut [u8]) {
    let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
    // A colour channel above its alpha can't be premultiplied.
    let premultiplied = has_alpha && px.chunks_exact(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        if !has_alpha {
            p[3] = 255;
        } else if premultiplied && p[3] != 0 && p[3] != 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

// ── Windows: the shell's thumbnails, on one STA thread ──────────────────────

#[cfg(windows)]
struct Job {
    path: PathBuf,
    px: u32,
    reply: oneshot::Sender<Option<Vec<u8>>>,
}

#[cfg(windows)]
async fn render(path: PathBuf, px: u32) -> Option<Vec<u8>> {
    static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        let spawned = std::thread::Builder::new().name("shelf-thumbs".into()).spawn(move || win::worker(rx));
        if let Err(err) = spawned {
            crate::log::line(format!("shelf: cannot start the thumbnail thread: {err}"));
        }
        Mutex::new(tx)
    });
    let (reply, rx) = oneshot::channel();
    worker.lock().unwrap().send(Job { path, px, reply }).ok()?;
    rx.await.ok().flatten()
}

#[cfg(windows)]
mod win {
    use super::{bgra_to_rgba, encode_png, Job};
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::mpsc;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY,
    };

    pub(super) fn worker(rx: mpsc::Receiver<Job>) {
        // Shell thumbnail and icon extractors expect a single-threaded apartment.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        while let Ok(job) = rx.recv() {
            let png = image_for(&job.path, job.px);
            let _ = job.reply.send(png);
        }
    }

    fn image_for(path: &Path, px: u32) -> Option<Vec<u8>> {
        let factory: IShellItemImageFactory =
            unsafe { SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None) }.ok()?;
        let size = SIZE { cx: px as i32, cy: px as i32 };
        let hbmp = match unsafe { factory.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_THUMBNAILONLY) } {
            Ok(hbmp) => hbmp,
            Err(_) => {
                // Without a PDF thumbnail handler (Edge as the reader has none) the
                // shell only has an icon: draw the first page ourselves instead.
                return if is_pdf(path) { pdf_first_page(path, px) } else { None };
            }
        };
        let pixels = read_bitmap(hbmp);
        unsafe {
            let _ = DeleteObject(hbmp.into());
        }
        let (w, h, mut px) = pixels?;
        bgra_to_rgba(&mut px);
        encode_png(&image::RgbaImage::from_raw(w, h, px)?)
    }

    fn is_pdf(path: &Path) -> bool {
        path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
    }

    /// The first page of a PDF as a PNG at most `px` on its long side, drawn by
    /// Windows.Data.Pdf (built into Windows 10 and 11). None for a locked or
    /// broken PDF, which then gets the file type's icon.
    fn pdf_first_page(path: &Path, px: u32) -> Option<Vec<u8>> {
        use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
        use windows::Storage::StorageFile;
        use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};

        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str())).ok()?.get().ok()?;
        let doc = PdfDocument::LoadFromFileAsync(&file).ok()?.get().ok()?;
        if doc.PageCount().ok()? == 0 {
            return None;
        }
        let page = doc.GetPage(0).ok()?;
        let size = page.Size().ok()?;
        let long = size.Width.max(size.Height);
        if !(long > 0.0) {
            return None;
        }
        let scale = px as f32 / long;
        let options = PdfPageRenderOptions::new().ok()?;
        options.SetDestinationWidth((size.Width * scale).round().max(1.0) as u32).ok()?;
        options.SetDestinationHeight((size.Height * scale).round().max(1.0) as u32).ok()?;
        // PNG is the default encoding, so the stream holds a finished PNG file.
        let stream = InMemoryRandomAccessStream::new().ok()?;
        page.RenderWithOptionsToStreamAsync(&stream, &options).ok()?.get().ok()?;
        let len = u32::try_from(stream.Size().ok()?).ok()?;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
        reader.LoadAsync(len).ok()?.get().ok()?;
        let mut png = vec![0u8; len as usize];
        reader.ReadBytes(&mut png).ok()?;
        Some(png)
    }

    /// Top-down 32-bit BGRA rows of `hbmp`.
    fn read_bitmap(hbmp: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
        unsafe {
            let mut bm = BITMAP::default();
            let got = GetObjectW(hbmp.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void));
            if got == 0 || bm.bmWidth <= 0 || bm.bmHeight == 0 {
                return None;
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let dc = GetDC(None);
            let lines = GetDIBits(dc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            (lines == h).then_some((w as u32, h as u32, buf))
        }
    }
}

// ── Linux: pictures directly, else the freedesktop thumbnail cache ─────────

#[cfg(not(windows))]
async fn render(path: PathBuf, px: u32) -> Option<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || linux_thumb(&path, px)).await.ok().flatten()
}

#[cfg(not(windows))]
fn linux_thumb(path: &Path, px: u32) -> Option<Vec<u8>> {
    const DIRECT: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    let meta = std::fs::metadata(path).ok()?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if meta.is_file() && meta.len() <= MAX_BYTES && DIRECT.contains(&ext.as_str()) {
        if let Some(png) = image::open(path).ok().and_then(|img| encode_png(&img.thumbnail(px, px).to_rgba8())) {
            return Some(png);
        }
    }
    let abs = std::fs::canonicalize(path).ok()?;
    let hash = md5_hex(file_uri(&abs.to_string_lossy()).as_bytes());
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::platform::home_dir().join(".cache"))
        .join("thumbnails");
    let order: [&str; 4] = if px > 128 {
        ["large", "x-large", "xx-large", "normal"]
    } else {
        ["normal", "large", "x-large", "xx-large"]
    };
    order
        .iter()
        .map(|size| cache.join(size).join(format!("{hash}.png")))
        .find_map(|file| std::fs::read(file).ok().and_then(|png| fit_png(&png, px)))
}

/// `file://` URI as GLib writes it (g_filename_to_uri), which the thumbnail
/// cache is keyed by.
#[cfg(any(test, not(windows)))]
pub(crate) fn file_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for &b in path.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-_.~!$&'()*+,;=:@/".contains(&b);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// MD5, only for the thumbnail cache's file names.
#[cfg(any(test, not(windows)))]
pub(crate) fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
        14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
        21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_le_bytes());
    let mut h: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for block in msg.chunks_exact(64) {
        let m: Vec<u32> = block.chunks_exact(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }
        h = [h[0].wrapping_add(a), h[1].wrapping_add(b), h[2].wrapping_add(c), h[3].wrapping_add(d)];
    }
    h.iter().flat_map(|w| w.to_le_bytes()).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_single_components() {
        for good in ["a.txt", "Report (2).pdf", "folder", "v1.2", "..hidden-ish", "a..b"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "/etc", "x\0y", "C:\\x"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        // A colon is an ordinary character on Linux; on Windows it names a drive or a stream.
        #[cfg(windows)]
        for bad in ["C:", "file.txt:stream"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn resolve_needs_the_item_in_the_workspace() {
        let ws = std::env::temp_dir().join(format!("pod-shelf-test-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("here.txt"), "x").unwrap();
        assert_eq!(resolve(&ws, "here.txt").unwrap(), ws.join("here.txt"));
        assert!(resolve(&ws, "missing.txt").is_err());
        assert!(resolve(&ws, "..").is_err());
        assert!(resolve(&ws, &format!("..{}{}", std::path::MAIN_SEPARATOR, "x")).is_err());

        std::fs::write(ws.join("desktop.ini"), "x").unwrap();
        std::fs::write(ws.join("big.zip.crdownload"), "x").unwrap();
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        let names: Vec<String> = list(&ws).into_iter().map(|i| i.name).collect();
        assert!(names.contains(&"here.txt".to_string()) && names.contains(&"sub".to_string()));
        assert!(!names.iter().any(|n| n == "desktop.ini" || n.ends_with(".crdownload")));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn temp_and_hidden_names() {
        for temp in ["a.crdownload", "a.zip.part", "x.PARTIAL", "y.tmp", "z.download", "~$Report.docx", "notes.txt~"] {
            assert!(is_temp_name(temp), "{temp}");
        }
        for fine in ["a.zip", "partial.txt", "tmp", "download.pdf"] {
            assert!(!is_temp_name(fine), "{fine}");
        }
        assert!(is_hidden_name(".DS_Store") && is_hidden_name("Desktop.ini") && is_hidden_name("Thumbs.db"));
        assert!(!is_hidden_name("photo.jpg"));
    }

    #[test]
    fn lru_evicts_the_least_recently_used() {
        let mut lru = Lru::new(2);
        lru.insert("a", 1);
        lru.insert("b", 2);
        assert_eq!(lru.get(&"a"), Some(1));
        lru.insert("c", 3);
        assert_eq!(lru.get(&"b"), None);
        assert_eq!(lru.get(&"a"), Some(1));
        assert_eq!(lru.get(&"c"), Some(3));
        lru.insert("c", 4);
        assert_eq!(lru.len(), 2);
        assert_eq!(lru.get(&"c"), Some(4));
        assert_eq!(lru.best(|k| *k != "zzz", |k| k.len() as u32 + if *k == "c" { 1 } else { 0 }), Some(4));
    }

    #[test]
    fn coalesces_a_burst_into_one() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(Duration::from_millis(250));
        assert_eq!(c.wait(t0), None);
        assert!(!c.take_due(t0));
        c.poke(t0);
        c.poke(t0 + Duration::from_millis(100));
        c.poke(t0 + Duration::from_millis(200));
        assert_eq!(c.wait(t0 + Duration::from_millis(100)), Some(Duration::from_millis(150)));
        assert!(!c.take_due(t0 + Duration::from_millis(249)));
        assert!(c.take_due(t0 + Duration::from_millis(250)));
        assert!(!c.take_due(t0 + Duration::from_millis(400)));
        assert_eq!(c.wait(t0 + Duration::from_millis(400)), None);
    }

    #[test]
    fn base64_matches_the_rfc() {
        for (input, out) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(input.as_bytes()), out);
        }
    }

    #[test]
    fn bgra_becomes_straight_rgba() {
        // No alpha anywhere: opaque.
        let mut opaque = vec![10, 20, 30, 0];
        bgra_to_rgba(&mut opaque);
        assert_eq!(opaque, vec![30, 20, 10, 255]);
        // Premultiplied half-transparent red.
        let mut pm = vec![0, 0, 128, 128, 0, 0, 0, 0];
        bgra_to_rgba(&mut pm);
        assert_eq!(&pm[..4], &[255, 0, 0, 128]);
        // Straight alpha (a channel above alpha) is left alone.
        let mut straight = vec![200, 0, 0, 100];
        bgra_to_rgba(&mut straight);
        assert_eq!(straight, vec![0, 0, 200, 100]);
    }

    #[test]
    fn thumbnail_cache_names() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        assert_eq!(file_uri("/home/me/My File#1.png"), "file:///home/me/My%20File%231.png");
    }
}
