// "Convert File Format", "Video to GIF" and "Compress video": files dropped on
// the island are converted with ffmpeg, the result saved in the workspace folder
// (never over anything). ffmpeg is the
// one picked in Settings, else one this app downloaded (Windows), else the one
// on PATH.
//
// Only paths a real drop just delivered are accepted (`convert_prepare`), and
// the page never sends paths again: `convert_start` works on the ones kept
// here under the job's id.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::{t, tf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    /// Output extension, lowercase: "mp4", "mp3", "png"…
    pub id: String,
    /// What the button says: "MP4", "MP3 (audio)", "PNG"…
    pub label: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertJob {
    pub id: u64,
    /// File names (not paths) of the dropped files.
    pub names: Vec<String>,
    /// "video" | "audio" | "image"
    pub kind: String,
    pub formats: Vec<FormatOption>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    /// The ffmpeg that will be used, if any.
    pub path: Option<String>,
    /// "settings" | "downloaded" | "path" when found.
    pub source: Option<String>,
    /// A download is offered on this system (Windows).
    pub can_download: bool,
    /// A download is running right now.
    pub downloading: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ConvertProgress {
    id: u64,
    index: usize,
    count: usize,
    fraction: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ConvertDone {
    id: u64,
    outputs: Vec<String>,
    error: Option<String>,
    cancelled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

// ── Kinds and formats ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Video,
    Audio,
    Image,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Video => "video",
            Kind::Audio => "audio",
            Kind::Image => "image",
        }
    }
}

const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ts", "mts", "m2ts", "ogv", "gif",
];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus", "wma", "aif", "aiff", "amr"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "tga"];

const VIDEO_TARGETS: &[(&str, &str)] =
    &[("mp4", "MP4"), ("webm", "WebM"), ("mov", "MOV"), ("mkv", "MKV"), ("gif", "GIF"), ("mp3", "MP3 (audio)")];
const AUDIO_TARGETS: &[(&str, &str)] =
    &[("mp3", "MP3"), ("wav", "WAV"), ("flac", "FLAC"), ("m4a", "M4A"), ("ogg", "OGG"), ("opus", "OPUS")];
const IMAGE_TARGETS: &[(&str, &str)] =
    &[("png", "PNG"), ("jpg", "JPG"), ("webp", "WebP"), ("bmp", "BMP"), ("tiff", "TIFF")];

/// Lowercase extension of `path`, if any.
fn extension(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).filter(|e| !e.is_empty())
}

fn kind_of_ext(ext: &str) -> Option<Kind> {
    if VIDEO_EXTS.contains(&ext) {
        Some(Kind::Video)
    } else if AUDIO_EXTS.contains(&ext) {
        Some(Kind::Audio)
    } else if IMAGE_EXTS.contains(&ext) {
        Some(Kind::Image)
    } else {
        None
    }
}

/// Spellings of one format folded together: a .jpeg is already a JPG.
fn canonical(ext: &str) -> &str {
    match ext {
        "jpeg" => "jpg",
        "tif" => "tiff",
        "m4v" => "mp4",
        "oga" => "ogg",
        "aif" => "aiff",
        other => other,
    }
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// The one kind all `paths` share, by extension.
fn classify(paths: &[PathBuf]) -> Result<Kind, String> {
    let mut kind = None;
    for path in paths {
        let found = extension(path).as_deref().and_then(kind_of_ext);
        let Some(found) = found else {
            return Err(tf("{name} can't be converted: Pod doesn't know this format.", &[("name", &display_name(path))]));
        };
        match kind {
            None => kind = Some(found),
            Some(k) if k != found => return Err(t("Drop only videos, only audio or only images at once.")),
            _ => {}
        }
    }
    kind.ok_or_else(|| t("Drop a file to convert."))
}

/// The targets offered for `paths`: all of `kind`'s, less the format every
/// input already is.
fn formats_for(kind: Kind, paths: &[PathBuf]) -> Vec<FormatOption> {
    let exts: HashSet<String> = paths.iter().filter_map(|p| extension(p)).map(|e| canonical(&e).to_string()).collect();
    let same = if exts.len() == 1 { exts.into_iter().next() } else { None };
    let table = match kind {
        Kind::Video => VIDEO_TARGETS,
        Kind::Audio => AUDIO_TARGETS,
        Kind::Image => IMAGE_TARGETS,
    };
    table
        .iter()
        .filter(|(id, _)| same.as_deref() != Some(*id))
        .map(|(id, label)| FormatOption { id: id.to_string(), label: label.to_string() })
        .collect()
}

// ── Recipes for the GIF and Compress tiles ───────────────────────────────────
//
// Two targets that are not offered in Convert's format chips: "gif" (also one
// of them) from the Video → GIF tile, and "share", a smaller MP4 to send.

/// Video → GIF: 15 frames a second, at most 480 px wide (the aspect kept), with
/// a palette made for this clip (palettegen) and applied to it (paletteuse) in
/// one filter graph, so there is no temporary palette file.
const GIF_FILTER: &str = "fps=15,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";

/// Compress for sharing: never bigger than 1080p (1920×1080 landscape,
/// 1080×1920 portrait), the aspect kept, never enlarged, even sides for H.264.
const SHARE_SCALE: &str = "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2";

/// The recipes `convert_quick` accepts: the target, and what its chip would say.
fn recipe(id: &str) -> Option<FormatOption> {
    match id {
        "gif" => Some(FormatOption { id: "gif".into(), label: "GIF".into() }),
        "share" => Some(FormatOption { id: "share".into(), label: t("Smaller MP4") }),
        _ => None,
    }
}

/// The output's file name for `input` converted to `target`: "clip.gif",
/// "clip (small).mp4" for the copy to share.
fn output_name(input: &Path, target: &str) -> String {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".into());
    match target {
        "share" => format!("{stem} (small).mp4"),
        _ => format!("{stem}.{target}"),
    }
}

/// `ffmpeg_args_with` and the CPU encoders.
#[cfg(test)]
fn ffmpeg_args(input: &Path, output: &Path, target: &str) -> Vec<String> {
    ffmpeg_args_with(input, output, target, None)
}

/// The full ffmpeg command line (without the program) converting `input` to
/// `output` as `target`, H.264 on the GPU encoder `gpu` when one is given.
/// No shell is involved: each element is one argument.
fn ffmpeg_args_with(input: &Path, output: &Path, target: &str, gpu: Option<&str>) -> Vec<String> {
    let share = target == "share";
    let h264: Vec<&str> = match gpu {
        Some(encoder) if share => [&["-c:v", encoder][..], gpu_share_args(encoder)].concat(),
        Some(encoder) => [&["-c:v", encoder][..], gpu_video_args(encoder)].concat(),
        // A little more compression for sharing: CRF 23, x264's own default, still clean.
        None if share => vec!["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p"],
        None => vec!["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"],
    };
    let small: Vec<&str> = [
        &h264[..],
        // No subtitle or data streams: an MP4 can't take most of them, and they'd stop the encode.
        &["-vf", SHARE_SCALE, "-c:a", "aac", "-b:a", "128k", "-sn", "-dn", "-movflags", "+faststart"],
    ]
    .concat();
    let mp4: Vec<&str> = [
        &h264[..],
        &["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    ]
    .concat();
    let codec: &[&str] = match target {
        "mp4" | "mov" => &mp4,
        "share" => &small,
        "webm" => &[
            "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
            "-c:a", "libopus", "-b:a", "128k",
        ],
        "mkv" => &["-c", "copy"],
        "gif" => &["-vf", GIF_FILTER, "-loop", "0"],
        "mp3" => &["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        "wav" => &["-vn", "-c:a", "pcm_s16le"],
        "flac" => &["-vn", "-c:a", "flac"],
        "m4a" => &["-vn", "-c:a", "aac", "-b:a", "192k"],
        "ogg" => &["-vn", "-c:a", "libvorbis", "-q:a", "5"],
        "opus" => &["-vn", "-c:a", "libopus", "-b:a", "128k"],
        "jpg" => &["-frames:v", "1", "-q:v", "2"],
        "webp" => &["-frames:v", "1", "-c:v", "libwebp", "-quality", "90"],
        // png, bmp, tiff
        _ => &["-frames:v", "1"],
    };
    // -y: `run_job` has already claimed `output` (an empty file of its own), so
    // ffmpeg writes into that; with -n it would refuse its own claim.
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(input.to_string_lossy().to_string());
    args.extend(codec.iter().map(|s| s.to_string()));
    args.extend(["-progress", "pipe:1", "-nostats"].iter().map(|s| s.to_string()));
    args.push(output.to_string_lossy().to_string());
    args
}

// ── GPU encoders ──────────────────────────────────────────────────────────────
//
// H.264 is encoded on the graphics card when ffmpeg has an encoder for it:
// NVIDIA (NVENC), then Intel (Quick Sync), then AMD (AMF). Several times faster
// and it leaves the processor free. ffmpeg lists the encoders it was built
// with, not the ones this PC can run, so an encode that fails before any
// progress is run again on the processor, and that encoder isn't tried again
// this session.

/// GPU encoders per codec, in the order they are tried.
const GPU_ENCODERS: &[(&str, &[&str])] = &[
    ("h264", &["h264_nvenc", "h264_qsv", "h264_amf"]),
    ("hevc", &["hevc_nvenc", "hevc_qsv", "hevc_amf"]),
];

/// `ffmpeg -encoders` of the ffmpeg last asked, kept for the session.
static ENCODERS: Mutex<Option<(PathBuf, HashSet<String>)>> = Mutex::new(None);
/// GPU encoders that failed to start here: never tried again this session.
static BROKEN_GPU: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The video codec a target is encoded with, when a GPU could do it.
fn gpu_codec(target: &str) -> Option<&'static str> {
    match target {
        "mp4" | "mov" | "share" => Some("h264"),
        _ => None,
    }
}

/// Encoder names in `ffmpeg -encoders` output: after the "------" line, each
/// line is the flags ("V....D"), the name, then a description.
fn parse_encoders(listing: &str) -> HashSet<String> {
    listing
        .lines()
        .skip_while(|line| !line.trim_start().starts_with("---"))
        .skip(1)
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let flags = words.next()?;
            let name = words.next()?;
            flags.starts_with('V').then(|| name.to_string())
        })
        .collect()
}

/// The first GPU encoder for `codec` this ffmpeg has and that hasn't failed.
fn pick_gpu_encoder(codec: &str, available: &HashSet<String>, broken: &HashSet<String>) -> Option<&'static str> {
    let (_, names) = GPU_ENCODERS.iter().find(|(c, _)| *c == codec)?;
    names.iter().copied().find(|name| available.contains(*name) && !broken.contains(*name))
}

