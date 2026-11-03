// Now playing, for the notch's right side: whatever the system media controls
// report (Spotify, a browser tab, VLC…), with play/pause and skip.
//
// Windows: the system media transport controls (the overlay the media keys
// show). While watched, one thread sleeps on a channel and wakes only for the
// session manager's CurrentSessionChanged / SessionsChanged and the current
// session's MediaPropertiesChanged / PlaybackInfoChanged; it reads the session
// and emits `media` when the payload differs from the last one. Off: handlers
// removed, thread gone.
//
// Linux: MPRIS on the session bus — one thread blocked on the bus, woken by
// PropertiesChanged on /org/mpris/MediaPlayer2 and players appearing or
// leaving; the playing player wins, else a paused one.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const EVENT: &str = "media";
/// Covers are shown this big at most (2× the notch's 48 px).
const ART_SIZE: u32 = 96;
/// The biggest thumbnail read.
const ART_LIMIT: u64 = 4 * 1024 * 1024;

/// Also emitted as the `media` event (null payload when nothing is playing or paused).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    /// The app the session belongs to, readable ("Spotify", "Microsoft Edge"…), may be "".
    pub app: String,
    pub playing: bool,
    /// Small cover as a `data:image/…;base64,` URL, None when the app gives none.
    pub art: Option<String>,
}

/// The last payload sent while watching; `None` = not watching (nothing cached).
static LAST: Mutex<Option<Option<NowPlaying>>> = Mutex::new(None);
/// Covers made, by track key; the newest last.
static ART: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());

/// Emits `media` unless it is the same as the last one sent.
fn publish(app: &AppHandle, now: Option<NowPlaying>) {
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(&now) {
            return;
        }
        *last = Some(now.clone());
    }
    let _ = app.emit(EVENT, now);
}

fn track_key(app: &str, title: &str, artist: &str, album: &str) -> String {
    format!("{app}\u{1f}{title}\u{1f}{artist}\u{1f}{album}")
}

fn cached_art(key: &str) -> Option<String> {
    ART.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| k == key).map(|(_, d)| d.clone())
}

fn cache_art(key: String, data: String) {
    let mut art = ART.lock().unwrap_or_else(|e| e.into_inner());
    art.retain(|(k, _)| *k != key);
    art.push_back((key, data));
    while art.len() > 8 {
        art.pop_front();
    }
}

/// Any image → a cover at most ART_SIZE px, as a JPEG data URL.
pub fn cover_data_url(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = if img.width() > ART_SIZE || img.height() > ART_SIZE { img.thumbnail(ART_SIZE, ART_SIZE) } else { img };
    let rgb = small.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&rgb).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&out)))
}

pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ABC[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A session's AppUserModelId (Windows) or MPRIS bus name → a readable name.
pub fn app_name(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    const KNOWN: [(&str, &str); 22] = [
        ("spotify", "Spotify"),
        ("msedge", "Microsoft Edge"),
        ("microsoftedge", "Microsoft Edge"),
        ("chrome", "Chrome"),
        ("chromium", "Chromium"),
        // Firefox registers under a hash of its install folder.
        ("308046b0af4a39cb", "Firefox"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Films & TV"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("vlc", "VLC"),
        ("foobar2000", "foobar2000"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
        ("amazonmusic", "Amazon Music"),
        ("discord", "Discord"),
        ("rhythmbox", "Rhythmbox"),
        ("mpv", "mpv"),
    ];
    if let Some((_, name)) = KNOWN.iter().find(|(k, _)| lower.contains(k)) {
        return name.to_string();
    }
    // "Publisher.App_hash!Entry" / "org.mpris.MediaPlayer2.app.instance123" / "app.exe"
    let id = id.strip_prefix("org.mpris.MediaPlayer2.").unwrap_or(id);
    let id = id.split('!').next().unwrap_or(id);
    let id = id.split('_').next().unwrap_or(id);
    let id = id.strip_suffix(".exe").or_else(|| id.strip_suffix(".EXE")).unwrap_or(id);
    let part = id.split('.').filter(|p| !p.is_empty() && !p.starts_with("instance")).next_back().unwrap_or(id);
    let mut chars = part.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Starts/stops following the current media session; `media` events are sent while on.
#[tauri::command]
pub fn media_watch(app: AppHandle, on: bool) {
    platform::watch(app, on);
}

#[tauri::command]
pub fn media_now() -> Option<NowPlaying> {
    if let Some(last) = LAST.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return last;
    }
    platform::read_once()
}

/// "playpause" | "next" | "previous"
#[tauri::command]
pub fn media_control(action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "playpause" | "next" | "previous") {
        return Err(format!("unknown media action: {action}"));
    }
    if platform::control(&action) {
        Ok(())
    } else {
        Err(crate::i18n::t("The player didn't respond."))
    }
}

/// Runs `f` on a short-lived MTA thread: WinRT calls block on their result, and
/// sync commands arrive on the UI thread.
#[cfg(windows)]
fn off_ui_thread<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    std::thread::Builder::new().name("pod-media-call".into()).spawn(f).ok()?.join().ok()
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::mpsc::{self, Receiver, Sender};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    enum Wake {
        Changed,
        Sessions,
        Stop,
    }

    static WAKE: Mutex<Option<Sender<Wake>>> = Mutex::new(None);

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn watch(app: AppHandle, on: bool) {
        let mut wake = WAKE.lock().unwrap_or_else(|e| e.into_inner());
        if !on {
            if let Some(tx) = wake.take() {
                let _ = tx.send(Wake::Stop);
            }
            *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return;
        }
        if wake.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let thread_tx = tx.clone();
        let spawned =
            std::thread::Builder::new().name("pod-media".into()).spawn(move || listen(app, thread_tx, rx));
        match spawned {
            Ok(_) => *wake = Some(tx),
            Err(err) => crate::log::line(format!("media: no listener thread: {err}")),
        }
    }

    fn listen(app: AppHandle, tx: Sender<Wake>, rx: Receiver<Wake>) {
        com();
        let manager = match Manager::RequestAsync().and_then(|op| op.get()) {
            Ok(m) => m,
            Err(err) => {
                crate::log::line(format!("media: no media sessions: {err}"));
                publish(&app, None);
                return;
            }
        };
        let current_token = manager.CurrentSessionChanged(&wake_on(&tx, true)).ok();
        let sessions_token = manager.SessionsChanged(&wake_on(&tx, true)).ok();

        let mut bound: Option<Bound> = None;
        let mut rebind = true;
        loop {
            if rebind {
                if let Some(b) = bound.take() {
                    b.unbind();
                }
                bound = manager.GetCurrentSession().ok().map(|s| Bound::bind(s, &tx));
                rebind = false;
            }
            publish(&app, bound.as_ref().and_then(|b| snapshot(&b.session).ok().flatten()));

            // Events come in bursts (a new track moves everything): one read for all.
            let mut stop = false;
            let Ok(first) = rx.recv() else { break };
            for wake in std::iter::once(first).chain(std::iter::from_fn(|| rx.try_recv().ok())) {
                match wake {
                    Wake::Changed => {}
                    Wake::Sessions => rebind = true,
                    Wake::Stop => stop = true,
                }
            }
            if stop {
                break;
            }
        }
        if let Some(b) = bound {
            b.unbind();
        }
        if let Some(t) = current_token {
            let _ = manager.RemoveCurrentSessionChanged(t);
        }
        if let Some(t) = sessions_token {
            let _ = manager.RemoveSessionsChanged(t);
        }
    }

    struct Bound {
        session: Session,
        media: Option<i64>,
        playback: Option<i64>,
    }

    impl Bound {
        fn bind(session: Session, tx: &Sender<Wake>) -> Bound {
            let media = session.MediaPropertiesChanged(&wake_on(tx, false)).ok();
            let playback = session.PlaybackInfoChanged(&wake_on(tx, false)).ok();
            Bound { session, media, playback }
        }

        fn unbind(self) {
            if let Some(t) = self.media {
                let _ = self.session.RemoveMediaPropertiesChanged(t);
            }
            if let Some(t) = self.playback {
                let _ = self.session.RemovePlaybackInfoChanged(t);
            }
        }
    }

    /// A handler that wakes the listener: `sessions` for the manager's events
    /// (bind the current session again), else for the session's.
    fn wake_on<S, A>(tx: &Sender<Wake>, sessions: bool) -> TypedEventHandler<S, A>
    where
        S: windows::core::RuntimeType + 'static,
        A: windows::core::RuntimeType + 'static,
    {
        let tx = tx.clone();
        TypedEventHandler::new(move |_, _| {
            let _ = tx.send(if sessions { Wake::Sessions } else { Wake::Changed });
            Ok(())
        })
    }

    fn snapshot(session: &Session) -> windows::core::Result<Option<NowPlaying>> {
        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title()?.to_string_lossy();
        let artist = props.Artist()?.to_string_lossy();
        if title.trim().is_empty() && artist.trim().is_empty() {
            return Ok(None);
        }
        let status = session.GetPlaybackInfo()?.PlaybackStatus()?;
        if status != Status::Playing && status != Status::Paused {
            return Ok(None);
        }
        let app = app_name(&session.SourceAppUserModelId().map(|s| s.to_string_lossy()).unwrap_or_default());
        let album = props.AlbumTitle().map(|s| s.to_string_lossy()).unwrap_or_default();
        let key = track_key(&app, &title, &artist, &album);
        let art = cached_art(&key).or_else(|| {
            // Some players add the thumbnail a moment after the title; the
            // next event tries again, so only a cover found is kept.
            let data = thumbnail(&props).as_deref().and_then(cover_data_url)?;
            cache_art(key, data.clone());
            Some(data)
        });
        Ok(Some(NowPlaying { title, artist, app, playing: status == Status::Playing, art }))
    }

    fn thumbnail(props: &MediaProperties) -> Option<Vec<u8>> {
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > ART_LIMIT {
            return None;
        }
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
        let mut bytes = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        Some(bytes)
    }

    fn current_session() -> Option<Session> {
        com();
        Manager::RequestAsync().and_then(|op| op.get()).ok()?.GetCurrentSession().ok()
    }

    pub fn read_once() -> Option<NowPlaying> {
        off_ui_thread(|| current_session().and_then(|s| snapshot(&s).ok().flatten())).flatten()
    }

    pub fn control(action: &str) -> bool {
        let action = action.to_string();
        off_ui_thread(move || {
            let Some(session) = current_session() else { return false };
            let op = match action.as_str() {
                "playpause" => session.TryTogglePlayPauseAsync(),
                "next" => session.TrySkipNextAsync(),
                _ => session.TrySkipPreviousAsync(),
            };
            op.and_then(|op| op.get()).unwrap_or(false)
        })
        .unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use dbus::arg::{ArgType, PropMap, RefArg};
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;
    use dbus::message::MessageType;
    use dbus::Message;
    use std::time::Duration;

    const PREFIX: &str = "org.mpris.MediaPlayer2.";
    const PATH: &str = "/org/mpris/MediaPlayer2";
    const ROOT: &str = "org.mpris.MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    const DBUS: &str = "org.freedesktop.DBus";
    const CALL: Duration = Duration::from_millis(1500);
    /// The listener sleeps on the bus; this only bounds a lost wake-up.
    const IDLE_WAIT: Duration = Duration::from_secs(3600);
    const RULES: [&str; 2] = [
        "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'",
        "type='signal',path='/org/mpris/MediaPlayer2',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'",
    ];

    struct Shared {
        generation: u64,
        active: bool,
        /// The listener's unique name, to wake it when it has to stop.
        listener: Option<String>,
        /// The player shown, for the controls.
        player: Option<String>,
    }

    static SHARED: Mutex<Shared> = Mutex::new(Shared { generation: 0, active: false, listener: None, player: None });
    static CONTROL: Mutex<Option<Connection>> = Mutex::new(None);

    fn shared() -> std::sync::MutexGuard<'static, Shared> {
        SHARED.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(generation: u64) -> bool {
        let s = shared();
        s.active && s.generation == generation
    }

    pub fn watch(app: AppHandle, on: bool) {
        let (generation, wake) = {
            let mut s = shared();
            if s.active == on {
                return;
            }
            s.active = on;
            s.generation += 1;
            (s.generation, s.listener.take())
        };
        if on {
            let spawned = std::thread::Builder::new().name("pod-media".into()).spawn(move || listen(app, generation));
            if let Err(err) = spawned {
                crate::log::line(format!("media: no listener thread: {err}"));
            }
        } else {
            *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if let Some(name) = wake {
                // Any message to its unique name gets the listener off the bus.
                if let Ok(mut msg) = Message::new_method_call(name, "/", "org.freedesktop.DBus.Peer", "Ping") {
                    msg.set_no_reply(true);
                    with_control(|c| {
                        let _ = c.channel().send(msg);
                        c.channel().flush();
                        Some(())
                    });
                }
            }
        }
    }

    fn listen(app: AppHandle, generation: u64) {
        let conn = match Connection::new_session() {
            Ok(c) => c,
            Err(err) => {
                crate::log::line(format!("media: no session bus: {err}"));
                return;
            }
        };
        {
            let mut s = shared();
            if !(s.active && s.generation == generation) {
                return;
            }
            s.listener = Some(conn.unique_name().to_string());
        }
        for rule in RULES {
            if let Err(err) = conn.add_match_no_cb(rule) {
                crate::log::line(format!("media: match refused: {err}"));
            }
        }
        emit_now(&app, &conn, generation);
        while current(generation) {
            match conn.channel().blocking_pop_message(IDLE_WAIT) {
                Ok(Some(msg)) => {
                    if msg.msg_type() == MessageType::Signal {
                        // Drain the burst, then read once.
                        while let Ok(Some(_)) = conn.channel().blocking_pop_message(Duration::ZERO) {}
                        if current(generation) {
                            emit_now(&app, &conn, generation);
                        }
                    }
                }
                Ok(None) => {}
                Err(err) => {
                    crate::log::line(format!("media: bus lost: {err}"));
                    break;
                }
            }
        }
    }

    fn emit_now(app: &AppHandle, conn: &Connection, generation: u64) {
        let (player, now) = read(conn);
        {
            let mut s = shared();
            if !(s.active && s.generation == generation) {
                return;
            }
            s.player = player;
        }
        publish(app, now);
    }

    /// A D-Bus value, flattened: text, texts, or nothing we need.
    fn text_of(arg: &dyn RefArg) -> Option<String> {
        match arg.arg_type() {
            ArgType::Variant => arg.as_iter().and_then(|mut it| it.next().and_then(text_of)),
            ArgType::String | ArgType::ObjectPath => arg.as_str().map(str::to_string),
            ArgType::Array => {
                let parts: Vec<String> = arg.as_iter()?.filter_map(text_of).filter(|s| !s.trim().is_empty()).collect();
                Some(parts.join(", "))
            }
            _ => None,
        }
    }

    /// The Metadata a{sv} → (key, text) pairs.
    fn metadata(arg: &dyn RefArg) -> Vec<(String, String)> {
        let inner: &dyn RefArg = arg;
        let mut out = Vec::new();
        let Some(mut items) = (if inner.arg_type() == ArgType::Variant {
            inner.as_iter().and_then(|mut it| it.next()).and_then(|v| v.as_iter())
        } else {
            inner.as_iter()
        }) else {
            return out;
        };
        while let (Some(k), Some(v)) = (items.next(), items.next()) {
            if let (Some(key), Some(value)) = (k.as_str(), text_of(v)) {
                out.push((key.to_string(), value));
            }
        }
        out
    }

    fn player_state(conn: &Connection, bus: &str) -> Option<(bool, NowPlaying)> {
        let proxy = conn.with_proxy(bus, PATH, CALL);
        let props: PropMap = proxy.get_all(PLAYER).ok()?;
        let status = props.get("PlaybackStatus").and_then(|v| text_of(&v.0)).unwrap_or_default();
        if status != "Playing" && status != "Paused" {
            return None;
        }
        let meta = props.get("Metadata").map(|v| metadata(&v.0)).unwrap_or_default();
        let get = |k: &str| meta.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).unwrap_or_default();
        let (title, artist) = (get("xesam:title"), get("xesam:artist"));
        if title.trim().is_empty() && artist.trim().is_empty() {
            return None;
        }
        let identity: Option<String> = proxy.get::<String>(ROOT, "Identity").ok().filter(|s| !s.is_empty());
        let app = identity.unwrap_or_else(|| app_name(bus));
        let key = track_key(&app, &title, &artist, &get("xesam:album"));
        // Only a local cover: a remote artUrl would be a request to a service
        // the user never configured here.
        let art = cached_art(&key).or_else(|| {
            let url = reqwest::Url::parse(&get("mpris:artUrl")).ok().filter(|u| u.scheme() == "file")?;
            let path = url.to_file_path().ok()?;
            if std::fs::metadata(&path).ok()?.len() > ART_LIMIT {
                return None;
            }
            let data = cover_data_url(&std::fs::read(path).ok()?)?;
            cache_art(key, data.clone());
            Some(data)
        });
        let playing = status == "Playing";
        Some((playing, NowPlaying { title, artist, app, playing, art }))
    }

    /// The playing player, else a paused one.
    fn read(conn: &Connection) -> (Option<String>, Option<NowPlaying>) {
        let proxy = conn.with_proxy(DBUS, "/org/freedesktop/DBus", CALL);
        let names: Vec<String> = match proxy.method_call(DBUS, "ListNames", ()) {
            Ok((names,)) => names,
            Err(_) => return (None, None),
        };
        let mut paused = None;
        for bus in names.into_iter().filter(|n| n.starts_with(PREFIX)) {
            match player_state(conn, &bus) {
                Some((true, now)) => return (Some(bus), Some(now)),
                Some((false, now)) if paused.is_none() => paused = Some((bus, now)),
                _ => {}
            }
        }
        match paused {
            Some((bus, now)) => (Some(bus), Some(now)),
            None => (None, None),
        }
    }

    fn with_control<R>(f: impl FnOnce(&Connection) -> Option<R>) -> Option<R> {
        let mut slot = CONTROL.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|c| !c.channel().is_connected()) {
            *slot = Connection::new_session().ok();
        }
        f(slot.as_ref()?)
    }

    pub fn read_once() -> Option<NowPlaying> {
        with_control(|c| read(c).1)
    }

    pub fn control(action: &str) -> bool {
        let method = match action {
            "playpause" => "PlayPause",
            "next" => "Next",
            _ => "Previous",
        };
        let known = shared().player.clone();
        with_control(|c| {
            let bus = known.or_else(|| read(c).0)?;
            let proxy = c.with_proxy(bus, PATH, CALL);
            proxy.method_call::<(), _, _, _>(PLAYER, method, ()).ok()
        })
        .is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ids_become_readable_names() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("MSEdge"), "Microsoft Edge");
        assert_eq!(app_name("Chrome"), "Chrome");
        assert_eq!(app_name("308046B0AF4A39CB"), "Firefox");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("Contoso.Player_abc123!App"), "Player");
        assert_eq!(app_name("musicbee.exe"), "Musicbee");
        assert_eq!(app_name("org.mpris.MediaPlayer2.strawberry"), "Strawberry");
        assert_eq!(app_name("org.mpris.MediaPlayer2.celluloid.instance42"), "Celluloid");
        assert_eq!(app_name(""), "");
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn covers_are_shrunk_to_96_px() {
        let img = image::RgbImage::from_pixel(640, 320, image::Rgb([200, 30, 30]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let url = cover_data_url(&png).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(cover_data_url(b"not an image").is_none());
    }

    #[test]
    fn the_payload_is_camel_case() {
        let now = NowPlaying { title: "T".into(), artist: "A".into(), app: "Spotify".into(), playing: true, art: None };
        let json = serde_json::to_string(&now).unwrap();
        assert_eq!(json, r#"{"title":"T","artist":"A","app":"Spotify","playing":true,"art":null}"#);
    }
}
