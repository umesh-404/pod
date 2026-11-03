// Reminders: set from the island, due at a time; when due a sound plays and the
// text shows on the left of the notch. Kept in a JSON file in the config folder.
//
// - Storage: reminders.json next to settings.json (platform::config_dir()),
//   written whole through a temporary file and a rename. A file that cannot be
//   read is moved aside as reminders.json.bad-<timestamp>, never overwritten.
// - Scheduler: one thread that sleeps until the next due time (at most 60 s at
//   a time, so clock changes and resume from sleep are caught) and is woken
//   early whenever the list changes. No polling.
// - Parser: `parse_at` turns "call Sam at 4pm" into text + due for the live
//   preview. English only.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeDelta, TimeZone, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: u64,
    pub text: String,
    /// Milliseconds since the Unix epoch.
    pub due: i64,
    /// Due and announced, waiting for Done or Snooze.
    pub fired: bool,
    /// A deadline: shown as a countdown ("2d 4h") on the left of the notch until due.
    /// Missing in older files → false.
    #[serde(default)]
    pub deadline: bool,
}

/// What a typed line means, for the live preview: "call Sam at 4pm" → text + due.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub text: String,
    pub due: Option<i64>,
}

/// Longest reminder text, in characters.
const MAX_TEXT: usize = 200;
/// A due time this far in the past is still accepted (the preview was a few seconds old).
const GRACE_MS: i64 = 60_000;
/// The scheduler never sleeps longer than this.
const MAX_SLEEP_MS: i64 = 60_000;

// ── Commands ──────────────────────────────────────────────────────────────────

/// Pending and fired reminders, soonest first. `reminders-changed` carries the same list.
#[tauri::command]
pub fn reminders_list(app: AppHandle) -> Vec<Reminder> {
    let _ = app;
    lock(&shared().store).sorted()
}

#[tauri::command]
pub fn reminder_parse(input: String) -> Parsed {
    parse_at(&input, Local::now())
}

#[tauri::command]
pub fn reminder_add(app: AppHandle, text: String, due: i64, deadline: bool) -> Result<Reminder, String> {
    change(&app, |store| store.add(&text, due, deadline, now_ms()))
}

#[tauri::command]
pub fn reminder_done(app: AppHandle, id: u64) -> Result<(), String> {
    change(&app, |store| store.done(id))
}

#[tauri::command]
pub fn reminder_snooze(app: AppHandle, id: u64, minutes: u32) -> Result<(), String> {
    change(&app, |store| store.snooze(id, minutes, now_ms()))
}

/// Starts the scheduler (called once from setup): `reminder-due` fires at each due time.
pub fn start(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("reminders".into())
        .spawn(move || run(shared(), |event| emit(&app, event)));
    if let Err(e) = spawned {
        note(format!("reminders: could not start the scheduler: {e}"));
    }
}

/// Applies one change, wakes the scheduler and tells the frontend.
fn change<T>(app: &AppHandle, apply: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let shared = shared();
    let (result, list) = {
        let mut store = lock(&shared.store);
        let result = apply(&mut store)?;
        (result, store.sorted())
    };
    shared.wake.notify_all();
    emit(app, Event::Changed(list));
    Ok(result)
}

// ── Shared state and scheduler ────────────────────────────────────────────────

struct Shared {
    store: Mutex<Store>,
    /// Notified whenever the list changes, so the scheduler re-reads the next due time.
    wake: Condvar,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        store: Mutex::new(Store::load(crate::settings::config_dir().join("reminders.json"))),
        wake: Condvar::new(),
    })
}

fn lock(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(|e| e.into_inner())
}

enum Event {
    Due(Reminder),
    Changed(Vec<Reminder>),
}

fn emit(app: &AppHandle, event: Event) {
    let _ = match event {
        Event::Due(reminder) => app.emit("reminder-due", reminder),
        Event::Changed(list) => app.emit("reminders-changed", list),
    };
}

/// The scheduler loop: fires what is due, then sleeps until the next due time,
/// at most `MAX_SLEEP_MS`, or until `wake` is notified. Reminders that came due
/// while the app was off fire on the first pass.
fn run(shared: &Shared, emit: impl Fn(Event)) {
    let mut store = lock(&shared.store);
    loop {
        let now = now_ms();
        let fired = store.fire_due(now);
        if !fired.is_empty() {
            let list = store.sorted();
            drop(store);
            for reminder in fired {
                emit(Event::Due(reminder));
            }
            emit(Event::Changed(list));
            store = lock(&shared.store);
            continue;
        }
        let sleep = store
            .next_due()
            .map(|due| (due - now).clamp(1, MAX_SLEEP_MS))
            .unwrap_or(MAX_SLEEP_MS);
        store = match shared.wake.wait_timeout(store, std::time::Duration::from_millis(sleep as u64)) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        };
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

// ── Storage ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    reminders: Vec<Reminder>,
}

struct Store {
    path: PathBuf,
    list: Vec<Reminder>,
    /// The id the next reminder gets; never reused, even after Done.
    next_id: u64,
    /// Set when the file on disk could not be loaded nor moved aside: saving
    /// would overwrite it, so saves are refused with this reason.
    blocked: Option<String>,
}