/// Encoder options for each GPU family, at about the quality of CRF 20.
fn gpu_video_args(encoder: &str) -> &'static [&'static str] {
    if encoder.ends_with("_nvenc") {
        &["-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p"]
    } else if encoder.ends_with("_qsv") {
        &["-preset", "medium", "-global_quality", "21", "-pix_fmt", "nv12"]
    } else {
        &["-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22", "-pix_fmt", "yuv420p"]
    }
}

/// The GPU options for the copy to share: a few steps smaller than
/// `gpu_video_args`, about CRF 23 on the processor.
fn gpu_share_args(encoder: &str) -> &'static [&'static str] {
    if encoder.ends_with("_nvenc") {
        &["-preset", "p5", "-rc", "vbr", "-cq", "25", "-b:v", "0", "-pix_fmt", "yuv420p"]
    } else if encoder.ends_with("_qsv") {
        &["-preset", "medium", "-global_quality", "25", "-pix_fmt", "nv12"]
    } else {
        &["-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "25", "-pix_fmt", "yuv420p"]
    }
}

/// The GPU encoder to use for `target` with `ffmpeg`, if any. `ffmpeg
/// -encoders` runs once per ffmpeg, the first time a video is converted.
fn gpu_encoder(ffmpeg: &Path, target: &str) -> Option<&'static str> {
    let codec = gpu_codec(target)?;
    let available = {
        let mut cached = lock(&ENCODERS);
        match cached.as_ref() {
            Some((path, set)) if path == ffmpeg => set.clone(),
            _ => {
                let set = list_encoders(ffmpeg);
                *cached = Some((ffmpeg.to_path_buf(), set.clone()));
                set
            }
        }
    };
    let broken = lock(&BROKEN_GPU).clone().unwrap_or_default();
    pick_gpu_encoder(codec, &available, &broken)
}

fn mark_gpu_broken(encoder: &str) {
    lock(&BROKEN_GPU).get_or_insert_with(HashSet::new).insert(encoder.to_string());
}

/// Runs `ffmpeg -hide_banner -encoders` (10 s at most); empty when it fails.
fn list_encoders(ffmpeg: &Path) -> HashSet<String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-encoders"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(mut child) = crate::platform::no_console(&mut cmd).spawn() else {
        return HashSet::new();
    };
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.take(1024 * 1024).read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let encoders = parse_encoders(&reader.join().unwrap_or_default());
    let gpu: Vec<&str> = GPU_ENCODERS
        .iter()
        .flat_map(|(_, names)| names.iter().copied())
        .filter(|name| encoders.contains(*name))
        .collect();
    let found = if gpu.is_empty() { "none".to_string() } else { gpu.join(", ") };
    crate::log::line(format!("convert: GPU encoders in ffmpeg: {found}"));
    encoders
}

// ── Parsing ffmpeg's output ───────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum ProgressLine {
    /// Position in the output, in microseconds.
    Time(u64),
    End,
}

/// One `-progress` line: `out_time_us=` and `out_time_ms=` (both are
/// microseconds), `progress=end`. Anything else, `N/A` included, is None.
fn parse_progress_line(line: &str) -> Option<ProgressLine> {
    let (key, value) = line.trim().split_once('=')?;
    match key {
        "out_time_us" | "out_time_ms" => value.trim().parse::<i64>().ok().filter(|v| *v >= 0).map(|v| ProgressLine::Time(v as u64)),
        "progress" if value.trim() == "end" => Some(ProgressLine::End),
        _ => None,
    }
}

