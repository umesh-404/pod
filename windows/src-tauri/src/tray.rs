// Notification-area icon: Open, Wardrobe, Settings, Pause, Quit.
// "Update Pod to X…" shows under Open only while a new version is out
// (update.rs). While one waits, the tray Stew turns blue like the island's.
// The tray has its own drawings (icons/tray/), simpler than the app icon.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t, tf};
use crate::island::WINDOW_LABEL;

/// The menu's items, id and English label, in order. The labels are shown in
/// the interface language (i18n.rs) and follow it when it changes.
const ITEMS: [(&str, &str); 5] = [
    ("open", n_("Open Pod")),
    ("wardrobe", n_("Wardrobe…")),
    ("settings", n_("Settings…")),
    ("pause", n_("Pause")),
    ("quit", n_("Quit")),
];

/// Kept so a language change relabels the menu without rebuilding the tray.
struct Items(Vec<(&'static str, MenuItem<Wry>)>);

/// "Update Pod to X…": in the menu only while `version` is set.
struct UpdateItem {
    menu: Menu<Wry>,
    item: MenuItem<Wry>,
    version: Mutex<Option<String>>,
}

fn update_label(version: &str) -> String {
    tf("Update Pod to {version}…", &[("version", version)])
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items = Vec::new();
    for (id, label) in ITEMS {
        items.push((label, MenuItem::with_id(app, id, t(label), true, None::<&str>)?));
    }
    let [open, wardrobe, settings, pause, quit] = [0, 1, 2, 3, 4].map(|i| &items[i].1);
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[open, &sep1, wardrobe, settings, pause, &sep2, quit])?;
    app.manage(Items(items));
    // Its click goes to the island like the others (id "update"): it opens the update card.
    let update = MenuItem::with_id(app, "update", "", true, None::<&str>)?;
    app.manage(UpdateItem { menu: menu.clone(), item: update, version: Mutex::new(None) });

    let mut builder = TrayIconBuilder::with_id("pod")
        .tooltip("Pod")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            // The Pod window: every setting.
            "open" => crate::show_hub(app, None),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = tray_icon(false).or_else(|| app.default_window_icon().cloned()) {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Relabels the menu in the current language.
pub fn retitle(app: &AppHandle) {
    let Some(items) = app.try_state::<Items>() else { return };
    for (label, item) in &items.0 {
        let _ = item.set_text(t(label));
    }
    if let Some(update) = app.try_state::<UpdateItem>() {
        // Copied out first: the menu calls wait for the main thread, never under the lock.
        let version = update.version.lock().unwrap().clone();
        if let Some(version) = version {
            let _ = update.item.set_text(update_label(&version));
        }
    }
}

/// Shows "Update Pod to `version`…" right under Open, or takes it out (None).
pub fn set_update(app: &AppHandle, version: Option<&str>) {
    let Some(update) = app.try_state::<UpdateItem>() else { return };
    let was_shown = {
        let mut shown = update.version.lock().unwrap();
        if shown.as_deref() == version {
            return;
        }
        let was = shown.is_some();
        *shown = version.map(str::to_string);
        was
    };
    match version {
        Some(v) => {
            let _ = update.item.set_text(update_label(v));
            if !was_shown {
                let _ = update.menu.insert(&update.item, 1);
            }
        }
        None => {
            let _ = update.menu.remove(&update.item);
        }
    }
}

/// Stew in the tray, drawn for each size the notification area asks for (100 to
/// 300 % scaling): (size, usual, blue while an update waits). The blue one is
/// Stew in Pod's update blue, #3B82F6, with the same shading.
/// Drawn from icons/source/tray*.svg by scripts/gen-icons.mjs (npm run icons).
const TRAY: [(u32, &[u8], &[u8]); 6] = [
    (16, include_bytes!("../icons/tray/tray-16.png"), include_bytes!("../icons/tray/tray-16-update.png")),
    (20, include_bytes!("../icons/tray/tray-20.png"), include_bytes!("../icons/tray/tray-20-update.png")),
    (24, include_bytes!("../icons/tray/tray-24.png"), include_bytes!("../icons/tray/tray-24-update.png")),
    (32, include_bytes!("../icons/tray/tray-32.png"), include_bytes!("../icons/tray/tray-32-update.png")),
    (40, include_bytes!("../icons/tray/tray-40.png"), include_bytes!("../icons/tray/tray-40-update.png")),
    (48, include_bytes!("../icons/tray/tray-48.png"), include_bytes!("../icons/tray/tray-48-update.png")),
];

/// The small-icon size the notification area draws at (16 px at 100 %).
#[cfg(windows)]
fn tray_px() -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON};
    match unsafe { GetSystemMetrics(SM_CXSMICON) } {
        n if n > 0 => n as u32,
        _ => 16,
    }
}

/// Linux panels scale the icon themselves: give them a sharp one to shrink.
#[cfg(not(windows))]
fn tray_px() -> u32 {
    48
}

/// The drawing made for `px` or the next size up, so it is never stretched.
fn tray_png(px: u32, update: bool) -> &'static [u8] {
    let (_, usual, blue) = TRAY.iter().find(|(s, _, _)| *s >= px).unwrap_or(&TRAY[TRAY.len() - 1]);
    if update { blue } else { usual }
}

fn tray_icon(update: bool) -> Option<Image<'static>> {
    let png = tray_png(tray_px(), update);
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Some(Image::new_owned(img.into_raw(), w, h))
}

/// The island says whether a new version waits (consent, newer, not put off with
/// Later): blue Stew in the tray, or the usual one.
#[tauri::command]
pub fn tray_update_hint(app: AppHandle, on: bool) {
    let Some(tray) = app.tray_by_id("pod") else { return };
    let Some(icon) = tray_icon(on) else { return };
    let _ = tray.set_icon(Some(icon));
}

#[cfg(test)]
mod tests {
    use super::{tray_png, TRAY};

    #[test]
    fn every_tray_drawing_decodes_at_its_size() {
        for (size, usual, blue) in TRAY {
            for png in [usual, blue] {
                let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).unwrap();
                assert_eq!((img.width(), img.height()), (size, size));
            }
        }
    }

    #[test]
    fn the_tray_takes_the_next_size_up() {
        assert!(tray_png(16, false) == TRAY[0].1);
        assert!(tray_png(18, true) == TRAY[1].2);
        assert!(tray_png(64, false) == TRAY[5].1);
    }
}
