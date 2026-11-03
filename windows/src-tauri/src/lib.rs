// Pod for Windows — app wiring and the commands the island calls.

mod archive;
mod capture;
mod checksum;
mod clipboard;
mod calendar;
mod convert;
mod cover;
mod downloads;
mod desktop;
mod devservers;
mod files;
mod i18n;
mod island;
mod log;
mod media;
mod metaclean;
mod net;
mod ocr;
mod pdf;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod privacy;
mod quicknote;
mod reminders;
mod rename;
mod resize;
mod settings;
mod shelf;
mod shortcuts;
mod sounds;
mod sysglance;
mod tray;
mod update;
#[cfg(windows)]
mod webview_drop;
mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use files::DroppedFile;
use island::{PollGate, ScreenInfo};
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (settings, screen_changed, autostart_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // Where Mochi sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_mochi = current.desktop_mochi.clone();
        // Moving the workspace moves its files, and ffmpeg is picked natively:
        // their own commands set them (workspace.rs, convert.rs).
        settings.workspace_dir = current.workspace_dir.clone();
        settings.ffmpeg_path = current.ffmpeg_path.clone();
        *current = settings;
        (current.clone(), screen_changed, autostart_changed, shortcuts_changed)
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[pod] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window(HUB_LABEL) {
        let _ = window.set_title("Pod");
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    // Park the poll before anything else: no tick may decide click-through for
    // the wake strip from the panel's geometry.
    if collapsed {
        shared.gate.set_active(false);
    }
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    if !collapsed {
        shared.gate.set_active(true);
    }
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// The panel is laid out in CSS px against the window's own scale. If the webview
/// reports a different devicePixelRatio (it ends up bigger than the window and gets
/// cut), correct its zoom so one CSS px is one logical px again.
#[tauri::command]
fn fit_zoom(app: AppHandle, dpr: f64) -> bool {
    let Some(win) = island::window(&app) else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    static ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);
    let mut zoom = ZOOM.lock().unwrap();
    if let Some(new_zoom) = island::calculate_zoom_correction(*zoom, scale, dpr) {
        *zoom = new_zoom;
        log::line(format!("webview dpr {dpr} != window scale {scale} — setting zoom {new_zoom:.3}"));
        let _ = win.set_zoom(new_zoom);
        true
    } else {
        false
    }
}


/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    update::PAUSED.store(paused, Ordering::Relaxed);
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The Pod window (every setting of the island), labelled "settings" since
/// it grew out of the settings window.
pub const HUB_LABEL: &str = "settings";

/// The Pod window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, HUB_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Pod")
        .inner_size(1100.0, 720.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let this = win.clone();
            win.on_window_event(move |event| match event {
                // Closing it must only hide it, or it could never be reopened.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = this.hide();
                    set_hub_shown(&this, false);
                }
                // Minimised (a 0×0 resize on Windows) or back from it.
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) => {
                    let on = this.is_visible().unwrap_or(false) && !this.is_minimized().unwrap_or(false);
                    set_hub_shown(&this, on);
                }
                _ => {}
            });
        }
        Err(err) => log::line(format!("Pod window failed: {err}")),
    }
}

/// Whether the Pod window is on screen (shown and not minimised). Its page
/// animates its canvases only then (hub/hero.ts): WebKitGTK can keep
/// `document.visibilityState` at "visible" for a hidden window, and its
/// animation loop then kept a core busy with the window closed (#792).
static HUB_SHOWN: AtomicBool = AtomicBool::new(false);

fn set_hub_shown(win: &tauri::WebviewWindow, shown: bool) {
    if HUB_SHOWN.swap(shown, Ordering::Relaxed) != shown {
        let _ = win.emit_to(HUB_LABEL, "hub-visible", shown);
    }
}

/// The page asks once at load, in case it missed the event.
#[tauri::command]
fn hub_shown() -> bool {
    HUB_SHOWN.load(Ordering::Relaxed)
}

pub fn show_settings_window(app: &AppHandle) {
    show_hub(app, Some("general"));
}