/// The input's length from `  Duration: 00:01:02.50, start: …`, in seconds.
fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration:")?.trim_start();
    let stamp = rest.split(',').next()?.trim();
    let mut parts = stamp.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = h * 3600.0 + m * 60.0 + s;
    (total > 0.0).then_some(total)
}

/// The line of ffmpeg's stderr worth showing when it failed: the last one that
/// says something, not its closing "Conversion failed!".
fn error_line(lines: &VecDeque<String>) -> Option<String> {
    let line = lines.iter().rev().map(|l| l.trim()).find(|l| {
        !l.is_empty()
            && !l.eq_ignore_ascii_case("Conversion failed!")
            && !l.starts_with("Exiting normally")
            && !l.starts_with("Press [q]")
    })?;
    let mut line = line.to_string();
    if line.chars().count() > 200 {
        line = line.chars().take(200).collect::<String>() + "…";
    }
    Some(line)
}

/// The first 64-hex-digit word of a `.sha256` file, lowercase.
fn parse_sha256(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| w.len() == 64 && w.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|w| w.to_ascii_lowercase())
}

fn same_sha256(a: &str, b: &str) -> bool {
    a.len() == 64 && a.eq_ignore_ascii_case(b)
}

// ── Finding ffmpeg ────────────────────────────────────────────────────────────

const FFMPEG_EXE: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

fn bin_dir() -> PathBuf {
    crate::settings::local_dir().join("bin")
}

fn downloaded_path() -> PathBuf {
    bin_dir().join(FFMPEG_EXE)
}

/// The ffmpeg Pod downloaded, for the self-repair (heal.rs): the only copy it may remove.
pub(crate) fn downloaded_ffmpeg() -> PathBuf {
    downloaded_path()
}

/// An ffmpeg download is under way: its files are not leftovers.
pub(crate) fn ffmpeg_downloading() -> bool {
    DOWNLOADING.load(Ordering::SeqCst)
}

/// `path -version` answers like ffmpeg (heal.rs).
pub(crate) fn answers_as_ffmpeg(path: &Path) -> bool {
    is_ffmpeg(path, VERSION_TIMEOUT)
}

/// The ffmpeg to use and where it came from.
fn locate(chosen: &str) -> Option<(PathBuf, &'static str)> {
    let chosen = chosen.trim();
    if !chosen.is_empty() && Path::new(chosen).is_file() {
        return Some((PathBuf::from(chosen), "settings"));
    }
    let downloaded = downloaded_path();
    if downloaded.is_file() {
        return Some((downloaded, "downloaded"));
    }
    crate::platform::find_on_path("ffmpeg").map(|p| (p, "path"))
}

fn chosen_path(app: &AppHandle) -> String {
    app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).ffmpeg_path.clone()
}

fn status_for(chosen: &str) -> FfmpegStatus {
    let found = locate(chosen);
    FfmpegStatus {
        path: found.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        source: found.map(|(_, s)| s.to_string()),
        can_download: cfg!(windows),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
    }
}

/// A file run for the first time can be held by the antivirus for a few
/// seconds while it is scanned, so a just-picked or just-unpacked ffmpeg gets
/// longer than 2 s to answer.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const FRESH_VERSION_TIMEOUT: Duration = Duration::from_secs(60);

/// Runs `path -version` (`timeout` at most): true when it really is ffmpeg.
fn is_ffmpeg(path: &Path, timeout: Duration) -> bool {
    let mut cmd = Command::new(path);
    cmd.arg("-version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(mut child) = crate::platform::no_console(&mut cmd).spawn() else {
        return false;
    };
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.take(64 * 1024).read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                crate::log::line(format!("convert: {} -version did not answer in time", path.display()));
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
    reader.join().map(|text| text.trim_start().starts_with("ffmpeg version")).unwrap_or(false)
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/// What a running job shares with `convert_cancel`.
#[derive(Default)]
struct RunState {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
    /// The file ffmpeg is writing right now (claimed by `run_job`), for `shutdown`.
    output: Mutex<Option<PathBuf>>,
}

impl RunState {
    fn kill(&self) {
        if let Some(child) = lock(&self.child).as_mut() {
            let _ = child.kill();
        }
    }
}

struct Job {
    paths: Vec<PathBuf>,
    formats: Vec<String>,
    created: Instant,
    run: Option<Arc<RunState>>,
}

const MAX_JOBS: usize = 32;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: Mutex<Option<HashMap<u64, Job>>> = Mutex::new(None);
/// Files written by this module this session: the only ones `reveal_output` shows.
static OUTPUTS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_jobs<R>(f: impl FnOnce(&mut HashMap<u64, Job>) -> R) -> R {
    let mut guard = lock(&JOBS);
    f(guard.get_or_insert_with(HashMap::new))
}

fn remember_output(path: &Path) {
    let mut guard = lock(&OUTPUTS);
    let set = guard.get_or_insert_with(HashSet::new);
    if set.len() >= 1000 {
        set.clear();
    }
    set.insert(path.to_path_buf());
}

fn is_output(path: &Path) -> bool {
    lock(&OUTPUTS).as_ref().is_some_and(|s| s.contains(path))
}

/// Why one file failed, or that it was cancelled.
enum RunError {
    Cancelled,
    Failed(String),
}

/// Converts `input` to `output` with `ffmpeg`, reporting this file's fraction
/// (0…1) as it goes. `output` must be a file the caller claimed (`claim_output`):
/// ffmpeg writes over it, and it is deleted on failure or cancel.
fn run_one(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    target: &str,
    gpu: Option<&str>,
    state: &RunState,
    mut on_fraction: impl FnMut(f64),
) -> Result<(), RunError> {
    if state.cancelled.load(Ordering::SeqCst) {
        return Err(RunError::Cancelled);
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(ffmpeg_args_with(input, output, target, gpu))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Low priority (and EcoQoS on Windows): a conversion never slows the PC down.
    let mut child = crate::platform::spawn_background(&mut cmd).map_err(|e| {
        crate::log::line(format!("convert: could not start ffmpeg: {e}"));
        RunError::Failed(tf("Couldn't start ffmpeg: {error}", &[("error", &e.to_string())]))
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *lock(&state.child) = Some(child);
    if state.cancelled.load(Ordering::SeqCst) {
        state.kill();
    }

    // stderr on its own thread: the input's duration, and the last lines for
    // an error message.
    let duration_us = Arc::new(AtomicU64::new(0));
    let err_reader = {
        let duration_us = duration_us.clone();
        std::thread::spawn(move || {
            let mut tail: VecDeque<String> = VecDeque::new();
            let Some(stderr) = stderr else { return tail };
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                for piece in String::from_utf8_lossy(&buf).split('\r') {
                    let line = piece.trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if duration_us.load(Ordering::SeqCst) == 0 {
                        if let Some(secs) = parse_duration(&line) {
                            duration_us.store((secs * 1_000_000.0) as u64, Ordering::SeqCst);
                        }
                    }
                    tail.push_back(line);
                    if tail.len() > 15 {
                        tail.pop_front();
                    }
                }
            }
            tail
        })
    };

    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            match parse_progress_line(&line) {
                Some(ProgressLine::Time(us)) => {
                    let total = duration_us.load(Ordering::SeqCst);
                    if total > 0 {
                        on_fraction((us as f64 / total as f64).clamp(0.0, 1.0));
                    }
                }
                Some(ProgressLine::End) => on_fraction(1.0),
                None => {}
            }
        }
    }

    // stdout closed: ffmpeg is exiting (or was killed). Wait without holding
    // the lock for long, so a cancel never blocks.
    let status = loop {
        let mut guard = lock(&state.child);
        let Some(child) = guard.as_mut() else { break None };
        match child.try_wait() {
            Ok(Some(status)) => {
                *guard = None;
                break Some(status);
            }
            Ok(None) => {
                drop(guard);
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                *guard = None;
                break None;
            }
        }
    };
    let tail = err_reader.join().unwrap_or_default();

    if state.cancelled.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Err(RunError::Cancelled);
    }
    if status.is_some_and(|s| s.success()) && output.is_file() {
        on_fraction(1.0);
        return Ok(());
    }
    let _ = std::fs::remove_file(output);
    let detail = error_line(&tail).unwrap_or_else(|| t("ffmpeg stopped with an error."));
    crate::log::line(format!("convert: ffmpeg failed on {}: {detail}", display_name(input)));
    Err(RunError::Failed(tf("Couldn't convert {name}: {error}", &[("name", &display_name(input)), ("error", &detail)])))
}