impl Store {
    fn load(path: PathBuf) -> Store {
        let mut store = Store { path, list: Vec::new(), next_id: 1, blocked: None };
        let bytes = match std::fs::read(&store.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return store,
            Err(e) => {
                note(format!("reminders: could not read {}: {e}", store.path.display()));
                store.blocked = Some(e.to_string());
                return store;
            }
        };
        match parse_file(&bytes) {
            Some(data) => {
                let max = data.reminders.iter().map(|r| r.id).max().unwrap_or(0);
                store.next_id = data.next_id.max(max + 1).max(1);
                store.list = data.reminders;
            }
            None => match set_aside(&store.path) {
                Ok(copy) => note(format!(
                    "reminders: {} was unreadable, kept as {}",
                    store.path.display(),
                    copy.display()
                )),
                Err(e) => {
                    note(format!("reminders: {} is unreadable and could not be moved aside: {e}", store.path.display()));
                    store.blocked = Some(e.to_string());
                }
            },
        }
        store
    }

    fn save(&self) -> Result<(), String> {
        if let Some(reason) = &self.blocked {
            return Err(tf("Couldn't save the reminders: {error}", &[("error", reason)]));
        }
        let data = FileData { next_id: self.next_id, reminders: self.list.clone() };
        write_atomic(&self.path, &data).map_err(|e| tf("Couldn't save the reminders: {error}", &[("error", &e.to_string())]))
    }

    /// Fired first (waiting for Done or Snooze), then by due time.
    fn sorted(&self) -> Vec<Reminder> {
        let mut list = self.list.clone();
        list.sort_by(|a, b| b.fired.cmp(&a.fired).then(a.due.cmp(&b.due)).then(a.id.cmp(&b.id)));
        list
    }

    /// Runs `apply`, saves, and puts everything back if the save fails.
    fn commit<T>(&mut self, apply: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let before = (self.list.clone(), self.next_id);
        let result = apply(self)?;
        if let Err(e) = self.save() {
            (self.list, self.next_id) = before;
            return Err(e);
        }
        Ok(result)
    }

    fn add(&mut self, text: &str, due: i64, deadline: bool, now: i64) -> Result<Reminder, String> {
        let text = text.trim();
        let length = text.chars().count();
        if length == 0 {
            return Err(t("Type what to be reminded of."));
        }
        if length > MAX_TEXT {
            return Err(t("Keep the reminder to 200 characters or fewer."));
        }
        if due < now - GRACE_MS {
            return Err(t("That time has already passed."));
        }
        let text = text.to_string();
        self.commit(|store| {
            let reminder = Reminder { id: store.next_id, text, due, fired: false, deadline };
            store.next_id += 1;
            store.list.push(reminder.clone());
            Ok(reminder)
        })
    }

    fn done(&mut self, id: u64) -> Result<(), String> {
        self.commit(|store| {
            let index = store.index(id)?;
            store.list.remove(index);
            Ok(())
        })
    }

    fn snooze(&mut self, id: u64, minutes: u32, now: i64) -> Result<(), String> {
        self.commit(|store| {
            let index = store.index(id)?;
            let reminder = &mut store.list[index];
            reminder.due = now + i64::from(minutes.max(1)) * 60_000;
            reminder.fired = false;
            Ok(())
        })
    }

    fn index(&self, id: u64) -> Result<usize, String> {
        self.list.iter().position(|r| r.id == id).ok_or_else(|| t("That reminder no longer exists."))
    }

    /// Marks every pending reminder due by `now` as fired and returns them. A
    /// failed save is logged: they still fire, and fire again after a restart.
    fn fire_due(&mut self, now: i64) -> Vec<Reminder> {
        let mut fired = Vec::new();
        for reminder in self.list.iter_mut().filter(|r| !r.fired && r.due <= now) {
            reminder.fired = true;
            fired.push(reminder.clone());
        }
        if !fired.is_empty() {
            if let Err(e) = self.save() {
                note(format!("reminders: {e}"));
            }
            fired.sort_by_key(|r| (r.due, r.id));
        }
        fired
    }

    fn next_due(&self) -> Option<i64> {
        self.list.iter().filter(|r| !r.fired).map(|r| r.due).min()
    }
}

/// Today's format, or a bare list of reminders.
fn parse_file(bytes: &[u8]) -> Option<FileData> {
    if let Ok(data) = serde_json::from_slice::<FileData>(bytes) {
        return Some(data);
    }
    serde_json::from_slice::<Vec<Reminder>>(bytes).ok().map(|reminders| FileData { next_id: 0, reminders })
}

/// Moves an unreadable file to `<name>.bad-<timestamp>` next to it.
fn set_aside(path: &Path) -> std::io::Result<PathBuf> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("reminders.json");
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut copy = path.with_file_name(format!("{name}.bad-{stamp}"));
    let mut n = 1;
    while copy.exists() {
        n += 1;
        copy = path.with_file_name(format!("{name}.bad-{stamp}-{n}"));
    }
    std::fs::rename(path, &copy).or_else(|_| std::fs::copy(path, &copy).map(|_| ()))?;
    Ok(copy)
}

