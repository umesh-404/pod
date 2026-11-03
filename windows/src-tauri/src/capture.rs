// "Screenshot to shelf": opens the system's snipping overlay (Windows:
// `ms-screenclip:`; Linux: the portal's screenshot), waits for the picture and
// saves it into the workspace as "Screenshot 2026-11-03 14.05.12.png".
//
// Windows: the Snipping Tool's overlay puts the picture on the clipboard. The
// clipboard's change counter is noted before the overlay opens and read four
// times a second while it is up (60 s at most); the first new image is the one.
// Nothing runs once the capture is over.
//
// Linux: the XDG desktop portal (org.freedesktop.portal.Screenshot, GNOME, KDE,
// wlroots…) asks the user for the area and hands back a file; without a portal,
// gnome-screenshot or spectacle when one is installed.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::i18n::tf;
use crate::platform::LocalTime;

/// The longest a capture may wait for the user.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// What the page gets when the user closed the overlay or took too long.
const CANCELLED: &str = "cancelled";

/// Resolves with the new shelf item's name, Err("cancelled") when the user closed
/// the overlay or 60 s passed without a picture.
#[tauri::command]
pub async fn capture_to_shelf(app: AppHandle) -> Result<String, String> {
    let ws = crate::workspace::dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let dest = take(&ws)?;
        crate::log::line("capture: screenshot saved to the workspace".to_string());
        Ok(dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Screenshot 2026-11-03 14.05.12.png": dots, not colons, which Windows
/// refuses in names.
pub(crate) fn screenshot_name(now: &LocalTime) -> String {
    format!(
        "Screenshot {:04}-{:02}-{:02} {:02}.{:02}.{:02}.png",
        now.year, now.month, now.day, now.hour, now.minute, now.second
    )
}

/// Where the new screenshot goes: a free name in the workspace, which is
/// created when it isn't there yet.
fn destination(ws: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(ws).map_err(|e| save_error(&e.to_string()))?;
    Ok(crate::files::unique_path(ws, &screenshot_name(&crate::platform::local_time())))
}

fn save_error(error: &str) -> String {
    tf("Couldn't save the screenshot: {error}", &[("error", error)])
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn take(ws: &Path) -> Result<PathBuf, String> {
    use std::time::{Duration, Instant};

    use ::windows::core::w;
    use ::windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use ::windows::Win32::UI::Shell::ShellExecuteW;
    use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let mut seen = unsafe { GetClipboardSequenceNumber() };
    let opened = unsafe { ShellExecuteW(None, w!("open"), w!("ms-screenclip:"), None, None, SW_SHOWNORMAL) };
    // ShellExecute returns a value above 32 on success.
    if opened.0 as isize <= 32 {
        crate::log::line(format!("capture: ms-screenclip: did not open ({})", opened.0 as isize));
        return Err(crate::i18n::t("Couldn't open the screenshot tool."));
    }

    let deadline = Instant::now() + TIMEOUT;
    let mut clipboard = arboard::Clipboard::new().map_err(|e| save_error(&e.to_string()))?;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        let now = unsafe { GetClipboardSequenceNumber() };
        if now == seen {
            continue;
        }
        // Something new: a picture is the capture, anything else (text the
        // user copied meanwhile) is not, and the wait goes on.
        seen = now;
        let Ok(image) = clipboard.get_image() else { continue };
        let dest = destination(ws)?;
        save_png(&dest, image.width, image.height, image.bytes.into_owned())?;
        return Ok(dest);
    }
    Err(CANCELLED.to_string())
}

/// Writes RGBA pixels as a PNG at `dest`, removing anything half written.
#[cfg(windows)]
fn save_png(dest: &Path, width: usize, height: usize, mut rgba: Vec<u8>) -> Result<(), String> {
    opaque_if_blank_alpha(&mut rgba);
    let (w, h) = (u32::try_from(width).unwrap_or(0), u32::try_from(height).unwrap_or(0));
    let Some(img) = image::RgbaImage::from_raw(w, h, rgba) else {
        return Err(save_error("bad image data"));
    };
    img.save_with_format(dest, image::ImageFormat::Png).map_err(|e| {
        let _ = std::fs::remove_file(dest);
        save_error(&e.to_string())
    })
}

/// Some clipboard bitmaps come with every alpha byte at 0, which would make a
/// fully transparent PNG: such a picture is meant to be opaque.
#[cfg_attr(not(windows), allow(dead_code))]
fn opaque_if_blank_alpha(rgba: &mut [u8]) {
    if rgba.chunks_exact(4).all(|px| px[3] == 0) {
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
}

// ── Linux ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn take(ws: &Path) -> Result<PathBuf, String> {
    let picture = match portal::screenshot() {
        portal::Outcome::Saved(path) => path,
        portal::Outcome::Cancelled => return Err(CANCELLED.to_string()),
        portal::Outcome::Unavailable(why) => {
            crate::log::line(format!("capture: no screenshot portal ({why})"));
            return with_tool(ws);
        }
    };
    let dest = destination(ws)?;
    // The portal's file stays where the desktop put it (usually ~/Pictures):
    // it's the user's, so it is copied, never moved away or deleted.
    std::fs::copy(&picture, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&dest);
        save_error(&e.to_string())
    })?;
    Ok(dest)
}