/// The worker: every file of the job in turn, then one `convert-done`.
/// Outputs go into `out`, the workspace folder.
fn run_job(app: AppHandle, id: u64, ffmpeg: PathBuf, paths: Vec<PathBuf>, out: PathBuf, target: String, state: Arc<RunState>) {
    let _busy = crate::files::JobGuard::new();
    let count = paths.len();
    let mut outputs: Vec<String> = Vec::new();
    let mut error = None;
    let mut cancelled = false;
    let mut last_sent = -1.0f64;
    let mut last_at = Instant::now() - Duration::from_secs(1);
    let mut already_small = 0usize;

    for (index, input) in paths.iter().enumerate() {
        let name = output_name(input, &target);
        let mut output = match claim_output(&out, &name, &state) {
            Ok(path) => path,
            Err(message) => {
                error = Some(message);
                break;
            }
        };
        let mut report = |file_fraction: f64, force: bool| {
            let overall = ((index as f64 + file_fraction) / count as f64).clamp(0.0, 1.0);
            if force || overall - last_sent >= 0.01 || (overall > last_sent && last_at.elapsed() >= Duration::from_millis(100)) {
                last_sent = overall;
                last_at = Instant::now();
                let _ = app.emit("convert-progress", ConvertProgress { id, index, count, fraction: overall });
            }
        };
        report(0.0, true);
        let gpu = gpu_encoder(&ffmpeg, &target);
        let mut progressed = false;
        let mut result = run_one(&ffmpeg, input, &output, &target, gpu, &state, |f| {
            progressed |= f > 0.0;
            report(f, false)
        });
        // The GPU encoder is listed but can't run here (no such card, old
        // driver): the same file again on the processor.
        if let (Some(encoder), Err(RunError::Failed(_))) = (gpu, &result) {
            if !progressed && !state.cancelled.load(Ordering::SeqCst) {
                crate::log::line(format!("convert: {encoder} failed to start, using the processor"));
                mark_gpu_broken(encoder);
                // The failed run removed its file: the name is claimed again.
                result = match claim_output(&out, &name, &state) {
                    Ok(path) => {
                        output = path;
                        run_one(&ffmpeg, input, &output, &target, None, &state, |f| report(f, false))
                    }
                    Err(message) => Err(RunError::Failed(message)),
                };
            }
        }
        // Finished (or already removed by run_one): no longer `shutdown`'s to remove.
        *lock(&state.output) = None;
        match result {
            // "Compress video" that came out no smaller: the original is
            // already as small as it gets, so no bigger copy is kept.
            Ok(()) if target == "share" && !is_smaller(&output, input) => {
                let _ = std::fs::remove_file(&output);
                already_small += 1;
            }
            Ok(()) => {
                remember_output(&output);
                outputs.push(output.to_string_lossy().to_string());
            }
            Err(RunError::Cancelled) => {
                cancelled = true;
                break;
            }
            Err(RunError::Failed(message)) => {
                error = Some(message);
                break;
            }
        }
    }

    if outputs.is_empty() && already_small > 0 && error.is_none() && !cancelled {
        error = Some(t("This video is already as small as Pod can make it."));
    }
    with_jobs(|jobs| jobs.remove(&id));
    let _ = app.emit("convert-done", ConvertDone { id, outputs, error, cancelled });
}

/// Takes a free name for `name` in `out` by creating it, empty: a file that
/// appeared since `unique_path` looked (another conversion of the same file) is
/// never written over by ffmpeg, nor removed when this conversion fails.
fn claim_output(out: &Path, name: &str, state: &RunState) -> Result<PathBuf, String> {
    let (path, file) = crate::archive::create_unique(out, name).map_err(|e| crate::archive::cannot_write(name, &e))?;
    drop(file);
    *lock(&state.output) = Some(path.clone());
    Ok(path)
}

/// Pod is quitting: every running ffmpeg is stopped and its unfinished file
/// removed, so no conversion goes on (and leaves half a file) without Pod.
pub fn shutdown() {
    let runs: Vec<Arc<RunState>> = with_jobs(|jobs| jobs.values().filter_map(|j| j.run.clone()).collect());
    for state in runs {
        state.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = lock(&state.child).as_mut() {
            let _ = child.kill();
            // Gone for real, so its file can be removed (Windows keeps an open file).
            let _ = child.wait();
        }
        if let Some(output) = lock(&state.output).take() {
            let _ = std::fs::remove_file(output);
        }
    }
}

