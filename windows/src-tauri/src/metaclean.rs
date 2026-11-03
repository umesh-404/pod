// "Remove location and EXIF": a clean copy of a JPEG, PNG or WebP picture,
// "photo (clean).jpg" in the workspace folder, without the metadata cameras and
// phones write into it (GPS position, camera, dates, editing software,
// comments). Lossless: the bytes of the image itself are copied as they are,
// only metadata segments and chunks are left out. The original is not touched.
//
//   * JPEG: APP1 (EXIF, XMP), APP13 (IPTC / Photoshop), COM and the other APPn
//     segments go; APP0 (JFIF), APP2 ICC_PROFILE (colours) and APP14 Adobe
//     (how the colours are coded) stay. Anything after the end-of-image marker
//     goes too (phones append preview images there, each with its own EXIF).
//     A turned photo keeps its orientation: a minimal EXIF with only that tag.
//   * PNG: eXIf, tEXt, iTXt (XMP lives there), zTXt and tIME go.
//   * WebP: the EXIF and "XMP " chunks go, the VP8X flags and RIFF size follow.
//
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
pub struct CleanReport {
    /// Full paths written.
    pub outputs: Vec<String>,
    pub failed: Vec<Failure>,
    /// How many of the outputs had metadata taken out (the others had none).
    pub cleaned: usize,
}

/// Larger pictures are not read into memory.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[tauri::command]
pub async fn clean_run(app: AppHandle, paths: Vec<String>) -> Result<CleanReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (inputs, failed) = crate::files::take_all_dropped(paths);
        let out = crate::workspace::output_dir(&app)?;
        Ok(run(&inputs, &out, failed))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn run(inputs: &[PathBuf], out: &Path, mut failed: Vec<Failure>) -> CleanReport {
    let _busy = crate::files::JobGuard::new();
    let mut outputs = Vec::new();
    let mut cleaned = 0;
    for input in inputs {
        match clean_one(input, out) {
            Ok((dest, removed)) => {
                if removed > 0 {
                    cleaned += 1;
                }
                outputs.push(dest.to_string_lossy().to_string());
            }
            Err(error) => failed.push(Failure { name: display_name(input), error }),
        }
    }
    if !outputs.is_empty() {
        crate::log::line(format!("metaclean: {} clean cop(ies), {cleaned} had metadata", outputs.len()));
    }
    CleanReport { outputs, failed, cleaned }
}

/// "photo.JPG" → "photo (clean).JPG".
pub(crate) fn output_name(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "image".into());
    match path.extension() {
        Some(ext) => format!("{stem} (clean).{}", ext.to_string_lossy()),
        None => format!("{stem} (clean)"),
    }
}

fn clean_one(path: &Path, out: &Path) -> Result<(PathBuf, usize), String> {
    let name = display_name(path);
    let unreadable = |e: &dyn std::fmt::Display| tf("Cannot read {path}: {error}", &[("path", &name), ("error", &e.to_string())]);
    let meta = fs::metadata(path).map_err(|e| unreadable(&e))?;
    if meta.is_dir() {
        return Err(tf("{name} isn't a JPEG, PNG or WebP picture.", &[("name", &name)]));
    }
    if meta.len() > MAX_BYTES {
        return Err(t("The image is too large."));
    }
    let data = fs::read(path).map_err(|e| unreadable(&e))?;
    let stripped = strip(&data).map_err(|e| match e {
        StripError::Unknown => tf("{name} isn't a JPEG, PNG or WebP picture.", &[("name", &name)]),
        StripError::Damaged => tf("{name} looks damaged, so it was left alone.", &[("name", &name)]),
    })?;
    let out_name = output_name(path);
    let (dest, mut file) = create_unique(out, &out_name).map_err(|e| cannot_write(&out_name, &e))?;
    if let Err(e) = file.write_all(&stripped.bytes).and_then(|_| file.flush()) {
        drop(file);
        let _ = fs::remove_file(&dest);
        return Err(cannot_write(&out_name, &e));
    }
    Ok((dest, stripped.removed))
}