/// No portal: gnome-screenshot or spectacle, writing straight into the workspace.
#[cfg(target_os = "linux")]
fn with_tool(ws: &Path) -> Result<PathBuf, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let dest = destination(ws)?;
    let target = dest.to_string_lossy().to_string();
    let (program, args): (&str, Vec<String>) = if which("gnome-screenshot") {
        ("gnome-screenshot", vec!["-a".into(), "-f".into(), target])
    } else if which("spectacle") {
        ("spectacle", vec!["-r".into(), "-b".into(), "-n".into(), "-o".into(), target])
    } else {
        return Err(crate::i18n::t("Screenshots aren't available on this system."));
    };
    let mut cmd = Command::new(program);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = crate::platform::no_console(&mut cmd)
        .spawn()
        .map_err(|_| crate::i18n::t("Couldn't open the screenshot tool."))?;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&dest);
                return Err(CANCELLED.to_string());
            }
        }
    }
    // The tools exit without a file when the user pressed Esc.
    match std::fs::metadata(&dest) {
        Ok(meta) if meta.len() > 0 => Ok(dest),
        _ => {
            let _ = std::fs::remove_file(&dest);
            Err(CANCELLED.to_string())
        }
    }
}

#[cfg(target_os = "linux")]
fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

/// The Screenshot portal: one call, then the Response signal on its Request.
#[cfg(target_os = "linux")]
mod portal {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use dbus::arg::{PropMap, Variant};
    use dbus::channel::{BusType, Channel};
    use dbus::message::MessageType;
    use dbus::Message;

    const DEST: &str = "org.freedesktop.portal.Desktop";
    const OBJECT: &str = "/org/freedesktop/portal/desktop";
    const IFACE: &str = "org.freedesktop.portal.Screenshot";
    const REQUEST: &str = "org.freedesktop.portal.Request";

    pub enum Outcome {
        Saved(PathBuf),
        Cancelled,
        Unavailable(String),
    }

    pub fn screenshot() -> Outcome {
        match run() {
            Ok(outcome) => outcome,
            Err(why) => Outcome::Unavailable(why),
        }
    }

    fn run() -> Result<Outcome, String> {
        let channel = Channel::get_private(BusType::Session).map_err(|e| format!("session bus: {e}"))?;
        let sender = channel.unique_name().ok_or("no unique name on the session bus")?.to_string();
        let token = format!("podshot{}", std::process::id());
        let expected = crate::portal::request_path(&sender, &token);

        let call = |msg: Message| {
            channel
                .send_with_reply_and_block(msg, Duration::from_secs(10))
                .map_err(|e| format!("{}: {}", e.name().unwrap_or("error"), e.message().unwrap_or("")))
        };
        let rule = format!("type='signal',sender='{DEST}',interface='{REQUEST}',member='Response'");
        call(
            Message::new_method_call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch")?
                .append1(rule),
        )?;

        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new(token)));
        options.insert("interactive".into(), Variant(Box::new(true)));
        options.insert("modal".into(), Variant(Box::new(true)));
        let reply = call(Message::new_method_call(DEST, OBJECT, IFACE, "Screenshot")?.append2("", options))?;
        // Older portals pick the request path themselves and say so here.
        let request = reply
            .read1::<dbus::Path>()
            .map(|p| (&*p).to_owned())
            .unwrap_or(expected);

        let deadline = Instant::now() + super::TIMEOUT;
        while Instant::now() < deadline {
            channel.read_write(Some(Duration::from_millis(500))).map_err(|_| "bus closed".to_string())?;
            while let Some(msg) = channel.pop_message() {
                if msg.msg_type() != MessageType::Signal
                    || msg.member().as_deref() != Some("Response")
                    || msg.path().as_deref() != Some(request.as_str())
                {
                    continue;
                }
                return Ok(match crate::portal::parse_response(&msg) {
                    Ok(results) => {
                        let uri = results.get("uri").and_then(|v| v.0.as_str()).unwrap_or("");
                        match file_path(uri) {
                            Some(path) => Outcome::Saved(path),
                            None => Outcome::Cancelled,
                        }
                    }
                    Err(_) => Outcome::Cancelled,
                });
            }
        }
        Ok(Outcome::Cancelled)
    }

    /// "file:///home/me/Pictures/Screenshot%20from%20….png" → the path.
    pub(super) fn file_path(uri: &str) -> Option<PathBuf> {
        let rest = uri.strip_prefix("file://")?;
        let bytes = rest.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(std::ffi::OsString::from_vec(out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_names_carry_the_local_time_to_the_second() {
        let now = LocalTime { year: 2026, month: 11, day: 3, hour: 14, minute: 5, second: 12 };
        assert_eq!(screenshot_name(&now), "Screenshot 2026-11-03 14.05.12.png");
        let midnight = LocalTime { year: 2027, month: 1, day: 9, hour: 0, minute: 0, second: 7 };
        assert_eq!(screenshot_name(&midnight), "Screenshot 2027-01-09 00.00.07.png");
    }

    #[test]
    fn a_blank_alpha_channel_becomes_opaque_and_real_alpha_is_kept() {
        let mut blank = vec![10, 20, 30, 0, 40, 50, 60, 0];
        opaque_if_blank_alpha(&mut blank);
        assert_eq!(blank, [10, 20, 30, 255, 40, 50, 60, 255]);
        let mut real = vec![10, 20, 30, 0, 40, 50, 60, 128];
        opaque_if_blank_alpha(&mut real);
        assert_eq!(real, [10, 20, 30, 0, 40, 50, 60, 128]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_uris_become_paths() {
        assert_eq!(
            portal::file_path("file:///home/me/Pictures/Screenshot%20from%202026.png"),
            Some(PathBuf::from("/home/me/Pictures/Screenshot from 2026.png"))
        );
        assert_eq!(portal::file_path("https://example.com/x.png"), None);
    }
}