/// The output is smaller than the input (both readable).
fn is_smaller(output: &Path, input: &Path) -> bool {
    match (std::fs::metadata(output), std::fs::metadata(input)) {
        (Ok(o), Ok(i)) => o.len() < i.len(),
        _ => true,
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn convert_prepare(paths: Vec<String>) -> Result<ConvertJob, String> {
    prepare(paths, None)
}

/// The GIF and Compress tiles: a job for videos with one target, `recipe`
/// ("gif" or "share"), started like a conversion (`convert_start`).
#[tauri::command]
pub fn convert_quick(paths: Vec<String>, recipe: String) -> Result<ConvertJob, String> {
    let format = self::recipe(&recipe).ok_or_else(|| tf("Unknown action: {action}", &[("action", &recipe)]))?;
    prepare(paths, Some(format))
}

fn prepare(paths: Vec<String>, only: Option<FormatOption>) -> Result<ConvertJob, String> {
    if paths.is_empty() {
        return Err(t("Drop a file to convert."));
    }
    // Every path is checked (and so used up), even after one is refused.
    let all_dropped = paths.iter().fold(true, |ok, p| crate::files::take_dropped(p) && ok);
    if !all_dropped {
        return Err(t("Only files dropped on the island can be added."));
    }
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    for path in &paths {
        let meta = std::fs::metadata(path).map_err(|e| {
            tf("Cannot read {path}: {error}", &[("path", &path.to_string_lossy()), ("error", &e.to_string())])
        })?;
        if meta.is_dir() {
            return Err(t("Folders can't be converted. Drop the files themselves."));
        }
    }
    let kind = classify(&paths)?;
    let formats = match only {
        Some(format) if kind == Kind::Video => vec![format],
        Some(_) => return Err(t("Drop videos for this action.")),
        None => formats_for(kind, &paths),
    };
    if formats.is_empty() {
        return Err(t("There is nothing to convert these files to."));
    }
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let job = ConvertJob {
        id,
        names: paths.iter().map(|p| display_name(p)).collect(),
        kind: kind.as_str().to_string(),
        formats: formats.clone(),
    };
    with_jobs(|jobs| {
        // Jobs offered but never started don't pile up.
        while jobs.len() >= MAX_JOBS {
            let oldest = jobs.iter().filter(|(_, j)| j.run.is_none()).min_by_key(|(_, j)| j.created).map(|(k, _)| *k);
            match oldest {
                Some(k) => {
                    jobs.remove(&k);
                }
                None => break,
            }
        }
        jobs.insert(id, Job { paths, formats: formats.into_iter().map(|f| f.id).collect(), created: Instant::now(), run: None });
    });
    Ok(job)
}

#[tauri::command]
pub fn convert_start(app: AppHandle, id: u64, format: String) -> Result<(), String> {
    let chosen = chosen_path(&app);
    let out = crate::workspace::output_dir(&app)?;
    let (paths, state) = with_jobs(|jobs| {
        let job = jobs.get_mut(&id).ok_or_else(|| t("This conversion is no longer available. Drop the files again."))?;
        if job.run.is_some() {
            return Err(t("This conversion has already started."));
        }
        if !job.formats.iter().any(|f| f == &format) {
            return Err(t("This format isn't offered for these files."));
        }
        let state = Arc::new(RunState::default());
        job.run = Some(state.clone());
        Ok((job.paths.clone(), state))
    })?;
    let Some((ffmpeg, _)) = locate(&chosen) else {
        // Not started after all: the user can download ffmpeg and try again.
        with_jobs(|jobs| {
            if let Some(job) = jobs.get_mut(&id) {
                job.run = None;
            }
        });
        return Err(t("ffmpeg isn't installed."));
    };
    std::thread::Builder::new()
        .name("convert".into())
        .spawn(move || run_job(app, id, ffmpeg, paths, out, format, state))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn convert_cancel(id: u64) {
    with_jobs(|jobs| match jobs.get(&id).and_then(|j| j.run.clone()) {
        // The worker sees it, deletes the partial file and sends convert-done.
        Some(state) => {
            state.cancelled.store(true, Ordering::SeqCst);
            state.kill();
        }
        None => {
            jobs.remove(&id);
        }
    });
}

#[tauri::command]
pub fn ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    status_for(&chosen_path(&app))
}

#[tauri::command]
pub fn ffmpeg_download(app: AppHandle) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(t("Install ffmpeg with your package manager (for example: sudo apt install ffmpeg)."));
    }
    if DOWNLOADING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(t("ffmpeg is already downloading."));
    }
    tauri::async_runtime::spawn(async move {
        let result = download_ffmpeg(&app).await;
        DOWNLOADING.store(false, Ordering::SeqCst);
        let total = result.as_ref().map(|n| *n).unwrap_or(0);
        if let Err(err) = &result {
            crate::log::line(format!("ffmpeg download: {err}"));
        }
        let _ = app.emit(
            "ffmpeg-download",
            DownloadProgress { received: total, total, done: true, error: result.err() },
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn ffmpeg_choose(app: AppHandle) -> Result<Option<FfmpegStatus>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = picker.dialog().file();
        let dialog = if cfg!(windows) { dialog.add_filter("ffmpeg", &["exe"]) } else { dialog };
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let check = path.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || check.is_file() && is_ffmpeg(&check, VERSION_TIMEOUT)).await.unwrap_or(false);
    if !ok {
        return Err(tf("{name} isn't ffmpeg.", &[("name", &display_name(&path))]));
    }
    let shared = app.state::<crate::Shared>();
    let updated = {
        let mut current = shared.settings.lock().unwrap_or_else(|e| e.into_inner());
        current.ffmpeg_path = path.to_string_lossy().to_string();
        if let Err(err) = crate::settings::save(&current) {
            crate::log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let status = status_for(&updated.ffmpeg_path);
    let _ = app.emit("settings-changed", updated);
    Ok(Some(status))
}

/// What "Show in folder" may show: a file this module wrote this session, or
/// anything directly in the workspace folder (where every drop action saves).
fn may_reveal(file: &Path, workspace: &Path) -> bool {
    is_output(file) || (file.parent() == Some(workspace) && file.file_name().is_some())
}

#[tauri::command]
pub fn reveal_output(app: AppHandle, path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !may_reveal(&file, &crate::workspace::dir(&app)) {
        return Err(t("Only converted files can be shown."));
    }
    if !file.exists() {
        return Err(t("This file is no longer there."));
    }
    #[cfg(windows)]
    crate::platform::reveal_file(&file)?;
    #[cfg(not(windows))]
    {
        let parent = file.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        crate::platform::reveal_folder(&parent);
    }
    Ok(())
}

// ── Downloading ffmpeg (Windows) ──────────────────────────────────────────────

const FFMPEG_ZIP_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_SHA_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";
/// Far above the ~115 MB the essentials build weighs, but bounded.
const FFMPEG_MAX_BYTES: u64 = 600 * 1024 * 1024;

/// https only, a few redirects (gyan.dev sends the zip from GitHub). The
/// SHA-256 published on gyan.dev is what vouches for the bytes.
fn download_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 8 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() == "https" {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(timeout)
        .user_agent("Pod")
        .redirect(policy)
        .build()
        .map_err(|e| e.to_string())
}

/// Removes the download's leftovers, whatever happened.
struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in &self.0 {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Downloads, checks and installs ffmpeg.exe in local_dir()/bin. Returns the
/// number of bytes downloaded.
async fn download_ffmpeg(app: &AppHandle) -> Result<u64, String> {
    download_ffmpeg_with(|received, total| {
        let _ = app.emit("ffmpeg-download", DownloadProgress { received, total, done: false, error: None });
    })
    .await
}

async fn download_ffmpeg_with(mut progress: impl FnMut(u64, u64)) -> Result<u64, String> {
    use std::io::Write;
    let failed = || t("The ffmpeg download failed. Check your connection and try again.");

    let bin = bin_dir();
    crate::platform::ensure_private_dir(&crate::settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let part = bin.join("ffmpeg-download.zip.part");
    let tmp = bin.join(format!("ffmpeg-extract-{}", std::process::id()));
    let _cleanup = Cleanup(vec![part.clone(), tmp.clone()]);

    // The checksum first, from gyan.dev itself.
    let response = download_client(Duration::from_secs(60))?.get(FFMPEG_SHA_URL).send().await.map_err(|e| {
        crate::log::line(format!("ffmpeg download: checksum: {e}"));
        failed()
    })?;
    if !response.status().is_success() {
        crate::log::line(format!("ffmpeg download: checksum HTTP {}", response.status().as_u16()));
        return Err(failed());
    }
    let body = crate::net::read_capped(response, 4096).await?;
    let expected = parse_sha256(&String::from_utf8_lossy(&body)).ok_or_else(failed)?;

    // The zip, hashed as it streams.
    let mut response = download_client(Duration::from_secs(1800))?.get(FFMPEG_ZIP_URL).send().await.map_err(|e| {
        crate::log::line(format!("ffmpeg download: {e}"));
        failed()
    })?;
    if !response.status().is_success() || response.url().scheme() != "https" {
        crate::log::line(format!("ffmpeg download: HTTP {}", response.status().as_u16()));
        return Err(failed());
    }
    let total = response.content_length().unwrap_or(0);
    if total > FFMPEG_MAX_BYTES {
        return Err(failed());
    }
    let mut out = std::fs::File::create(&part).map_err(|e| tf("Cannot save ffmpeg: {error}", &[("error", &e.to_string())]))?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut got: u64 = 0;
    let mut last_emit = Instant::now();
    progress(0, total);
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        crate::log::line(format!("ffmpeg download: {e}"));
        failed()
    })? {
        got += chunk.len() as u64;
        if got > FFMPEG_MAX_BYTES {
            return Err(failed());
        }
        out.write_all(&chunk).map_err(|e| tf("Cannot save ffmpeg: {error}", &[("error", &e.to_string())]))?;
        hash.update(&chunk);
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            progress(got, total);
        }
    }
    out.flush().map_err(|_| failed())?;
    drop(out);
    if total > 0 && got != total {
        return Err(failed());
    }
    let actual: String = hash.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
    if !same_sha256(&expected, &actual) {
        crate::log::line(format!("ffmpeg download: SHA-256 mismatch (expected {expected}, got {actual})"));
        return Err(t("The downloaded ffmpeg doesn't match its published checksum, so it wasn't installed."));
    }

    // Unpack ffmpeg.exe alone, check it, put it in place.
    let zip = part.clone();
    let dest = downloaded_path();
    tauri::async_runtime::spawn_blocking(move || install_from_zip(&zip, &tmp, &dest))
        .await
        .map_err(|e| e.to_string())??;
    Ok(got)
}

/// Takes `*/bin/ffmpeg.exe` out of the downloaded zip into `tmp/bin/`, with
/// the zip crate Pod already ships — not by running Windows' tar.exe: a program
/// that launches system tools to unpack what it downloaded looks like a dropper
/// to antivirus heuristics. Returns the extracted file.
fn extract_ffmpeg(zip: &Path, tmp: &Path) -> Option<PathBuf> {
    let file = std::fs::File::open(zip).ok()?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).ok()?;
    let index = (0..archive.len()).find(|&i| {
        archive.by_index(i).ok().is_some_and(|entry| {
            let name = entry.name().replace('\\', "/").to_ascii_lowercase();
            entry.is_file() && name.ends_with("/bin/ffmpeg.exe")
        })
    })?;
    let mut entry = archive.by_index(index).ok()?;
    let dir = tmp.join("bin");
    std::fs::create_dir_all(&dir).ok()?;
    let out_path = dir.join("ffmpeg.exe");
    let mut out = std::fs::File::create(&out_path).ok()?;
    if let Err(err) = std::io::copy(&mut entry, &mut out) {
        crate::log::line(format!("ffmpeg download: unzip: {err}"));
        return None;
    }
    Some(out_path)
}

/// The first `bin/ffmpeg.exe` under `dir`.
fn find_extracted(dir: &Path, depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path.file_name().is_some_and(|n| n.eq_ignore_ascii_case("ffmpeg.exe"))
            && dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("bin"))
        {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    dirs.into_iter().find_map(|d| find_extracted(&d, depth - 1))
}

fn install_from_zip(zip: &Path, tmp: &Path, dest: &Path) -> Result<(), String> {
    let failed = || t("ffmpeg was downloaded but couldn't be unpacked.");
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(tmp);
    }
    std::fs::create_dir_all(tmp).map_err(|_| failed())?;
    let found = extract_ffmpeg(zip, tmp).filter(|p| find_extracted(tmp, 1).as_deref() == Some(p.as_path()));
    let Some(extracted) = found else {
        crate::log::line("ffmpeg download: no bin/ffmpeg.exe in the zip");
        return Err(failed());
    };
    if !is_ffmpeg(&extracted, FRESH_VERSION_TIMEOUT) {
        crate::log::line("ffmpeg download: the unpacked ffmpeg.exe doesn't run");
        return Err(failed());
    }
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|_| t("The current ffmpeg is in use. Wait for conversions to finish and try again."))?;
    }
    std::fs::rename(&extracted, dest)
        .or_else(|_| std::fs::copy(&extracted, dest).map(|_| ()))
        .map_err(|e| tf("Cannot save ffmpeg: {error}", &[("error", &e.to_string())]))?;
    if !is_ffmpeg(dest, FRESH_VERSION_TIMEOUT) {
        crate::log::line("ffmpeg download: the installed ffmpeg.exe doesn't run");
        let _ = std::fs::remove_file(dest);
        return Err(failed());
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn p(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    fn ids(formats: &[FormatOption]) -> Vec<&str> {
        formats.iter().map(|f| f.id.as_str()).collect()
    }

    #[test]
    fn classifies_by_extension_and_refuses_mixed_or_unknown() {
        assert_eq!(classify(&p(&["a.MP4", "b.mov", "c.gif"])).unwrap(), Kind::Video);
        assert_eq!(classify(&p(&["a.mp3", "b.FLAC"])).unwrap(), Kind::Audio);
        assert_eq!(classify(&p(&["a.jpeg", "b.HEIC"])).unwrap(), Kind::Image);
        assert_eq!(classify(&p(&["a.mp4", "b.png"])).unwrap_err(), "Drop only videos, only audio or only images at once.");
        assert!(classify(&p(&["notes.txt"])).unwrap_err().contains("notes.txt"));
        assert!(classify(&p(&["README"])).unwrap_err().contains("README"));
    }

    #[test]
    fn the_input_format_is_left_out_only_when_every_file_has_it() {
        let f = formats_for(Kind::Image, &p(&["a.jpeg", "b.JPG"]));
        assert_eq!(ids(&f), vec!["png", "webp", "bmp", "tiff"]);
        let f = formats_for(Kind::Image, &p(&["a.tif"]));
        assert_eq!(ids(&f), vec!["png", "jpg", "webp", "bmp"]);
        let f = formats_for(Kind::Image, &p(&["a.png", "b.jpg"]));
        assert_eq!(ids(&f), vec!["png", "jpg", "webp", "bmp", "tiff"]);
        let f = formats_for(Kind::Video, &p(&["a.m4v"]));
        assert_eq!(ids(&f), vec!["webm", "mov", "mkv", "gif", "mp3"]);
        assert_eq!(f.last().unwrap().label, "MP3 (audio)");
        let f = formats_for(Kind::Audio, &p(&["a.wav"]));
        assert_eq!(ids(&f), vec!["mp3", "flac", "m4a", "ogg", "opus"]);
        let f = formats_for(Kind::Video, &p(&["a.avi"]));
        assert_eq!(f.len(), 6);
        assert_eq!(f[1].label, "WebM");
    }

    #[test]
    fn each_conversion_claims_its_own_output_and_shutdown_removes_it() {
        let dir = std::env::temp_dir().join(format!("pod-convert-claim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Two conversions of clip.mov to MP4 started together: before ffmpeg
        // creates anything, each already holds a name of its own.
        let (a, b) = (RunState::default(), RunState::default());
        let first = claim_output(&dir, "clip.mp4", &a).unwrap();
        let second = claim_output(&dir, "clip.mp4", &b).unwrap();
        assert_ne!(first, second);
        assert_eq!(second, dir.join("clip (2).mp4"));
        std::fs::write(&first, b"finished").unwrap();
        *lock(&a.output) = None;

        // Quitting removes only the unfinished one.
        with_jobs(|jobs| {
            for (id, state) in [(u64::MAX - 1, a), (u64::MAX, b)] {
                jobs.insert(id, Job { paths: Vec::new(), formats: Vec::new(), created: Instant::now(), run: Some(Arc::new(state)) });
            }
        });
        shutdown();
        with_jobs(|jobs| {
            jobs.remove(&(u64::MAX - 1));
            jobs.remove(&u64::MAX);
        });
        assert_eq!(std::fs::read(&first).unwrap(), b"finished");
        assert!(!second.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffmpeg_arguments_per_target() {
        let (i, o) = (Path::new("C:\\in dir\\a.mov"), Path::new("C:\\in dir\\a.mp4"));
        let args = ffmpeg_args(i, o, "mp4");
        assert_eq!(&args[..5], &["-hide_banner", "-nostdin", "-y", "-i", "C:\\in dir\\a.mov"]);
        assert_eq!(&args[args.len() - 4..], &["-progress", "pipe:1", "-nostats", "C:\\in dir\\a.mp4"]);
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));

        let gif = ffmpeg_args(i, Path::new("a.gif"), "gif");
        let vf = gif.iter().position(|a| a == "-vf").unwrap();
        // One graph: the palette is made from the clip and applied to it, no temporary file.
        assert_eq!(
            gif[vf + 1],
            "fps=15,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
        );
        assert!(gif.windows(2).any(|w| w == ["-loop", "0"]));

        assert_eq!(&ffmpeg_args(i, o, "mkv")[5..7], &["-c", "copy"]);
        assert_eq!(&ffmpeg_args(i, o, "mp3")[5..10], &["-vn", "-c:a", "libmp3lame", "-q:a", "2"]);
        assert_eq!(&ffmpeg_args(i, o, "wav")[5..8], &["-vn", "-c:a", "pcm_s16le"]);
        assert_eq!(&ffmpeg_args(i, o, "jpg")[5..9], &["-frames:v", "1", "-q:v", "2"]);
        assert_eq!(&ffmpeg_args(i, o, "webp")[5..11], &["-frames:v", "1", "-c:v", "libwebp", "-quality", "90"]);
        let png = ffmpeg_args(i, o, "png");
        assert_eq!(&png[5..7], &["-frames:v", "1"]);
        assert_eq!(png[7], "-progress");
        assert!(ffmpeg_args(i, o, "webm").windows(2).any(|w| w == ["-c:v", "libvpx-vp9"]));
    }

    #[test]
    fn gpu_encoders_replace_libx264_and_keep_the_rest() {
        let (i, o) = (Path::new("a.mov"), Path::new("a.mp4"));
        let nvenc = ffmpeg_args_with(i, o, "mp4", Some("h264_nvenc"));
        assert!(nvenc.windows(2).any(|w| w == ["-c:v", "h264_nvenc"]));
        assert!(!nvenc.iter().any(|a| a == "libx264" || a == "-crf"));
        assert!(nvenc.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert_eq!(&nvenc[nvenc.len() - 4..], &["-progress", "pipe:1", "-nostats", "a.mp4"]);
        let qsv = ffmpeg_args_with(i, o, "mov", Some("h264_qsv"));
        assert!(qsv.windows(2).any(|w| w == ["-pix_fmt", "nv12"]));
        let amf = ffmpeg_args_with(i, o, "mp4", Some("h264_amf"));
        assert!(amf.windows(2).any(|w| w == ["-c:v", "h264_amf"]));
        // Other targets never take one.
        assert_eq!(ffmpeg_args_with(i, o, "webm", Some("h264_nvenc")), ffmpeg_args(i, o, "webm"));
        assert_eq!(gpu_codec("mp4"), Some("h264"));
        assert_eq!(gpu_codec("mov"), Some("h264"));
        assert_eq!(gpu_codec("webm"), None);
        assert_eq!(gpu_codec("gif"), None);
    }

    #[test]
    fn the_gpu_encoder_is_picked_from_what_ffmpeg_lists() {
        let listing = "Encoders:\n V..... = Video\n A..... = Audio\n ------\n\
             V....D libx264              libx264 H.264 / AVC (codec h264)\n\
             V....D h264_amf             AMD AMF H.264 Encoder (codec h264)\n\
             V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)\n\
             V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n\
             A....D aac                  AAC (Advanced Audio Coding)\n";
        let available = parse_encoders(listing);
        assert!(available.contains("h264_qsv") && available.contains("libx264"));
        // Audio encoders and the legend are not video encoders.
        assert!(!available.contains("aac") && !available.contains("="));

        let none = HashSet::new();
        // No NVENC for H.264 here: Quick Sync comes before AMF.
        assert_eq!(pick_gpu_encoder("h264", &available, &none), Some("h264_qsv"));
        assert_eq!(pick_gpu_encoder("hevc", &available, &none), Some("hevc_nvenc"));
        // One that failed is skipped for the next in line, then the processor.
        let broken: HashSet<String> = ["h264_qsv".to_string()].into();
        assert_eq!(pick_gpu_encoder("h264", &available, &broken), Some("h264_amf"));
        let all: HashSet<String> = ["h264_qsv".to_string(), "h264_amf".to_string()].into();
        assert_eq!(pick_gpu_encoder("h264", &available, &all), None);
        assert_eq!(pick_gpu_encoder("vp9", &available, &none), None);
        assert_eq!(pick_gpu_encoder("h264", &parse_encoders(""), &none), None);
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress_line("out_time_us=1500000"), Some(ProgressLine::Time(1_500_000)));
        assert_eq!(parse_progress_line("out_time_ms=1500000\r"), Some(ProgressLine::Time(1_500_000)));
        assert_eq!(parse_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_progress_line("out_time_us=-5"), None);
        assert_eq!(parse_progress_line("progress=end"), Some(ProgressLine::End));
        assert_eq!(parse_progress_line("progress=continue"), None);
        assert_eq!(parse_progress_line("frame=12"), None);
    }

    #[test]
    fn duration_lines() {
        assert_eq!(parse_duration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 128 kb/s"), Some(62.5));
        assert_eq!(parse_duration("Duration: 01:00:00.00, start: 0"), Some(3600.0));
        assert_eq!(parse_duration("  Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_duration("  Duration: 00:00:00.00, start: 0"), None);
        assert_eq!(parse_duration("Stream #0:0: Video: h264"), None);
    }

    #[test]
    fn the_error_shown_is_the_last_meaningful_line() {
        let lines: VecDeque<String> = ["Input #0, ...", "Unknown encoder 'libfoo'", "", "Conversion failed!"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(error_line(&lines).as_deref(), Some("Unknown encoder 'libfoo'"));
        assert_eq!(error_line(&VecDeque::new()), None);
    }

    #[test]
    fn sha256_files_and_comparison() {
        let hex = "A".repeat(64);
        assert_eq!(parse_sha256(&format!("{hex}\n")), Some("a".repeat(64)));
        assert_eq!(parse_sha256(&format!("{hex} *ffmpeg.zip")), Some("a".repeat(64)));
        assert_eq!(parse_sha256("not a hash"), None);
        assert_eq!(parse_sha256(&"g".repeat(64)), None);
        assert!(same_sha256(&"a".repeat(64), &hex));
        assert!(!same_sha256(&"a".repeat(64), &"b".repeat(64)));
        assert!(!same_sha256("", ""));
    }

    #[test]
    fn reveal_refuses_files_it_did_not_write() {
        let ws = Path::new("C:\\Users\\me\\Notch Workspace");
        assert!(!may_reveal(Path::new("C:\\Windows\\notepad.exe"), ws));
        assert!(!may_reveal(ws, ws), "the workspace itself");
        assert!(!may_reveal(&ws.join("..").join("secret.txt"), ws));
        assert!(!may_reveal(&ws.join("sub").join("a.txt"), ws), "only directly in it");
        assert!(may_reveal(&ws.join("clip.gif"), ws));
    }

    #[test]
    fn compress_for_sharing_arguments() {
        let (i, o) = (Path::new("C:\\v\\clip.mov"), Path::new("C:\\ws\\clip (small).mp4"));
        let args = ffmpeg_args(i, o, "share");
        assert_eq!(&args[..5], &["-hide_banner", "-nostdin", "-y", "-i", "C:\\v\\clip.mov"]);
        assert_eq!(args.last().unwrap(), "C:\\ws\\clip (small).mp4");
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-crf", "23"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert!(args.windows(2).any(|w| w == ["-vf", SHARE_SCALE]));
        assert!(args.iter().any(|a| a == "-sn"));
        // Never past 1080p either way round, never enlarged, even sides.
        assert!(SHARE_SCALE.contains("min(1920,iw)") && SHARE_SCALE.contains("min(1080,ih)"));
        assert!(SHARE_SCALE.contains("force_original_aspect_ratio=decrease") && SHARE_SCALE.contains("force_divisible_by=2"));
        // On a GPU: its own encoder, a little smaller than a plain conversion.
        let nvenc = ffmpeg_args_with(i, o, "share", Some("h264_nvenc"));
        assert!(nvenc.windows(2).any(|w| w == ["-cq", "25"]));
        assert!(!nvenc.iter().any(|a| a == "libx264"));
        assert!(nvenc.windows(2).any(|w| w == ["-vf", SHARE_SCALE]));
        assert_eq!(gpu_codec("share"), Some("h264"));
    }

    #[test]
    fn recipes_and_output_names() {
        assert_eq!(recipe("gif").unwrap().id, "gif");
        assert_eq!(recipe("share").unwrap().id, "share");
        assert!(recipe("mp4").is_none());
        assert_eq!(output_name(Path::new("C:\\v\\clip.mov"), "share"), "clip (small).mp4");
        assert_eq!(output_name(Path::new("/v/clip.v2.mp4"), "gif"), "clip.v2.gif");
        assert_eq!(output_name(Path::new("/v/song.wav"), "mp3"), "song.mp3");
        assert!(convert_quick(vec!["/nope/a.mp4".into()], "zip".into()).is_err());
    }

    /// Needs ffmpeg (downloaded by the app, or on PATH):
    /// `cargo test -p pod --lib convert -- --ignored`
    #[test]
    #[ignore]
    fn converts_real_files_with_ffmpeg() {
        let Some((ffmpeg, _)) = locate("") else { panic!("no ffmpeg found") };
        let dir = std::env::temp_dir().join(format!("pod-convert-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=24"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(status.success());

        let state = RunState::default();
        for target in ["gif", "mp3", "webm", "mkv", "mp4", "share"] {
            // Claimed first, as run_job does: ffmpeg (-y) writes into the empty file.
            let out = claim_output(&dir, &output_name(&clip, target), &state).unwrap();
            let mut last = 0.0;
            let result = run_one(&ffmpeg, &clip, &out, target, None, &state, |f| last = f);
            assert!(result.is_ok(), "{target}: {}", match result { Err(RunError::Failed(e)) => e, _ => "cancelled".into() });
            assert!(out.metadata().unwrap().len() > 0, "{target}");
            assert_eq!(last, 1.0, "{target}");
        }
        // mp4 → mp4 never overwrites the original.
        assert!(dir.join("clip (2).mp4").is_file());
        assert!(dir.join("clip (small).mp4").is_file());

        let frame = dir.join("frame.png");
        let mp4 = dir.join("clip.mp4");
        run_one(&ffmpeg, &mp4, &frame, "png", None, &state, |_| {}).ok().unwrap();
        for target in ["jpg", "webp", "bmp", "tiff"] {
            let out = dir.join(format!("frame.{target}"));
            assert!(run_one(&ffmpeg, &frame, &out, target, None, &state, |_| {}).is_ok(), "{target}");
            assert!(out.is_file(), "{target}");
        }

        // A failure deletes nothing it didn't write and reports a message.
        let bogus = dir.join("bogus.mp4");
        std::fs::write(&bogus, b"not a video").unwrap();
        let out = dir.join("bogus.gif");
        match run_one(&ffmpeg, &bogus, &out, "gif", None, &state, |_| {}) {
            Err(RunError::Failed(message)) => assert!(message.contains("bogus.mp4"), "{message}"),
            _ => panic!("expected a failure"),
        }
        assert!(!out.exists());

        // Cancelled before it starts.
        let cancelled = RunState::default();
        cancelled.cancelled.store(true, Ordering::SeqCst);
        assert!(matches!(run_one(&ffmpeg, &clip, &dir.join("x.gif"), "gif", None, &cancelled, |_| {}), Err(RunError::Cancelled)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Downloads the real ffmpeg (~115 MB) into local_dir()/bin, as the app does:
    /// `cargo test -p pod --lib convert::tests::downloads_ffmpeg -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn downloads_ffmpeg() {
        let mut calls = 0u32;
        let got = tauri::async_runtime::block_on(download_ffmpeg_with(|_, total| {
            calls += 1;
            assert!(total > 0);
        }))
        .unwrap();
        assert!(got > 10_000_000 && calls > 1);
        assert!(is_ffmpeg(&downloaded_path(), VERSION_TIMEOUT));
        assert!(!bin_dir().join("ffmpeg-download.zip.part").exists());
        assert_eq!(locate("").unwrap().1, "downloaded");
    }
}