// ── The byte-level part ─────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StripError {
    /// Not a JPEG, PNG or WebP.
    Unknown,
    /// One of them, but its structure doesn't hold together.
    Damaged,
}

#[derive(Debug)]
pub(crate) struct Stripped {
    pub bytes: Vec<u8>,
    /// Metadata segments or chunks left out.
    pub removed: usize,
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The picture without its metadata, by what its bytes say it is (not its name).
pub(crate) fn strip(data: &[u8]) -> Result<Stripped, StripError> {
    if data.starts_with(&[0xFF, 0xD8]) {
        strip_jpeg(data)
    } else if data.starts_with(PNG_SIGNATURE) {
        strip_png(data)
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        strip_webp(data)
    } else {
        Err(StripError::Unknown)
    }
}

fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

// ── JPEG ────────────────────────────────────────────────────────────────────

const EXIF_HEADER: &[u8] = b"Exif\0\0";

pub(crate) fn strip_jpeg(data: &[u8]) -> Result<Stripped, StripError> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return Err(StripError::Unknown);
    }
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&[0xFF, 0xD8]);
    // Where a minimal EXIF goes: after SOI, or after a JFIF APP0 that comes first.
    let mut exif_at = out.len();
    let mut orientation = None;
    let mut removed = 0;
    let mut seen_scan = false;
    let mut pos = 2;
    loop {
        if pos >= data.len() {
            // No end-of-image marker: keep what there is (a truncated file stays truncated).
            break;
        }
        if data[pos] != 0xFF {
            return Err(StripError::Damaged);
        }
        // Fill bytes before a marker.
        while pos < data.len() && data[pos] == 0xFF {
            pos += 1;
        }
        let Some(&marker) = data.get(pos) else { return Err(StripError::Damaged) };
        pos += 1;
        match marker {
            // End of image: anything after it (appended previews) is left out.
            0xD9 => {
                out.extend_from_slice(&[0xFF, 0xD9]);
                if pos < data.len() {
                    removed += 1;
                }
                break;
            }
            // Markers without a length.
            0xD0..=0xD7 | 0x01 => {
                out.extend_from_slice(&[0xFF, marker]);
                continue;
            }
            0x00 => return Err(StripError::Damaged),
            _ => {}
        }
        if pos + 2 > data.len() {
            return Err(StripError::Damaged);
        }
        let len = be16(&data[pos..]) as usize;
        if len < 2 || pos + len > data.len() {
            return Err(StripError::Damaged);
        }
        let payload = &data[pos + 2..pos + len];
        let segment = &data[pos - 2..pos + len];
        let keep = match marker {
            0xE0 => true,
            0xE1 => {
                if payload.starts_with(EXIF_HEADER) {
                    orientation = orientation.or_else(|| exif_orientation(&payload[EXIF_HEADER.len()..]));
                }
                false
            }
            0xE2 => payload.starts_with(b"ICC_PROFILE\0"),
            0xEE => payload.starts_with(b"Adobe"),
            0xE3..=0xEF | 0xFE => false,
            _ => true,
        };
        if keep {
            // The marker is written without its fill bytes.
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(&segment[2..]);
            if marker == 0xE0 && exif_at == 2 && out.len() == 4 + len {
                exif_at = out.len();
            }
        } else {
            removed += 1;
        }
        pos += len;
        if marker == 0xDA {
            seen_scan = true;
            // Entropy-coded data up to the next marker that isn't a stuffed
            // zero or a restart marker.
            let start = pos;
            let mut i = pos;
            while i + 1 < data.len() {
                if data[i] == 0xFF && data[i + 1] != 0x00 && !(0xD0..=0xD7).contains(&data[i + 1]) {
                    break;
                }
                i += 1;
            }
            if i + 1 >= data.len() {
                i = data.len();
            }
            out.extend_from_slice(&data[start..i]);
            pos = i;
        }
    }
    if !seen_scan {
        return Err(StripError::Damaged);
    }
    if let Some(o @ 2..=8) = orientation {
        let app1 = minimal_exif(o);
        out.splice(exif_at..exif_at, app1);
    }
    Ok(Stripped { bytes: out, removed })
}