/// Writes the whole file to a temporary name, then renames it over the old one.
fn write_atomic(path: &Path, data: &FileData) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        crate::platform::ensure_private_dir(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(data).map_err(std::io::Error::other)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("reminders.json");
    let temp = path.with_file_name(format!("{name}.tmp"));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

// ── Parser ────────────────────────────────────────────────────────────────────
//
// Understands (case-insensitive, anywhere in the line):
// - relative: "in 20 min", "in 2 hours", "in 1h30", "in 90m", "in an hour",
//   "in half an hour", "in 1 hour and 30 minutes", "in 3 days", "in a week"
// - times: "at 4pm", "4 pm", "4:30pm", "4.30pm", "16:30", "noon", "midday",
//   "midnight", and a bare hour after "at" or a day ("at 4", "tomorrow 9").
//   A bare 1–12 hour picks the next of am/pm when no day is given; with a day
//   it means pm for 1–6 and am for 7–12 ("fri 3" → 15:00, "fri 8" → 08:00).
// - days: "today", "tonight" (20:00), "tomorrow", "this morning/afternoon/
//   evening" (09:00/15:00/18:00), "tomorrow evening", weekdays ("fri",
//   "on monday", "friday morning"), "next monday" (that weekday in next
//   calendar week, weeks starting Monday), "next week" (next Monday).
//   A plain weekday is its next occurrence, today if the time is still ahead.
// - dates: ISO "2026-12-05", month names ("dec 5", "5 dec", "5th of december",
//   "december 5 2027"), and "d/m" or "d/m/yyyy". Slash dates are read
//   day-first unless only month-first makes sense ("12/25"): the system's
//   date order is not consulted. A date without a year that has passed is
//   next year's.
// - deadlines: when the line `looks_like_deadline` ("by friday", "due
//   friday") and has a day but no time, the time is 23:59; otherwise 09:00.
// Times already past today, with no day given, roll to tomorrow.

/// Words that suggest a deadline rather than a reminder.
pub fn looks_like_deadline(input: &str) -> bool {
    tokenize(input).iter().any(|tok| {
        matches!(tok.low.as_str(), "by" | "due" | "deadline" | "deadlines" | "exam" | "exams" | "submit")
    })
}

/// `reminder_parse` with a fixed `now`, for tests.
pub fn parse_at(input: &str, now: DateTime<Local>) -> Parsed {
    let tokens = tokenize(input);
    let mut found = Found::default();
    let mut consumed = vec![false; tokens.len()];
    let mut i = 0;
    while i < tokens.len() {
        let prev_at = i > 0 && tokens[i - 1].low == "at";
        let after_day = i > 0 && consumed[i - 1] && found.day.is_some();
        match recognize(&tokens, i, now, prev_at || after_day) {
            Some((len, pieces)) if found.accepts(&pieces) => {
                for piece in pieces {
                    found.take(piece);
                }
                consumed[i..i + len].fill(true);
                i += len;
            }
            _ => i += 1,
        }
    }
    let due = found.resolve(now, looks_like_deadline(input));
    let text = if due.is_some() { remaining_text(&tokens, &consumed) } else { input.trim().to_string() };
    Parsed { text, due: due.map(|d| d.timestamp_millis()) }
}

struct Tok<'a> {
    orig: &'a str,
    low: String,
}

fn tokenize(input: &str) -> Vec<Tok<'_>> {
    input.split_whitespace().map(|orig| Tok { orig, low: normalize(orig) }).collect()
}

fn normalize(word: &str) -> String {
    let low = word.to_lowercase().replace("a.m.", "am").replace("p.m.", "pm").replace("a.m", "am").replace("p.m", "pm");
    low.trim_matches(|c: char| ",;:!?.()\"“”".contains(c)).to_string()
}

/// The input without the time phrase and the connecting words before it.
fn remaining_text(tokens: &[Tok], consumed: &[bool]) -> String {
    let mut keep: Vec<bool> = consumed.iter().map(|c| !c).collect();
    for start in 0..tokens.len() {
        if consumed[start] && (start == 0 || !consumed[start - 1]) {
            let mut j = start;
            while j > 0 && keep[j - 1] && is_connector(&tokens[j - 1].low) {
                keep[j - 1] = false;
                j -= 1;
            }
        }
    }
    let words: Vec<&str> = tokens.iter().zip(&keep).filter(|(_, k)| **k).map(|(tok, _)| tok.orig).collect();
    words.join(" ").trim_matches(|c: char| c.is_whitespace() || ",;:-–—".contains(c)).to_string()
}