/// Shows the Pod window, on `page` when given ("general", "shortcuts"…).
pub fn show_hub(app: &AppHandle, page: Option<&str>) {
    let Some(win) = app.get_webview_window(HUB_LABEL) else {
        // Creating it at startup can fail on some machines (WebView2
        // 0x80070578, #775): try again now, on the main thread, where
        // window creation can't deadlock a command.
        log::line("Pod window missing, creating it again");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            create_settings_window(&handle);
            if let Some(win) = handle.get_webview_window(HUB_LABEL) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        });
        return;
    };
    if let Some(page) = page {
        let _ = win.emit("hub-page", page.to_string());
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    set_hub_shown(&win, true);
}

/// The argument the login item starts Pod with.
const AUTOSTART_ARG: &str = "--autostart";

#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_hub(&app, Some(page.as_deref().unwrap_or("general")));
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `pod --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                // Opening Pod again (its shortcut, the Start menu) shows its window.
                None => show_hub(app, None),
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        // Native folder and file pickers for the workspace and ffmpeg (workspace.rs, convert.rs).
        .plugin(tauri_plugin_dialog::init());
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(shortcuts::Registry::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fit_zoom,
            hub_shown,
            list_monitors,
            open_url,
            quit_app,
            log_line,
            ingest_file,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            desktop::desktop_mochi_info,
            desktop::desktop_mochi_pick_up,
            desktop::desktop_mochi_carry,
            desktop::desktop_mochi_carry_end,
            desktop::desktop_mochi_drag_begin,
            desktop::desktop_mochi_drag_move,
            desktop::desktop_mochi_drag_end,
            desktop::desktop_mochi_fly_out,
            desktop::desktop_mochi_fly_home,
            desktop::desktop_mochi_set_asleep,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
            update::update_status,
            update::update_set_consent,
            update::update_set_auto_install,
            files::drop_save,
            update::update_check,
            update::update_shown,
            update::update_show,
            update::update_later,
            tray::tray_update_hint,
            update::update_dismiss,
            update::update_install,
            update::update_open_page,
            workspace::workspace_info,
            workspace::workspace_move_in,
            workspace::workspace_change,
            workspace::workspace_open,
            convert::convert_prepare,
            convert::convert_quick,
            convert::convert_start,
            convert::convert_cancel,
            convert::ffmpeg_status,
            convert::ffmpeg_download,
            convert::ffmpeg_choose,
            convert::reveal_output,
            archive::archive_run,
            shelf::shelf_list,
            shelf::shelf_drag,
            shelf::shelf_remove,
            shelf::shelf_open,
            shelf::shelf_thumb,
            shelf::shelf_add,
            cover::notch_covered,
            resize::resize_run,
            pdf::pdf_run,
            ocr::ocr_run,
            checksum::hash_new_job,
            checksum::hash_run,
            checksum::hash_cancel,
            metaclean::clean_run,
            rename::rename_prepare,
            rename::rename_preview,
            rename::rename_apply,
            rename::rename_undo,
            capture::capture_to_shelf,
            quicknote::note_save,
            quicknote::note_read,
            clipboard::clipboard_text,
            clipboard::clipboard_set_text,
            devservers::devservers_watch,
            devservers::devservers_now,
            devservers::devserver_open,
            media::media_watch,
            media::media_now,
            media::media_control,
            sysglance::glance_watch,
            privacy::privacy_watch,
            privacy::privacy_now,
            calendar::calendar_refresh,
            calendar::calendar_test,
            downloads::downloads_watch,
            downloads::download_to_shelf,
            reminders::reminders_list,
            reminders::reminder_parse,
            reminders::reminder_add,
            reminders::reminder_done,
            reminders::reminder_snooze,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // Same rule for Mochi's desktop window.
            desktop::setup(&handle);
            reminders::start(&handle);
            shelf::start(&handle);
            calendar::start(&handle);
            cover::start(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Pod {} started ---", env!("CARGO_PKG_VERSION")));
            shortcuts::apply(&handle, &loaded.shortcuts);
            // New versions: nothing goes to GitHub until the user agrees (update.rs).
            update::start(handle.clone());
            if loaded.autostart {
                // Login items written before 0.5 start Pod without --autostart:
                // writing it again adds it, so the window stays hidden at login.
                let _ = handle.autolaunch().enable();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pod")
        .run(|_app, event| {
            // Quitting (the tray, an update): no ffmpeg goes on without Pod.
            if let tauri::RunEvent::Exit = event {
                convert::shutdown();
            }
        });
}