/// The Orientation tag (0x0112) of IFD0 in a TIFF structure (the EXIF block
/// after "Exif\0\0"), when it is a valid 1…8.
pub(crate) fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    if tiff.len() < 8 {
        return None;
    }
    let big = match &tiff[0..2] {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if big { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        Some(if big { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for i in 0..count.min(512) {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry)? == 0x0112 {
            // SHORT, one value, left-justified in the value field.
            if u16_at(entry + 2)? != 3 {
                return None;
            }
            let value = u16_at(entry + 8)?;
            return (1..=8).contains(&value).then_some(value);
        }
    }
    None
}

/// An APP1 segment whose EXIF holds only Orientation = `orientation`.
pub(crate) fn minimal_exif(orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::with_capacity(26);
    tiff.extend_from_slice(b"MM\0\x2A");
    tiff.extend_from_slice(&8u32.to_be_bytes());
    tiff.extend_from_slice(&1u16.to_be_bytes());
    tiff.extend_from_slice(&0x0112u16.to_be_bytes());
    tiff.extend_from_slice(&3u16.to_be_bytes());
    tiff.extend_from_slice(&1u32.to_be_bytes());
    tiff.extend_from_slice(&orientation.to_be_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_be_bytes());
    let len = (2 + EXIF_HEADER.len() + tiff.len()) as u16;
    let mut app1 = vec![0xFF, 0xE1];
    app1.extend_from_slice(&len.to_be_bytes());
    app1.extend_from_slice(EXIF_HEADER);
    app1.extend_from_slice(&tiff);
    app1
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_DROPPED: &[&[u8; 4]] = &[b"eXIf", b"tEXt", b"iTXt", b"zTXt", b"tIME"];

pub(crate) fn strip_png(data: &[u8]) -> Result<Stripped, StripError> {
    if !data.starts_with(PNG_SIGNATURE) {
        return Err(StripError::Unknown);
    }
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(PNG_SIGNATURE);
    let mut removed = 0;
    let mut pos = PNG_SIGNATURE.len();
    loop {
        if pos + 12 > data.len() {
            return Err(StripError::Damaged);
        }
        let len = be32(&data[pos..]) as usize;
        let kind: &[u8] = &data[pos + 4..pos + 8];
        let end = pos.checked_add(12).and_then(|n| n.checked_add(len)).ok_or(StripError::Damaged)?;
        if end > data.len() {
            return Err(StripError::Damaged);
        }
        if PNG_DROPPED.iter().any(|k| k.as_slice() == kind) {
            removed += 1;
        } else {
            // Length, type, data and CRC as they were.
            out.extend_from_slice(&data[pos..end]);
        }
        pos = end;
        if kind == b"IEND" {
            if pos < data.len() {
                removed += 1;
            }
            break;
        }
    }
    Ok(Stripped { bytes: out, removed })
}

// ── WebP ────────────────────────────────────────────────────────────────────

const VP8X_EXIF: u8 = 0x08;
const VP8X_XMP: u8 = 0x04;

pub(crate) fn strip_webp(data: &[u8]) -> Result<Stripped, StripError> {
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return Err(StripError::Unknown);
    }
    let riff_end = (le32(&data[4..]) as usize).checked_add(8).ok_or(StripError::Damaged)?;
    if riff_end > data.len() || riff_end < 12 {
        return Err(StripError::Damaged);
    }
    let mut out = Vec::with_capacity(riff_end);
    out.extend_from_slice(&data[0..12]);
    let mut removed = 0;
    let mut vp8x_at = None;
    let mut pos = 12;
    while pos < riff_end {
        if pos + 8 > riff_end {
            return Err(StripError::Damaged);
        }
        let kind: &[u8] = &data[pos..pos + 4];
        let size = le32(&data[pos + 4..]) as usize;
        // Chunks are padded to an even size.
        let end = (pos + 8).checked_add(size).and_then(|n| n.checked_add(size & 1)).ok_or(StripError::Damaged)?;
        // A writer may leave the pad byte of the very last chunk out.
        let end = if end == riff_end + 1 && size & 1 == 1 { riff_end } else { end };
        if end > riff_end {
            return Err(StripError::Damaged);
        }
        if kind == b"EXIF" || kind == b"XMP " {
            removed += 1;
        } else {
            if kind == b"VP8X" {
                if size < 1 {
                    return Err(StripError::Damaged);
                }
                vp8x_at = Some(out.len() + 8);
            }
            out.extend_from_slice(&data[pos..end]);
        }
        pos = end;
    }
    if let Some(flags) = vp8x_at {
        out[flags] &= !(VP8X_EXIF | VP8X_XMP);
    }
    if riff_end < data.len() {
        removed += 1;
    }
    let riff_size = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(Stripped { bytes: out, removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Tiny JPEGs, built by hand ───────────────────────────────────────────

    fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut s = vec![0xFF, marker];
        s.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        s.extend_from_slice(payload);
        s
    }

    /// EXIF with Orientation and a GPS IFD pointer, little-endian like most phones.
    fn exif_payload(orientation: u16) -> Vec<u8> {
        let mut p = EXIF_HEADER.to_vec();
        p.extend_from_slice(b"II\x2A\0");
        p.extend_from_slice(&8u32.to_le_bytes());
        p.extend_from_slice(&2u16.to_le_bytes());
        // Orientation, SHORT, 1
        p.extend_from_slice(&0x0112u16.to_le_bytes());
        p.extend_from_slice(&3u16.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(&orientation.to_le_bytes());
        p.extend_from_slice(&[0, 0]);
        // GPSInfo, LONG, 1 → offset (points nowhere useful here)
        p.extend_from_slice(&0x8825u16.to_le_bytes());
        p.extend_from_slice(&4u16.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(&38u32.to_le_bytes());
        p.extend_from_slice(&0u32.to_le_bytes());
        p.extend_from_slice(b"GPS 48.8584 N 2.2945 E");
        p
    }

    const SCAN: &[u8] = &[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0x78];

    fn jpeg(parts: &[Vec<u8>], trailer: &[u8]) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        for p in parts {
            j.extend_from_slice(p);
        }
        j.extend_from_slice(&segment(0xDA, &[1, 1, 0, 0, 63, 0]));
        j.extend_from_slice(SCAN);
        j.extend_from_slice(&[0xFF, 0xD9]);
        j.extend_from_slice(trailer);
        j
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn jpeg_loses_exif_xmp_iptc_and_comments_but_keeps_jfif_icc_adobe_and_the_image() {
        let jfif = segment(0xE0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
        let exif = segment(0xE1, &exif_payload(1));
        let xmp = segment(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPSLatitude</x:xmpmeta>");
        let icc = segment(0xE2, b"ICC_PROFILE\0\x01\x01profile-bytes");
        let mpf = segment(0xE2, b"MPF\0secondary");
        let iptc = segment(0xED, b"Photoshop 3.0\08BIM-location");
        let adobe = segment(0xEE, b"Adobe\0\x64\0\0\0\0\x01");
        let comment = segment(0xFE, b"shot at home");
        let dqt = segment(0xDB, &[0; 65]);
        let sof = segment(0xC0, &[8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
        let dht = segment(0xC4, &[0; 20]);
        let parts = [jfif.clone(), exif, xmp, icc.clone(), mpf, iptc, adobe.clone(), comment, dqt.clone(), sof.clone(), dht.clone()];
        let data = jpeg(&parts, b"\xFF\xD8appended preview with Exif");
        let s = strip(&data).unwrap();
        // EXIF, XMP, MPF, IPTC, COM and the trailer.
        assert_eq!(s.removed, 6);
        let expected = jpeg(&[jfif, icc, adobe, dqt, sof, dht], b"");
        assert_eq!(s.bytes, expected);
        assert!(!contains(&s.bytes, b"GPS") && !contains(&s.bytes, b"Exif") && !contains(&s.bytes, b"home"));
        assert!(contains(&s.bytes, SCAN), "the entropy-coded data is copied as it is");
        // Already clean: the same bytes again, nothing removed.
        let again = strip(&s.bytes).unwrap();
        assert_eq!(again.bytes, s.bytes);
        assert_eq!(again.removed, 0);
    }

    #[test]
    fn a_turned_photo_keeps_only_its_orientation() {
        let jfif = segment(0xE0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
        let data = jpeg(&[jfif.clone(), segment(0xE1, &exif_payload(6))], b"");
        let s = strip_jpeg(&data).unwrap();
        assert!(!contains(&s.bytes, b"GPS"));
        // Right after JFIF, which must stay first.
        assert_eq!(&s.bytes[2..2 + jfif.len()], &jfif[..]);
        let app1 = &s.bytes[2 + jfif.len()..];
        assert_eq!(&app1[..2], &[0xFF, 0xE1]);
        let len = be16(&app1[2..]) as usize;
        assert_eq!(exif_orientation(&app1[4 + EXIF_HEADER.len()..2 + len]), Some(6));
        assert_eq!(minimal_exif(6).len(), 36);
        // Upright: no EXIF at all.
        let upright = strip_jpeg(&jpeg(&[segment(0xE1, &exif_payload(1))], b"")).unwrap();
        assert!(!contains(&upright.bytes, b"Exif"));
        // No JFIF: right after SOI.
        let bare = strip_jpeg(&jpeg(&[segment(0xE1, &exif_payload(8))], b"")).unwrap();
        assert_eq!(&bare.bytes[2..4], &[0xFF, 0xE1]);
    }

    #[test]
    fn exif_orientation_both_byte_orders() {
        assert_eq!(exif_orientation(&exif_payload(3)[6..]), Some(3));
        assert_eq!(exif_orientation(&minimal_exif(5)[10..]), Some(5));
        assert_eq!(exif_orientation(&exif_payload(9)[6..]), None, "out of range");
        assert_eq!(exif_orientation(b"XX\x2A\0\x08\0\0\0"), None);
        assert_eq!(exif_orientation(b"II"), None);
    }

    #[test]
    fn progressive_scans_and_fill_bytes() {
        let dht = segment(0xC4, &[0; 20]);
        let mut data = vec![0xFF, 0xD8];
        data.extend_from_slice(&segment(0xFE, b"note"));
        data.extend_from_slice(&segment(0xDA, &[1, 1, 0, 0, 63, 0]));
        data.extend_from_slice(&[1, 2, 0xFF, 0x00, 3]);
        // A table between scans, behind fill bytes.
        data.extend_from_slice(&[0xFF, 0xFF]);
        data.extend_from_slice(&dht);
        data.extend_from_slice(&segment(0xDA, &[1, 1, 0, 1, 63, 0]));
        data.extend_from_slice(&[4, 5, 0xFF, 0xD3, 6]);
        data.extend_from_slice(&[0xFF, 0xD9]);
        let s = strip_jpeg(&data).unwrap();
        assert_eq!(s.removed, 1);
        assert!(contains(&s.bytes, &[1, 2, 0xFF, 0x00, 3]));
        assert!(contains(&s.bytes, &dht));
        assert!(contains(&s.bytes, &[4, 5, 0xFF, 0xD3, 6, 0xFF, 0xD9]));
    }

    #[test]
    fn broken_jpegs_are_refused() {
        assert_eq!(strip_jpeg(b"\xFF\xD8\xFF\xE1\x00").unwrap_err(), StripError::Damaged);
        assert_eq!(strip_jpeg(b"\xFF\xD8\xFF\xE1\x00\x40abc").unwrap_err(), StripError::Damaged);
        assert_eq!(strip_jpeg(b"\xFF\xD8\x12\x34").unwrap_err(), StripError::Damaged);
        // Headers only, no image data.
        assert_eq!(strip_jpeg(b"\xFF\xD8\xFF\xD9").unwrap_err(), StripError::Damaged);
        assert_eq!(strip(b"GIF89a....").unwrap_err(), StripError::Unknown);
    }

    #[test]
    fn a_real_encoded_jpeg_still_decodes_the_same() {
        use image::{ImageFormat, Rgb, RgbImage};
        let img = RgbImage::from_fn(33, 17, |x, y| Rgb([(x * 7) as u8, (y * 13) as u8, 90]));
        let mut plain = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut plain), ImageFormat::Jpeg).unwrap();
        // Put an EXIF block and a comment in after SOI.
        let mut data = plain[..2].to_vec();
        data.extend_from_slice(&segment(0xE1, &exif_payload(1)));
        data.extend_from_slice(&segment(0xFE, b"secret"));
        data.extend_from_slice(&plain[2..]);
        let s = strip(&data).unwrap();
        assert_eq!(s.removed, 2);
        assert_eq!(s.bytes, plain);
        let a = image::load_from_memory(&plain).unwrap().to_rgb8();
        let b = image::load_from_memory(&s.bytes).unwrap().to_rgb8();
        assert_eq!(a, b);
    }

    // ── PNG ─────────────────────────────────────────────────────────────────

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(data);
        // The CRC is copied, never checked: any four bytes do here.
        c.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        c
    }

    #[test]
    fn png_loses_text_time_and_exif_but_keeps_everything_else() {
        let ihdr = chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
        let iccp = chunk(b"iCCP", b"icc\0\0zz");
        let phys = chunk(b"pHYs", &[0; 9]);
        let idat = chunk(b"IDAT", b"compressed pixels");
        let iend = chunk(b"IEND", b"");
        let mut data = PNG_SIGNATURE.to_vec();
        for c in [
            ihdr.clone(),
            chunk(b"eXIf", b"MM\0*GPS"),
            iccp.clone(),
            chunk(b"tEXt", b"Author\0me"),
            chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"),
            chunk(b"zTXt", b"Comment\0\0zz"),
            chunk(b"tIME", &[7, 234, 11, 3, 12, 0, 0]),
            phys.clone(),
            idat.clone(),
            iend.clone(),
        ] {
            data.extend_from_slice(&c);
        }
        data.extend_from_slice(b"trailing junk");
        let s = strip(&data).unwrap();
        assert_eq!(s.removed, 6);
        let mut expected = PNG_SIGNATURE.to_vec();
        for c in [ihdr, iccp, phys, idat, iend] {
            expected.extend_from_slice(&c);
        }
        assert_eq!(s.bytes, expected);
        assert_eq!(strip_png(&s.bytes).unwrap().removed, 0);
    }

    #[test]
    fn a_real_png_still_decodes_the_same() {
        use image::{ImageFormat, Rgba, RgbaImage};
        let img = RgbaImage::from_fn(9, 5, |x, y| Rgba([x as u8 * 20, y as u8 * 40, 7, 200]));
        let mut plain = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut plain), ImageFormat::Png).unwrap();
        // A tEXt chunk after IHDR (8 + 25 bytes in).
        let mut data = plain[..33].to_vec();
        data.extend_from_slice(&chunk(b"tEXt", b"GPS\0here"));
        data.extend_from_slice(&plain[33..]);
        let s = strip(&data).unwrap();
        assert_eq!(s.bytes, plain);
        assert_eq!(image::load_from_memory(&s.bytes).unwrap().to_rgba8(), img);
    }

    #[test]
    fn broken_pngs_are_refused() {
        let mut data = PNG_SIGNATURE.to_vec();
        data.extend_from_slice(&chunk(b"IHDR", &[0; 13]));
        assert_eq!(strip_png(&data).unwrap_err(), StripError::Damaged, "no IEND");
        let mut big = PNG_SIGNATURE.to_vec();
        big.extend_from_slice(&u32::MAX.to_be_bytes());
        big.extend_from_slice(b"IDAT\0\0\0\0");
        assert_eq!(strip_png(&big).unwrap_err(), StripError::Damaged);
    }

    // ── WebP ────────────────────────────────────────────────────────────────

    fn riff_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = kind.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    }

    fn webp(chunks: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = chunks.concat();
        let mut w = b"RIFF".to_vec();
        w.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        w.extend_from_slice(b"WEBP");
        w.extend_from_slice(&body);
        w
    }

    #[test]
    fn webp_loses_exif_and_xmp_and_its_header_follows() {
        // ICC | Alpha | EXIF | XMP
        let flags = 0x20 | 0x10 | VP8X_EXIF | VP8X_XMP;
        let vp8x = riff_chunk(b"VP8X", &[flags, 0, 0, 0, 9, 0, 0, 4, 0, 0]);
        let iccp = riff_chunk(b"ICCP", b"icc");
        let alph = riff_chunk(b"ALPH", b"alpha");
        let vp8 = riff_chunk(b"VP8 ", b"frame-bytes");
        let data = webp(&[vp8x, iccp.clone(), alph.clone(), vp8.clone(), riff_chunk(b"EXIF", b"MM\0*GPS!"), riff_chunk(b"XMP ", b"<x/>")]);
        let s = strip(&data).unwrap();
        assert_eq!(s.removed, 2);
        let clean_vp8x = riff_chunk(b"VP8X", &[0x20 | 0x10, 0, 0, 0, 9, 0, 0, 4, 0, 0]);
        assert_eq!(s.bytes, webp(&[clean_vp8x, iccp, alph, vp8]));
        assert_eq!(le32(&s.bytes[4..]) as usize, s.bytes.len() - 8);
        assert!(!contains(&s.bytes, b"GPS"));
        assert_eq!(strip_webp(&s.bytes).unwrap().removed, 0);
    }

    #[test]
    fn a_simple_webp_is_copied_and_broken_ones_refused() {
        let simple = webp(&[riff_chunk(b"VP8L", b"lossless")]);
        let s = strip(&simple).unwrap();
        assert_eq!((s.bytes, s.removed), (simple, 0));
        let mut short = webp(&[riff_chunk(b"VP8 ", b"frame")]);
        short.truncate(short.len() - 3);
        assert_eq!(strip_webp(&short).unwrap_err(), StripError::Damaged);
        let mut lying = webp(&[riff_chunk(b"VP8 ", b"ab")]);
        lying[16..20].copy_from_slice(&1000u32.to_le_bytes());
        assert_eq!(strip_webp(&lying).unwrap_err(), StripError::Damaged);
    }

    #[test]
    fn writes_a_clean_copy_in_the_workspace_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("pod-clean-test-{}", std::process::id()));
        let ws = dir.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let src = dir.join("photo.jpg");
        let data = jpeg(&[segment(0xE1, &exif_payload(1))], b"");
        fs::write(&src, &data).unwrap();
        fs::write(ws.join("photo (clean).jpg"), b"taken").unwrap();
        let text = dir.join("notes.txt");
        fs::write(&text, b"hello").unwrap();

        let report = run(&[src.clone(), text], &ws, Vec::new());
        assert_eq!(report.outputs.len(), 1);
        assert_eq!(report.failed.len(), 1, "a .txt isn't a picture");
        assert_eq!(report.cleaned, 1);
        let out = PathBuf::from(&report.outputs[0]);
        assert_eq!(display_name(&out), "photo (clean) (2).jpg");
        assert_eq!(out.parent().unwrap(), ws.as_path());
        assert_eq!(fs::read(ws.join("photo (clean).jpg")).unwrap(), b"taken");
        assert_eq!(fs::read(&src).unwrap(), data, "the original is untouched");
        assert!(!contains(&fs::read(&out).unwrap(), b"GPS"));
        assert_eq!(output_name(Path::new("/p/Shot.v2.PNG")), "Shot.v2 (clean).PNG");
        fs::remove_dir_all(&dir).unwrap();
    }
}