fn is_connector(word: &str) -> bool {
    matches!(word, "at" | "on" | "by" | "in" | "due" | "for" | "until" | "till")
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Period {
    Morning,
    Afternoon,
    Evening,
    Night,
}

impl Period {
    fn hour(self) -> u32 {
        match self {
            Period::Morning => 9,
            Period::Afternoon => 15,
            Period::Evening => 18,
            Period::Night => 20,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Day {
    Date(NaiveDate),
    /// The weekday; `true` for "next <weekday>".
    Weekday(Weekday, bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Clock {
    hour: u32,
    minute: u32,
    /// am/pm given, or 24-hour ("16:30", "09:00"): no guessing needed.
    fixed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Piece {
    After(TimeDelta),
    AfterDays(i64),
    Day(Day),
    Period(Period),
    Time(Clock),
    Midnight,
}

#[derive(Default)]
struct Found {
    after: Option<TimeDelta>,
    after_days: Option<i64>,
    day: Option<Day>,
    period: Option<Period>,
    time: Option<Clock>,
    midnight: bool,
}

impl Found {
    /// A phrase is taken only if it fills empty slots: the first time phrase wins.
    fn accepts(&self, pieces: &[Piece]) -> bool {
        let has_time = self.time.is_some() || self.midnight;
        let has_relative = self.after.is_some() || self.after_days.is_some();
        pieces.iter().all(|piece| match piece {
            Piece::After(_) | Piece::AfterDays(_) => !has_relative && self.day.is_none(),
            Piece::Day(_) => self.day.is_none() && !has_relative,
            Piece::Period(_) => self.period.is_none(),
            Piece::Time(_) | Piece::Midnight => !has_time && self.after.is_none(),
        })
    }

    fn take(&mut self, piece: Piece) {
        match piece {
            Piece::After(delta) => self.after = Some(delta),
            Piece::AfterDays(days) => self.after_days = Some(days),
            Piece::Day(day) => self.day = Some(day),
            Piece::Period(period) => self.period = Some(period),
            Piece::Time(clock) => self.time = Some(clock),
            Piece::Midnight => self.midnight = true,
        }
    }

    fn resolve(&self, now: DateTime<Local>, deadline: bool) -> Option<DateTime<Local>> {
        if let Some(delta) = self.after {
            return now.checked_add_signed(delta);
        }
        let today = now.date_naive();
        let day = match (self.day, self.after_days) {
            (Some(day), _) => Some(day),
            (None, Some(days)) => {
                if self.time.is_none() && !self.midnight && self.period.is_none() {
                    return now.checked_add_signed(TimeDelta::try_days(days)?);
                }
                Some(Day::Date(today.checked_add_signed(TimeDelta::try_days(days)?)?))
            }
            (None, None) => None,
        };
        let has_time = self.time.is_some() || self.midnight || self.period.is_some();
        match day {
            None if !has_time => None,
            None => {
                // No day: the next time this happens, today or tomorrow.
                let tomorrow = today.succ_opt()?;
                [today, tomorrow]
                    .into_iter()
                    .flat_map(|date| self.candidates(date, false, deadline))
                    .find(|at| *at > now)
            }
            Some(Day::Date(date)) => self.candidates(date, date != today, deadline).into_iter().next(),
            Some(Day::Weekday(weekday, false)) => (0..=7)
                .filter_map(|n| today.checked_add_signed(TimeDelta::try_days(n)?))
                .filter(|date| date.weekday() == weekday)
                .flat_map(|date| self.candidates(date, true, deadline))
                .find(|at| *at > now),
            Some(Day::Weekday(weekday, true)) => {
                let monday = today.checked_sub_signed(TimeDelta::try_days(today.weekday().num_days_from_monday().into())?)?;
                let offset = 7 + i64::from(weekday.num_days_from_monday());
                let date = monday.checked_add_signed(TimeDelta::try_days(offset)?)?;
                self.candidates(date, true, deadline).into_iter().next()
            }
        }
    }

    /// The moments this phrase can mean on `date`, earliest first. `named_day`
    /// is set when the user named the day (so a bare "3" means 3pm).
    fn candidates(&self, date: NaiveDate, named_day: bool, deadline: bool) -> Vec<DateTime<Local>> {
        if self.midnight {
            return date.succ_opt().and_then(|next| at(next, 0, 0)).into_iter().collect();
        }
        let hours: Vec<(u32, u32)> = match (self.time, self.period) {
            (Some(clock), period) => {
                let Clock { hour, minute, fixed } = clock;
                if fixed || hour > 12 || hour == 0 {
                    vec![(hour, minute)]
                } else if let Some(period) = period {
                    let pm = matches!(period, Period::Afternoon | Period::Evening | Period::Night);
                    vec![(if pm && hour < 12 { hour + 12 } else { hour % 12 }, minute)]
                } else if named_day {
                    vec![(if hour <= 6 { hour + 12 } else { hour }, minute)]
                } else if hour == 12 {
                    vec![(12, minute)]
                } else {
                    vec![(hour, minute), (hour + 12, minute)]
                }
            }
            (None, Some(period)) => vec![(period.hour(), 0)],
            (None, None) if deadline => vec![(23, 59)],
            (None, None) => vec![(9, 0)],
        };
        hours.into_iter().filter_map(|(h, m)| at(date, h, m)).collect()
    }
}

/// `date` at h:m local time; a time skipped by a DST change moves an hour later.
fn at(date: NaiveDate, hour: u32, minute: u32) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| Local.from_local_datetime(&(naive + TimeDelta::hours(1))).earliest())
}

/// The time phrase starting at token `i`, if any: its length and what it says.
/// `bare_hour` allows a lone number to be an hour ("at 4", "tomorrow 9").
fn recognize(tokens: &[Tok], i: usize, now: DateTime<Local>, bare_hour: bool) -> Option<(usize, Vec<Piece>)> {
    let word = |k: usize| tokens.get(i + k).map(|tok| tok.low.as_str()).unwrap_or("");
    let today = now.date_naive();

    if word(0) == "in" {
        if let Some((len, piece)) = relative(tokens, i + 1) {
            return Some((len + 1, vec![piece]));
        }
    }

    match word(0) {
        "today" => return Some(with_period(word(1), 1, vec![Piece::Day(Day::Date(today))])),
        "tonight" => return Some((1, vec![Piece::Day(Day::Date(today)), Piece::Period(Period::Night)])),
        "tomorrow" | "tomorow" | "tmrw" | "tmr" => {
            let date = today.succ_opt()?;
            return Some(with_period(word(1), 1, vec![Piece::Day(Day::Date(date))]));
        }
        "this" => {
            if let Some(period) = period(word(1)) {
                return Some((2, vec![Piece::Day(Day::Date(today)), Piece::Period(period)]));
            }
            if let Some(weekday) = weekday(word(1)) {
                return Some(with_period(word(2), 2, vec![Piece::Day(Day::Weekday(weekday, false))]));
            }
        }
        "next" => {
            if let Some(weekday) = weekday(word(1)) {
                return Some(with_period(word(2), 2, vec![Piece::Day(Day::Weekday(weekday, true))]));
            }
            if word(1) == "week" {
                return Some((2, vec![Piece::Day(Day::Weekday(Weekday::Mon, true))]));
            }
        }
        "noon" | "midday" => return Some((1, vec![Piece::Time(Clock { hour: 12, minute: 0, fixed: true })])),
        "midnight" => return Some((1, vec![Piece::Midnight])),
        _ => {}
    }
    if let Some(weekday) = weekday(word(0)) {
        return Some(with_period(word(1), 1, vec![Piece::Day(Day::Weekday(weekday, false))]));
    }
    if let Some((len, date)) = date(tokens, i, today) {
        return Some((len, vec![Piece::Day(Day::Date(date))]));
    }
    if let Some((len, clock)) = clock(word(0), word(1), bare_hour) {
        let len = if word(len) == "o'clock" || word(len) == "oclock" { len + 1 } else { len };
        return Some(with_period(word(len), len, vec![Piece::Time(clock)]));
    }
    None
}

/// Adds "morning"/"evening"… when it follows (`tomorrow evening`, `4 in the afternoon` is not handled).
fn with_period(next: &str, len: usize, mut pieces: Vec<Piece>) -> (usize, Vec<Piece>) {
    match period(next) {
        Some(p) => {
            pieces.push(Piece::Period(p));
            (len + 1, pieces)
        }
        None => (len, pieces),
    }
}

fn period(word: &str) -> Option<Period> {
    Some(match word {
        "morning" => Period::Morning,
        "afternoon" => Period::Afternoon,
        "evening" => Period::Evening,
        "night" => Period::Night,
        _ => return None,
    })
}

fn weekday(word: &str) -> Option<Weekday> {
    Some(match word {
        "mon" | "monday" => Weekday::Mon,
        "tue" | "tues" | "tuesday" => Weekday::Tue,
        "wed" | "weds" | "wednesday" => Weekday::Wed,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thu,
        "fri" | "friday" => Weekday::Fri,
        "sat" | "saturday" => Weekday::Sat,
        "sun" | "sunday" => Weekday::Sun,
        _ => return None,
    })
}

fn month(word: &str) -> Option<u32> {
    Some(match word {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    })
}

/// "5", "5th", "21st" → 5, 5, 21.
fn day_number(word: &str) -> Option<u32> {
    let digits = ["st", "nd", "rd", "th"].iter().find_map(|s| word.strip_suffix(s)).unwrap_or(word);
    let n = number(digits)?;
    (1..=31).contains(&n).then_some(n)
}

fn number(word: &str) -> Option<u32> {
    if word.is_empty() || word.len() > 4 || !word.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    word.parse().ok()
}

fn year(word: &str) -> Option<i32> {
    let n = number(word)?;
    (word.len() == 4 && (2000..=2200).contains(&n)).then_some(n as i32)
}

/// A month and day without a year: this year's, or next year's once passed.
fn upcoming(today: NaiveDate, month: u32, day: u32, year: Option<i32>) -> Option<NaiveDate> {
    if let Some(year) = year {
        return NaiveDate::from_ymd_opt(year, month, day);
    }
    match NaiveDate::from_ymd_opt(today.year(), month, day) {
        Some(date) if date >= today => Some(date),
        _ => NaiveDate::from_ymd_opt(today.year() + 1, month, day),
    }
}

fn date(tokens: &[Tok], i: usize, today: NaiveDate) -> Option<(usize, NaiveDate)> {
    let word = |k: usize| tokens.get(i + k).map(|tok| tok.low.as_str()).unwrap_or("");
    let first = word(0);
    // ISO.
    if first.len() == 10 && first.as_bytes()[4] == b'-' {
        if let Ok(date) = NaiveDate::parse_from_str(first, "%Y-%m-%d") {
            return Some((1, date));
        }
    }
    // d/m, d/m/yyyy (month-first only when day-first is impossible).
    if first.contains('/') {
        let parts: Vec<&str> = first.split('/').collect();
        if parts.len() == 2 || parts.len() == 3 {
            let a = number(parts[0])?;
            let b = number(parts[1])?;
            let year = match parts.get(2) {
                Some(y) if y.len() == 2 => Some(2000 + number(y)? as i32),
                Some(y) => Some(year(y)?),
                None => None,
            };
            let (day, month) = if b > 12 && a <= 12 { (b, a) } else { (a, b) };
            if (1..=12).contains(&month) {
                return upcoming(today, month, day, year).map(|date| (1, date));
            }
        }
        return None;
    }
    // "dec 5", "december 5th 2027".
    if let (Some(m), Some(d)) = (month(first), day_number(word(1))) {
        let y = year(word(2));
        return upcoming(today, m, d, y).map(|date| (if y.is_some() { 3 } else { 2 }, date));
    }
    // "5 dec", "5th of december 2027".
    if let Some(d) = day_number(first) {
        let of = usize::from(word(1) == "of");
        if let Some(m) = month(word(1 + of)) {
            let y = year(word(2 + of));
            let len = 2 + of + usize::from(y.is_some());
            return upcoming(today, m, d, y).map(|date| (len, date));
        }
    }
    None
}

/// "4pm", "4 pm", "4:30pm", "4.30pm", "16:30", and with `bare_hour` "4".
fn clock(word: &str, next: &str, bare_hour: bool) -> Option<(usize, Clock)> {
    let (body, suffix, len) = if let Some(body) = word.strip_suffix("am") {
        (body, Some(false), 1)
    } else if let Some(body) = word.strip_suffix("pm") {
        (body, Some(true), 1)
    } else if next == "am" || next == "pm" {
        (word, Some(next == "pm"), 2)
    } else {
        (word, None, 1)
    };
    let (hour, minute, has_minutes) = match body.split_once([':', '.']) {
        Some((h, m)) => {
            if body.contains('.') && suffix.is_none() {
                return None; // "3.5" is a number, not a time.
            }
            if m.len() != 2 {
                return None;
            }
            (number(h)?, number(m)?, true)
        }
        None => (number(body)?, 0, false),
    };
    if minute > 59 {
        return None;
    }
    match suffix {
        Some(pm) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            let hour = if pm { hour % 12 + 12 } else { hour % 12 };
            Some((len, Clock { hour, minute, fixed: true }))
        }
        None if has_minutes => {
            if hour > 23 {
                return None;
            }
            let fixed = hour > 12 || body.starts_with('0');
            Some((1, Clock { hour, minute, fixed }))
        }
        None if bare_hour && hour <= 23 && body.len() <= 2 => Some((1, Clock { hour, minute: 0, fixed: hour > 12 || body.starts_with('0') })),
        None => None,
    }
}

/// After "in": "20 min", "2 hours", "1h30", "an hour", "half an hour",
/// "1 hour and 30 minutes", "3 days", "a week".
fn relative(tokens: &[Tok], start: usize) -> Option<(usize, Piece)> {
    let word = |k: usize| tokens.get(start + k).map(|tok| tok.low.as_str()).unwrap_or("");
    if word(0) == "half" && matches!(word(1), "an" | "a") && matches!(word(2), "hour" | "hr") {
        return Some((3, Piece::After(TimeDelta::minutes(30))));
    }
    let (mut len, mut minutes, mut days) = amount(word(0), word(1))?;
    // "1 hour 30 min", "1 hour and 30 minutes".
    let and = usize::from(word(len) == "and");
    if let Some((more, m, d)) = amount(word(len + and), word(len + and + 1)) {
        if d == 0 && m > 0 {
            len += and + more;
            minutes += m;
            days += d;
        }
    }
    if minutes == 0 && days > 0 {
        Some((len, Piece::AfterDays(days)))
    } else if minutes > 0 || days > 0 {
        Some((len, Piece::After(TimeDelta::try_minutes(minutes + days * 1440)?)))
    } else {
        None
    }
}

/// One amount with its unit: (tokens used, minutes, days).
fn amount(word: &str, next: &str) -> Option<(usize, i64, i64)> {
    let value = |n: i64, unit: &str| -> Option<(i64, i64)> {
        match unit {
            "m" | "min" | "mins" | "minute" | "minutes" => Some((n, 0)),
            "h" | "hr" | "hrs" | "hour" | "hours" => Some((n * 60, 0)),
            "d" | "day" | "days" => Some((0, n)),
            "w" | "wk" | "wks" | "week" | "weeks" => Some((0, n * 7)),
            _ => None,
        }
    };
    if matches!(word, "a" | "an") {
        let (m, d) = value(1, next)?;
        return Some((2, m, d));
    }
    if let Some(n) = number(word) {
        let (m, d) = value(i64::from(n), next)?;
        return Some((2, m, d));
    }
    // Glued: "20min", "2h", "1h30", "1h30m".
    let digits: String = word.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n = i64::from(number(&digits)?);
    let rest = &word[digits.len()..];
    let unit: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let (mut m, d) = value(n, &unit)?;
    let tail = &rest[unit.len()..];
    if !tail.is_empty() {
        // "1h30" / "1h30m": minutes after hours only.
        if !matches!(unit.as_str(), "h" | "hr" | "hrs" | "hour" | "hours") {
            return None;
        }
        let tail = ["mins", "min", "m"].iter().find_map(|s| tail.strip_suffix(s)).unwrap_or(tail);
        let extra = number(tail)?;
        if extra > 59 {
            return None;
        }
        m += i64::from(extra);
    }
    Some((1, m, d))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    /// Tuesday 3 November 2026, 10:00 local time.
    fn now() -> DateTime<Local> {
        at(NaiveDate::from_ymd_opt(2026, 11, 3).unwrap(), 10, 0).unwrap()
    }

    fn parse(input: &str) -> Parsed {
        parse_at(input, now())
    }

    /// The due time as local "YYYY-MM-DD HH:MM".
    fn due(input: &str) -> String {
        let parsed = parse(input);
        let ms = parsed.due.unwrap_or_else(|| panic!("no time found in {input:?}"));
        let local: NaiveDateTime = Local.timestamp_millis_opt(ms).unwrap().naive_local();
        local.format("%Y-%m-%d %H:%M").to_string()
    }

    fn text(input: &str) -> String {
        parse(input).text
    }

    #[test]
    fn relative_times() {
        let base = now().timestamp_millis();
        assert_eq!(parse("in 20 min").due, Some(base + 20 * 60_000));
        assert_eq!(parse("stretch in 20 minutes").due, Some(base + 20 * 60_000));
        assert_eq!(parse("in 2 hours").due, Some(base + 120 * 60_000));
        assert_eq!(parse("in 1h30").due, Some(base + 90 * 60_000));
        assert_eq!(parse("in 1h30m").due, Some(base + 90 * 60_000));
        assert_eq!(parse("in 90m").due, Some(base + 90 * 60_000));
        assert_eq!(parse("in 2h").due, Some(base + 120 * 60_000));
        assert_eq!(parse("in an hour").due, Some(base + 60 * 60_000));
        assert_eq!(parse("in half an hour").due, Some(base + 30 * 60_000));
        assert_eq!(parse("in 1 hour and 30 minutes").due, Some(base + 90 * 60_000));
        assert_eq!(parse("in 1 hour 15 min").due, Some(base + 75 * 60_000));
        assert_eq!(due("in 3 days"), "2026-11-06 10:00");
        assert_eq!(due("in a week"), "2026-11-10 10:00");
        assert_eq!(due("in 2 days at 3pm"), "2026-11-05 15:00");
        assert_eq!(text("stretch in 20 min"), "stretch");
    }

    #[test]
    fn clock_times() {
        assert_eq!(due("at 4pm"), "2026-11-03 16:00");
        assert_eq!(due("4:30pm"), "2026-11-03 16:30");
        assert_eq!(due("4.30 pm"), "2026-11-03 16:30");
        assert_eq!(due("4 pm"), "2026-11-03 16:00");
        assert_eq!(due("16:30"), "2026-11-03 16:30");
        assert_eq!(due("noon"), "2026-11-03 12:00");
        assert_eq!(due("midday"), "2026-11-03 12:00");
        assert_eq!(due("midnight"), "2026-11-04 00:00");
        assert_eq!(due("at 11am"), "2026-11-03 11:00");
        assert_eq!(due("12am"), "2026-11-04 00:00");
        assert_eq!(due("12pm"), "2026-11-03 12:00");
        assert_eq!(due("at 7 o'clock"), "2026-11-03 19:00");
    }

    #[test]
    fn past_times_roll_to_tomorrow() {
        assert_eq!(due("at 9am"), "2026-11-04 09:00");
        assert_eq!(due("08:15"), "2026-11-04 08:15");
        assert_eq!(due("at 10am"), "2026-11-04 10:00");
        // A bare hour picks the next of am and pm.
        assert_eq!(due("at 4"), "2026-11-03 16:00");
        assert_eq!(due("at 11"), "2026-11-03 11:00");
        assert_eq!(due("at 9"), "2026-11-03 21:00");
    }

    #[test]
    fn day_words() {
        assert_eq!(due("tomorrow 9am"), "2026-11-04 09:00");
        assert_eq!(due("tomorrow at 9am"), "2026-11-04 09:00");
        assert_eq!(due("tomorrow"), "2026-11-04 09:00");
        assert_eq!(due("tomorrow 9"), "2026-11-04 09:00");
        assert_eq!(due("tomorrow evening"), "2026-11-04 18:00");
        assert_eq!(due("tonight"), "2026-11-03 20:00");
        assert_eq!(due("tonight at 11"), "2026-11-03 23:00");
        assert_eq!(due("this evening"), "2026-11-03 18:00");
        assert_eq!(due("this afternoon"), "2026-11-03 15:00");
        assert_eq!(due("today at 5pm"), "2026-11-03 17:00");
        assert_eq!(due("next week"), "2026-11-09 09:00");
    }

    #[test]
    fn weekdays() {
        // Today is Tuesday 3 November.
        assert_eq!(due("fri 3pm"), "2026-11-06 15:00");
        assert_eq!(due("fri 3"), "2026-11-06 15:00");
        assert_eq!(due("on monday"), "2026-11-09 09:00");
        assert_eq!(due("next monday"), "2026-11-09 09:00");
        assert_eq!(due("next friday"), "2026-11-13 09:00");
        assert_eq!(due("this friday"), "2026-11-06 09:00");
        assert_eq!(due("friday morning"), "2026-11-06 09:00");
        assert_eq!(due("wednesday at 8"), "2026-11-04 08:00");
        // Today's weekday: today while the time is ahead, else next week.
        assert_eq!(due("tuesday 5pm"), "2026-11-03 17:00");
        assert_eq!(due("tuesday 9am"), "2026-11-10 09:00");
    }

    #[test]
    fn dates() {
        assert_eq!(due("dec 5"), "2026-12-05 09:00");
        assert_eq!(due("5 dec"), "2026-12-05 09:00");
        assert_eq!(due("december 5th at 2pm"), "2026-12-05 14:00");
        assert_eq!(due("5th of december"), "2026-12-05 09:00");
        assert_eq!(due("2026-12-05"), "2026-12-05 09:00");
        assert_eq!(due("2026-12-05 16:30"), "2026-12-05 16:30");
        assert_eq!(due("dec 5 2027"), "2027-12-05 09:00");
        // Passed this year → next year.
        assert_eq!(due("jan 10"), "2027-01-10 09:00");
        // Slash dates: day first, unless only month first makes sense.
        assert_eq!(due("05/12"), "2026-12-05 09:00");
        assert_eq!(due("12/25"), "2026-12-25 09:00");
        assert_eq!(due("5/12/2027"), "2027-12-05 09:00");
        assert_eq!(parse("pay 31/02").due, None);
    }

    #[test]
    fn deadlines() {
        assert_eq!(due("essay by friday"), "2026-11-06 23:59");
        assert_eq!(due("report due friday"), "2026-11-06 23:59");
        assert_eq!(due("exam dec 5"), "2026-12-05 23:59");
        assert_eq!(due("essay by friday 5pm"), "2026-11-06 17:00");
        assert_eq!(text("essay by friday"), "essay");
        assert_eq!(text("Report due friday"), "Report");
        assert!(looks_like_deadline("Submit the essay"));
        assert!(looks_like_deadline("essay by Friday"));
        assert!(looks_like_deadline("Deadline: taxes"));
        assert!(!looks_like_deadline("call Sam at 4pm"));
        assert!(!looks_like_deadline("bye"));
    }

    #[test]
    fn text_is_cleaned() {
        assert_eq!(text("Call Sam at 4pm"), "Call Sam");
        assert_eq!(text("call Sam tomorrow at 9am"), "call Sam");
        assert_eq!(text("Dentist on Friday at 3pm"), "Dentist");
        assert_eq!(text("tomorrow 9am: water the plants"), "water the plants");
        assert_eq!(text("Buy milk, tonight"), "Buy milk");
        assert_eq!(text("  Pay rent in 2 hours  "), "Pay rent");
        assert_eq!(text("Book flights on dec 5"), "Book flights");
        // No time: the line as typed, and no due.
        assert_eq!(parse("  buy 4 apples ").text, "buy 4 apples");
        assert_eq!(parse("buy 4 apples").due, None);
        assert_eq!(parse("meet in the park").due, None);
        assert_eq!(parse("").due, None);
        assert_eq!(parse("").text, "");
        // Only the first time phrase counts; the rest stays text.
        assert_eq!(text("at 4pm move the 5pm meeting"), "move the 5pm meeting");
    }

    // ── Store ──

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pod-reminders-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("reminders.json")
    }

    fn names(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn add_validates() {
        let mut store = Store::load(scratch("validate"));
        assert!(store.add("   ", NOW + 1000, false, NOW).is_err());
        assert!(store.add(&"x".repeat(201), NOW + 1000, false, NOW).is_err());
        assert!(store.add(&"é".repeat(200), NOW + 1000, false, NOW).is_ok());
        assert!(store.add("late", NOW - 120_000, false, NOW).is_err());
        let ok = store.add("  just now  ", NOW - 30_000, true, NOW).unwrap();
        assert_eq!(ok.text, "just now");
        assert!(ok.deadline);
        assert!(!ok.fired);
    }

    #[test]
    fn ordering_and_ids() {
        let mut store = Store::load(scratch("order"));
        let a = store.add("a", NOW + 3000, false, NOW).unwrap();
        let b = store.add("b", NOW + 1000, false, NOW).unwrap();
        let c = store.add("c", NOW + 2000, false, NOW).unwrap();
        assert_eq!((a.id, b.id, c.id), (1, 2, 3));
        let ids: Vec<u64> = store.sorted().iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![2, 3, 1]);
        // Fired come first.
        let fired = store.fire_due(NOW + 2500);
        assert_eq!(fired.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2, 3]);
        assert!(store.fire_due(NOW + 2500).is_empty(), "fires once");
        let sorted = store.sorted();
        assert_eq!(sorted.iter().map(|r| (r.id, r.fired)).collect::<Vec<_>>(), vec![(2, true), (3, true), (1, false)]);
        assert_eq!(store.next_due(), Some(NOW + 3000));
        // Ids never come back, even after Done.
        store.done(1).unwrap();
        let d = store.add("d", NOW + 5000, false, NOW).unwrap();
        assert_eq!(d.id, 4);
        assert!(store.done(99).is_err());
    }

    #[test]
    fn snooze_rearms() {
        let mut store = Store::load(scratch("snooze"));
        let r = store.add("tea", NOW + 1000, true, NOW).unwrap();
        store.fire_due(NOW + 1000);
        store.snooze(r.id, 10, NOW + 5000).unwrap();
        let after = &store.sorted()[0];
        assert_eq!(after.due, NOW + 5000 + 600_000);
        assert!(!after.fired);
        assert!(after.deadline);
        assert_eq!(store.next_due(), Some(NOW + 605_000));
        assert!(store.snooze(42, 5, NOW).is_err());
    }

    #[test]
    fn persistence_round_trip() {
        let path = scratch("roundtrip");
        {
            let mut store = Store::load(path.clone());
            store.add("one", NOW + 1000, false, NOW).unwrap();
            store.add("two", NOW + 2000, true, NOW).unwrap();
            store.done(2).unwrap();
            store.fire_due(NOW + 1000);
        }
        let store = Store::load(path.clone());
        assert_eq!(store.list, vec![Reminder { id: 1, text: "one".into(), due: NOW + 1000, fired: true, deadline: false }]);
        assert_eq!(store.next_id, 3, "the id of a removed reminder is not reused");
        assert_eq!(names(&path), vec!["reminders.json"], "no temporary file left behind");
    }

    #[test]
    fn older_files_load() {
        let path = scratch("older");
        std::fs::write(&path, r#"[{"id":7,"text":"old","due":5,"fired":false}]"#).unwrap();
        let store = Store::load(path);
        assert_eq!(store.list.len(), 1);
        assert!(!store.list[0].deadline);
        assert_eq!(store.next_id, 8);
    }

    #[test]
    fn corrupt_file_is_kept_aside() {
        let path = scratch("corrupt");
        std::fs::write(&path, b"{ not json").unwrap();
        let mut store = Store::load(path.clone());
        assert!(store.list.is_empty());
        let files = names(&path);
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("reminders.json.bad-"), "{files:?}");
        let bad = path.with_file_name(&files[0]);
        assert_eq!(std::fs::read(&bad).unwrap(), b"{ not json");
        // Saving works again and leaves the copy alone.
        store.add("fresh", NOW + 1000, false, NOW).unwrap();
        assert_eq!(names(&path).len(), 2);
        assert_eq!(std::fs::read(&bad).unwrap(), b"{ not json");
    }

    #[test]
    fn scheduler_wakes_and_fires() {
        let path = scratch("scheduler");
        let shared: &'static Shared =
            Box::leak(Box::new(Shared { store: Mutex::new(Store::load(path)), wake: Condvar::new() }));
        // One that came due while the app was off.
        lock(&shared.store).add("missed", now_ms() - 10_000, false, now_ms()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let tx = Mutex::new(tx);
        std::thread::spawn(move || {
            run(shared, |event| {
                let line = match event {
                    Event::Due(r) => format!("due {}", r.text),
                    Event::Changed(list) => format!("changed {}", list.len()),
                };
                let _ = tx.lock().unwrap().send(line);
            })
        });
        let wait = std::time::Duration::from_secs(5);
        assert_eq!(rx.recv_timeout(wait).unwrap(), "due missed");
        assert_eq!(rx.recv_timeout(wait).unwrap(), "changed 1");
        // The scheduler is asleep for up to 60 s; a new reminder wakes it.
        let started = std::time::Instant::now();
        lock(&shared.store).add("soon", now_ms() + 300, false, now_ms()).unwrap();
        shared.wake.notify_all();
        assert_eq!(rx.recv_timeout(wait).unwrap(), "due soon");
        assert_eq!(rx.recv_timeout(wait).unwrap(), "changed 2");
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert!(lock(&shared.store).list.iter().all(|r| r.fired));
    }
}
