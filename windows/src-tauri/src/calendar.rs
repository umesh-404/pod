// The next meeting, for the notch's right side: read from the calendar links
// (.ics) the user pasted in Settings — Google, Outlook and iCloud all publish
// one. No account, no key.
//
// Only the links in settings `calendarUrls` are fetched (webcal:// read as
// https://), with timeouts and a 5 MB cap. Each feed is parsed with icalendar;
// recurring events are expanded with rrule (RRULE, EXDATE, RDATE, moved
// instances by RECURRENCE-ID) over the next 7 days, in their TZID (IANA or
// Windows names, else the feed's VTIMEZONE offset, else local time). All-day
// events never count as meetings. The last good result of each link stays in
// memory, so a failed fetch keeps what was there.
//
// How it runs: `calendar_refresh` (Settings saved, or the island asking)
// fetches now and starts the background task if it isn't running; `start(app)`
// does the same without waiting and may be called from setup. The task is one
// async loop that sleeps until the next thing that matters — the 15-minute
// refresh, the current meeting's end, the next one's start, or local midnight —
// re-emits `next-meeting` then, and ends by itself when `calendarUrls` is empty.

use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use icalendar::parser::{Component, Property};
use rrule::{RRule, RRuleSet, Tz, Unvalidated};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const EVENT: &str = "next-meeting";
const REFRESH: Duration = Duration::from_secs(15 * 60);
const MAX_BYTES: usize = 5 * 1024 * 1024;
const LOOKAHEAD_DAYS: i64 = 7;
/// After a boundary, wake this much later so the start or end is behind us.
const SLACK_MS: i64 = 500;

/// Also the `next-meeting` event payload (null when nothing is coming up today).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub title: String,
    /// Milliseconds since the Unix epoch.
    pub start: i64,
    pub end: i64,
    /// A Teams / Zoom / Meet / Webex link found in the event, if any.
    pub link: Option<String>,
    pub location: String,
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/// What a feed holds: its event count, and the timed occurrences in the window.
#[derive(Debug, Default)]
pub struct Parsed {
    pub events: usize,
    pub occurrences: Vec<Meeting>,
}

fn param<'a>(prop: &'a Property<'_>, key: &str) -> Option<&'a str> {
    prop.params
        .iter()
        .find(|p| p.key.as_str().eq_ignore_ascii_case(key))
        .and_then(|p| p.val.as_ref())
        .map(|v| v.as_str().trim_matches('"'))
}

fn props<'c, 'a>(comp: &'c Component<'a>, name: &'c str) -> impl Iterator<Item = &'c Property<'a>> + 'c {
    comp.properties.iter().filter(move |p| p.name.as_str().eq_ignore_ascii_case(name))
}

fn text(comp: &Component<'_>, name: &str) -> String {
    props(comp, name).next().map(|p| p.val.as_str().trim().to_string()).unwrap_or_default()
}

/// Common Windows time zone names (Outlook feeds use them as TZIDs) → IANA.
fn windows_zone(name: &str) -> Option<&'static str> {
    const ZONES: [(&str, &str); 56] = [
        ("UTC", "UTC"),
        ("Coordinated Universal Time", "UTC"),
        ("GMT Standard Time", "Europe/London"),
        ("Greenwich Standard Time", "Atlantic/Reykjavik"),
        ("W. Europe Standard Time", "Europe/Berlin"),
        ("Romance Standard Time", "Europe/Paris"),
        ("Central Europe Standard Time", "Europe/Budapest"),
        ("Central European Standard Time", "Europe/Warsaw"),
        ("E. Europe Standard Time", "Europe/Chisinau"),
        ("FLE Standard Time", "Europe/Kyiv"),
        ("GTB Standard Time", "Europe/Bucharest"),
        ("Russian Standard Time", "Europe/Moscow"),
        ("Turkey Standard Time", "Europe/Istanbul"),
        ("Israel Standard Time", "Asia/Jerusalem"),
        ("Egypt Standard Time", "Africa/Cairo"),
        ("South Africa Standard Time", "Africa/Johannesburg"),
        ("W. Central Africa Standard Time", "Africa/Lagos"),
        ("E. Africa Standard Time", "Africa/Nairobi"),
        ("Morocco Standard Time", "Africa/Casablanca"),
        ("Arab Standard Time", "Asia/Riyadh"),
        ("Arabian Standard Time", "Asia/Dubai"),
        ("Iran Standard Time", "Asia/Tehran"),
        ("Pakistan Standard Time", "Asia/Karachi"),
        ("India Standard Time", "Asia/Kolkata"),
        ("Sri Lanka Standard Time", "Asia/Colombo"),
        ("Nepal Standard Time", "Asia/Kathmandu"),
        ("Bangladesh Standard Time", "Asia/Dhaka"),
        ("Myanmar Standard Time", "Asia/Yangon"),
        ("SE Asia Standard Time", "Asia/Bangkok"),
        ("China Standard Time", "Asia/Shanghai"),
        ("Singapore Standard Time", "Asia/Singapore"),
        ("Taipei Standard Time", "Asia/Taipei"),
        ("W. Australia Standard Time", "Australia/Perth"),
        ("Tokyo Standard Time", "Asia/Tokyo"),
        ("Korea Standard Time", "Asia/Seoul"),
        ("Cen. Australia Standard Time", "Australia/Adelaide"),
        ("AUS Central Standard Time", "Australia/Darwin"),
        ("E. Australia Standard Time", "Australia/Brisbane"),
        ("AUS Eastern Standard Time", "Australia/Sydney"),
        ("New Zealand Standard Time", "Pacific/Auckland"),
        ("Hawaiian Standard Time", "Pacific/Honolulu"),
        ("Alaskan Standard Time", "America/Anchorage"),
        ("Pacific Standard Time", "America/Los_Angeles"),
        ("US Mountain Standard Time", "America/Phoenix"),
        ("Mountain Standard Time", "America/Denver"),
        ("Central Standard Time", "America/Chicago"),
        ("Central Standard Time (Mexico)", "America/Mexico_City"),
        ("Canada Central Standard Time", "America/Regina"),
        ("Eastern Standard Time", "America/New_York"),
        ("SA Pacific Standard Time", "America/Bogota"),
        ("Atlantic Standard Time", "America/Halifax"),
        ("Venezuela Standard Time", "America/Caracas"),
        ("Pacific SA Standard Time", "America/Santiago"),
        ("Newfoundland Standard Time", "America/St_Johns"),
        ("E. South America Standard Time", "America/Sao_Paulo"),
        ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ];
    ZONES.iter().find(|(w, _)| w.eq_ignore_ascii_case(name)).map(|(_, iana)| *iana)
}

/// A TZID → the zone. `offsets` holds each VTIMEZONE's standard offset
/// (seconds east of UTC), the last resort for a custom name.
pub fn resolve_tzid(id: &str, offsets: &HashMap<String, i32>) -> Option<Tz> {
    let id = id.trim().trim_matches('"');
    let iana = |name: &str| name.parse::<chrono_tz::Tz>().ok().map(Tz::Tz);
    if let Some(tz) = iana(id) {
        return Some(tz);
    }
    // "/mozilla.org/20050126_1/Europe/Berlin", "/Europe/Berlin": the longest IANA tail.
    let parts: Vec<&str> = id.split('/').filter(|p| !p.is_empty()).collect();
    for start in 0..parts.len() {
        if let Some(tz) = iana(&parts[start..].join("/")) {
            return Some(tz);
        }
    }
    if let Some(tz) = windows_zone(id).and_then(iana) {
        return Some(tz);
    }
    // Whole-hour offsets have an Etc zone (whose sign is the other way round).
    let secs = *offsets.get(id)?;
    if secs % 3600 != 0 {
        return None;
    }
    let hours = -secs / 3600;
    let name = if hours == 0 { "Etc/GMT".to_string() } else { format!("Etc/GMT{hours:+}") };
    iana(&name)
}

/// "+0100" / "-0530" / "+010000" → seconds east of UTC.
fn utc_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => (1, s),
    };
    if rest.len() < 4 || !rest.is_ascii() {
        return None;
    }
    let h: i32 = rest[0..2].parse().ok()?;
    let m: i32 = rest[2..4].parse().ok()?;
    let sec: i32 = if rest.len() >= 6 { rest[4..6].parse().ok()? } else { 0 };
    Some(sign * (h * 3600 + m * 60 + sec))
}

/// A DATE-TIME or DATE value.
#[derive(Debug, Clone, Copy, PartialEq)]
enum When {
    Utc(NaiveDateTime),
    /// In the given zone (or local time when the TZID is unknown / absent).
    Local(NaiveDateTime, Tz),
    Date(NaiveDate),
}

fn parse_when(value: &str, tzid: Option<&str>, offsets: &HashMap<String, i32>) -> Option<When> {
    let v = value.trim();
    if v.len() == 8 {
        return NaiveDate::parse_from_str(v, "%Y%m%d").ok().map(When::Date);
    }
    if let Some(utc) = v.strip_suffix('Z').or_else(|| v.strip_suffix('z')) {
        return NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok().map(When::Utc);
    }
    let naive = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    let tz = tzid.and_then(|id| resolve_tzid(id, offsets)).unwrap_or(Tz::LOCAL);
    Some(When::Local(naive, tz))
}

/// A wall-clock time in `tz`; a time skipped by a DST change moves an hour on.
fn in_zone(naive: NaiveDateTime, tz: Tz) -> Option<DateTime<Tz>> {
    tz.from_local_datetime(&naive).earliest().or_else(|| tz.from_local_datetime(&(naive + ChronoDuration::hours(1))).earliest())
}

fn to_datetime(when: When) -> Option<DateTime<Tz>> {
    match when {
        When::Utc(n) => Some(Tz::UTC.from_utc_datetime(&n)),
        When::Local(n, tz) => in_zone(n, tz),
        When::Date(_) => None,
    }
}

/// An iCalendar DURATION ("PT1H30M", "P1D", "-PT15M", "P1W") in seconds.
pub fn parse_duration(s: &str) -> Option<i64> {
    let s = s.trim();
    let (sign, s) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix('P')?;
    let mut total = 0i64;
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += n * match (c, in_time) {
                    ('W', false) => 7 * 86_400,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
            }
        }
    }
    num.is_empty().then_some(sign * total)
}

/// RRULE's UNTIL must be UTC when DTSTART has a zone; feeds often give a
/// floating time or a date. Rewrites it as UTC, read in DTSTART's zone.
fn normalise_until(rule: &str, tz: Tz) -> String {
    rule.split(';')
        .map(|part| {
            let Some((key, value)) = part.split_once('=') else { return part.to_string() };
            if !key.eq_ignore_ascii_case("UNTIL") || value.ends_with(['Z', 'z']) {
                return part.to_string();
            }
            let naive = if value.len() == 8 {
                NaiveDate::parse_from_str(value, "%Y%m%d").ok().and_then(|d| d.and_hms_opt(23, 59, 59))
            } else {
                NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()
            };
            match naive.and_then(|n| in_zone(n, tz)) {
                Some(dt) => format!("{key}={}", dt.with_timezone(&Utc).format("%Y%m%dT%H%M%SZ")),
                None => part.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// EXDATE / RDATE values of one property, in DTSTART's frame. A date-only
/// value means DTSTART's time of day on that date; a PERIOD its start.
fn date_list(prop: &Property<'_>, start: &DateTime<Tz>, offsets: &HashMap<String, i32>) -> Vec<DateTime<Tz>> {
    let tzid = param(prop, "TZID");
    prop.val
        .as_str()
        .split(',')
        .filter_map(|v| {
            let v = v.split('/').next().unwrap_or(v);
            match parse_when(v, tzid, offsets)? {
                When::Date(d) => in_zone(d.and_time(start.naive_local().time()), start.timezone()),
                when => to_datetime(when),
            }
        })
        .collect()
}

const MEETING_HOSTS: [&str; 7] =
    ["teams.microsoft.com", "teams.live.com", "zoom.us", "zoomgov.com", "meet.google.com", "webex.com", "gotomeeting.com"];

/// The first Teams / Zoom / Meet / Webex link in `text`.
pub fn find_meeting_link(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(i) = rest.find("https://") {
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '\\' | '|'))
            .unwrap_or(tail.len());
        let candidate = tail[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if let Ok(url) = reqwest::Url::parse(candidate) {
            if let Some(host) = url.host_str() {
                let host = host.to_ascii_lowercase();
                if MEETING_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
                    return Some(candidate.to_string());
                }
            }
        }
        rest = &tail["https://".len()..];
    }
    None
}

fn meeting_link(event: &Component<'_>) -> Option<String> {
    ["X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL", "URL", "LOCATION", "DESCRIPTION"]
        .iter()
        .flat_map(|name| props(event, name))
        .find_map(|p| find_meeting_link(p.val.as_str()))
}

/// All components named `name`, at any depth.
fn collect<'c, 'a>(comps: &'c [Component<'a>], name: &str, out: &mut Vec<&'c Component<'a>>) {
    for c in comps {
        if c.name.as_str().eq_ignore_ascii_case(name) {
            out.push(c);
        }
        collect(&c.components, name, out);
    }
}

/// Parses a feed and lists the timed occurrences overlapping [from, to) (ms).
pub fn parse_ics(ics: &str, from_ms: i64, to_ms: i64) -> Result<Parsed, String> {
    if !ics.contains("BEGIN:VCALENDAR") {
        return Err("not a calendar".into());
    }
    let unfolded = icalendar::parser::unfold(ics);
    let calendar = icalendar::parser::read_calendar(&unfolded)?;

    let mut zones = Vec::new();
    collect(&calendar.components, "VTIMEZONE", &mut zones);
    let mut offsets = HashMap::new();
    for zone in zones {
        let id = text(zone, "TZID");
        let standard = zone.components.iter().find(|c| c.name.as_str().eq_ignore_ascii_case("STANDARD"));
        if let Some(secs) = standard.and_then(|s| utc_offset(&text(s, "TZOFFSETTO"))) {
            offsets.insert(id, secs);
        }
    }

    let mut events = Vec::new();
    collect(&calendar.components, "VEVENT", &mut events);
    let mut parsed = Parsed { events: events.len(), occurrences: Vec::new() };
    // Instances moved or cancelled by a RECURRENCE-ID: (UID, original start ms).
    let mut overridden: HashSet<(String, i64)> = HashSet::new();
    // Occurrences from recurring masters, with their UID, filtered at the end.
    let mut expanded: Vec<(String, Meeting)> = Vec::new();

    let from = Tz::UTC.timestamp_millis_opt(from_ms).single().ok_or("bad window")?;
    let to = Tz::UTC.timestamp_millis_opt(to_ms).single().ok_or("bad window")?;

    for event in events {
        let uid = text(event, "UID");
        let Some(dtstart) = props(event, "DTSTART").next() else { continue };
        let Some(start_when) = parse_when(dtstart.val.as_str(), param(dtstart, "TZID"), &offsets) else { continue };
        // All-day events are never the next meeting.
        let Some(start) = to_datetime(start_when) else { continue };

        if let Some(rid) = props(event, "RECURRENCE-ID").next() {
            if let Some(original) = parse_when(rid.val.as_str(), param(rid, "TZID"), &offsets).and_then(to_datetime) {
                overridden.insert((uid.clone(), original.timestamp_millis()));
            }
        }
        if text(event, "STATUS").eq_ignore_ascii_case("CANCELLED") {
            continue;
        }

        let duration_ms = match props(event, "DTEND").next() {
            Some(end) => parse_when(end.val.as_str(), param(end, "TZID"), &offsets)
                .and_then(to_datetime)
                .map(|e| (e.timestamp_millis() - start.timestamp_millis()).max(0))
                .unwrap_or(0),
            None => parse_duration(&text(event, "DURATION")).map(|s| s.max(0) * 1000).unwrap_or(0),
        };
        let meeting = |at: i64| Meeting {
            title: text(event, "SUMMARY"),
            start: at,
            end: at + duration_ms,
            link: meeting_link(event),
            location: text(event, "LOCATION"),
        };
        let overlaps = |at: i64| at < to_ms && (at + duration_ms > from_ms || (duration_ms == 0 && at >= from_ms));

        let rrule = props(event, "RRULE").next();
        let rdates: Vec<&Property<'_>> = props(event, "RDATE").collect();
        let recurring = rrule.is_some() || !rdates.is_empty();
        let set = recurring
            .then(|| {
                let mut set = match rrule {
                    Some(rule) => {
                        let rule = normalise_until(rule.val.as_str(), start.timezone());
                        rule.parse::<RRule<Unvalidated>>().ok()?.build(start).ok()?
                    }
                    None => RRuleSet::new(start).rdate(start),
                };
                for p in &rdates {
                    for d in date_list(p, &start, &offsets) {
                        set = set.rdate(d);
                    }
                }
                for p in props(event, "EXDATE") {
                    for d in date_list(p, &start, &offsets) {
                        set = set.exdate(d);
                    }
                }
                let window_start = from - ChronoDuration::milliseconds(duration_ms + 1);
                Some(set.after(window_start).before(to).all(1000).dates)
            })
            .flatten();

        match set {
            Some(dates) => {
                for d in dates {
                    let at = d.timestamp_millis();
                    if overlaps(at) {
                        expanded.push((uid.clone(), meeting(at)));
                    }
                }
            }
            // A plain event, or a rule we can't read: its own time only.
            None => {
                let at = start.timestamp_millis();
                if overlaps(at) {
                    parsed.occurrences.push(meeting(at));
                }
            }
        }
    }

    parsed
        .occurrences
        .extend(expanded.into_iter().filter(|(uid, m)| !overridden.contains(&(uid.clone(), m.start))).map(|(_, m)| m));
    parsed.occurrences.sort_by_key(|m| (m.start, m.end));
    parsed.occurrences.dedup();
    Ok(parsed)
}

/// The meeting to show at `now`: the ongoing one that started last, else the
/// next one starting before `day_end` (both ms).
pub fn choose(occurrences: &[Meeting], now: i64, day_end: i64) -> Option<Meeting> {
    let ongoing = occurrences.iter().filter(|m| m.start <= now && now < m.end).max_by_key(|m| (m.start, -m.end));
    ongoing
        .or_else(|| occurrences.iter().filter(|m| m.start > now && m.start < day_end).min_by_key(|m| (m.start, m.end)))
        .cloned()
}

/// The next moment the choice can change: a start or an end after `now`, or `day_end`.
pub fn next_boundary(occurrences: &[Meeting], now: i64, day_end: i64) -> i64 {
    occurrences.iter().flat_map(|m| [m.start, m.end]).filter(|&t| t > now).fold(day_end.max(now + 1), i64::min)
}

// ── Fetching ──────────────────────────────────────────────────────────────────

/// webcal:// → https://; only http(s) links are fetched.
pub fn normalise_url(raw: &str) -> Result<reqwest::Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(crate::i18n::t("Enter a calendar link."));
    }
    let lower = raw.to_ascii_lowercase();
    let fixed = if let Some(rest) = lower.strip_prefix("webcals://").or_else(|| lower.strip_prefix("webcal://")) {
        format!("https://{}", &raw[raw.len() - rest.len()..])
    } else {
        raw.to_string()
    };
    match reqwest::Url::parse(&fixed) {
        Ok(url) if matches!(url.scheme(), "https" | "http") && url.host_str().is_some() => Ok(url),
        _ => Err(crate::i18n::t("This isn't a calendar link.")),
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

async fn fetch(raw: &str) -> Result<String, String> {
    let url = normalise_url(raw)?;
    let unreachable = |_| crate::i18n::t("Couldn't reach the calendar.");
    let mut response = client().get(url).send().await.map_err(unreachable)?;
    let status = response.status();
    if !status.is_success() {
        return Err(crate::i18n::tf("The calendar answered with error {status}.", &[("status", status.as_str())]));
    }
    let too_big = || crate::i18n::t("The calendar is too big (over 5 MB).");
    if response.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn not_a_calendar() -> String {
    crate::i18n::t("This link isn't a calendar (.ics).")
}

// ── State and the background task ─────────────────────────────────────────────

#[derive(Default)]
struct State {
    /// Occurrences from each link's last good fetch.
    cache: HashMap<String, Vec<Meeting>>,
    fetched_at: Option<Instant>,
    running: bool,
    /// What `next-meeting` last carried.
    sent: Option<Option<Meeting>>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// One refresh at a time (the task and a command may both want one).
static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(State::default))
}

fn configured() -> Vec<String> {
    let mut urls: Vec<String> =
        crate::settings::load().calendar_urls.into_iter().map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect();
    urls.dedup();
    urls
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Local midnight tonight, in ms.
fn day_end_ms() -> i64 {
    let tomorrow = Local::now().date_naive().succ_opt().and_then(|d| d.and_hms_opt(0, 0, 0));
    tomorrow
        .and_then(|n| Local.from_local_datetime(&n).earliest())
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(|| now_ms() + 86_400_000)
}

/// Fetches every link; a failed one keeps its last good result. Err only when
/// nothing at all is known.
async fn refresh_all(urls: &[String]) -> Result<(), String> {
    let _one = FETCHING.lock().await;
    let from = now_ms() - 86_400_000;
    let to = now_ms() + LOOKAHEAD_DAYS * 86_400_000;
    let mut first_error = None;
    let mut fresh = HashMap::new();
    for url in urls {
        let result = match fetch(url).await {
            Ok(body) => parse_ics(&body, from, to).map_err(|err| {
                crate::log::line(format!("calendar: unreadable feed: {err}"));
                not_a_calendar()
            }),
            Err(err) => Err(err),
        };
        match result {
            Ok(parsed) => {
                fresh.insert(url.clone(), parsed.occurrences);
            }
            Err(err) => {
                crate::log::line(format!("calendar: refresh failed: {err}"));
                first_error.get_or_insert(err);
            }
        }
    }
    with_state(|s| {
        s.cache.retain(|url, _| urls.contains(url));
        s.cache.extend(fresh);
        s.fetched_at = Some(Instant::now());
        match first_error {
            Some(err) if s.cache.is_empty() => Err(err),
            _ => Ok(()),
        }
    })
}

/// The meeting now, and when to look again.
fn current() -> (Option<Meeting>, i64) {
    let now = now_ms();
    let day_end = day_end_ms();
    with_state(|s| {
        let all: Vec<Meeting> = s.cache.values().flatten().cloned().collect();
        (choose(&all, now, day_end), next_boundary(&all, now, day_end))
    })
}

/// Emits `next-meeting`; unless `always`, only when it changed.
fn send(app: &AppHandle, meeting: Option<Meeting>, always: bool) {
    let changed = with_state(|s| {
        let changed = s.sent.as_ref() != Some(&meeting);
        s.sent = Some(meeting.clone());
        changed
    });
    if changed || always {
        let _ = app.emit(EVENT, meeting);
    }
}

/// Starts the background task when there are links and it isn't running;
/// otherwise just wakes it to look again. Safe to call from setup.
pub fn start(app: &AppHandle) {
    let spawn = with_state(|s| {
        if s.running {
            return false;
        }
        s.running = true;
        true
    });
    if spawn {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { run(app).await });
    } else {
        WAKE.notify_one();
    }
}

async fn run(app: AppHandle) {
    let mut boundary_due = false;
    loop {
        let urls = configured();
        if urls.is_empty() {
            // Settings may have gained a link meanwhile: decide under the lock
            // `start` takes, so a start in between is never lost.
            let stop = with_state(|s| {
                if configured().is_empty() {
                    s.running = false;
                    s.cache.clear();
                    s.fetched_at = None;
                    true
                } else {
                    false
                }
            });
            if stop {
                send(&app, None, false);
                return;
            }
            continue;
        }
        let due = with_state(|s| s.fetched_at.is_none_or(|t| t.elapsed() >= REFRESH));
        // Tray → Pause: nothing goes out to the network meanwhile.
        let paused = crate::update::PAUSED.load(std::sync::atomic::Ordering::Relaxed);
        if due && !paused {
            let _ = refresh_all(&urls).await;
        }
        let (meeting, boundary) = current();
        send(&app, meeting, boundary_due);

        let since = with_state(|s| s.fetched_at.map(|t| t.elapsed()).unwrap_or_default());
        // Paused, the refresh stays due: look again in a while, not at once.
        let until_refresh = if paused { REFRESH } else { REFRESH.saturating_sub(since) };
        let until_boundary = Duration::from_millis((boundary - now_ms() + SLACK_MS).max(0) as u64);
        boundary_due = until_boundary < until_refresh;
        tokio::select! {
            _ = tokio::time::sleep(until_boundary.min(until_refresh)) => {}
            _ = WAKE.notified() => boundary_due = false,
        }
    }
}

/// Re-reads the calendars now (Settings saved, or the island asks) and returns the next meeting.
#[tauri::command]
pub async fn calendar_refresh(app: AppHandle) -> Result<Option<Meeting>, String> {
    let urls = configured();
    if urls.is_empty() {
        with_state(|s| {
            s.cache.clear();
            s.fetched_at = None;
        });
        send(&app, None, false);
        return Ok(None);
    }
    let result = refresh_all(&urls).await;
    let (meeting, _) = current();
    send(&app, meeting.clone(), false);
    // The task picks up the new boundaries (or starts, the first time).
    start(&app);
    result.map(|_| meeting)
}

/// Settings → "Test": fetches one link and says how many events it holds.
#[tauri::command]
pub async fn calendar_test(url: String) -> Result<usize, String> {
    let body = fetch(&url).await?;
    let now = now_ms();
    parse_ics(&body, now, now).map(|p| p.events).map_err(|_| not_a_calendar())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    const FIXTURE: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Test//EN\r\n\
BEGIN:VTIMEZONE\r\n\
TZID:Custom Plus Two\r\n\
BEGIN:STANDARD\r\n\
DTSTART:19700101T000000\r\n\
TZOFFSETFROM:+0200\r\n\
TZOFFSETTO:+0200\r\n\
END:STANDARD\r\n\
END:VTIMEZONE\r\n\
BEGIN:VEVENT\r\n\
UID:standup@test\r\n\
SUMMARY:Standup\r\n\
DTSTART;TZID=Europe/Paris:20261026T093000\r\n\
DTEND;TZID=Europe/Paris:20261026T094500\r\n\
RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T235959\r\n\
EXDATE;TZID=Europe/Paris:20261104T093000\r\n\
LOCATION:Room 4\r\n\
DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x\\n\r\n More text\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:standup@test\r\n\
RECURRENCE-ID;TZID=Europe/Paris:20261105T093000\r\n\
SUMMARY:Standup (moved)\r\n\
DTSTART;TZID=Europe/Paris:20261105T110000\r\n\
DTEND;TZID=Europe/Paris:20261105T111500\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:offsite@test\r\n\
SUMMARY:Offsite\r\n\
DTSTART;VALUE=DATE:20261104\r\n\
DTEND;VALUE=DATE:20261105\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:review@test\r\n\
SUMMARY:Review\r\n\
DTSTART;TZID=Pacific Standard Time:20261104T080000\r\n\
DURATION:PT1H\r\n\
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:sync@test\r\n\
SUMMARY:Sync\r\n\
DTSTART;TZID=Custom Plus Two:20261104T150000\r\n\
DTEND;TZID=Custom Plus Two:20261104T153000\r\n\
LOCATION:https://us02web.zoom.us/j/123456789?pwd=abc\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:gone@test\r\n\
SUMMARY:Cancelled\r\n\
STATUS:CANCELLED\r\n\
DTSTART:20261104T120000Z\r\n\
DTEND:20261104T130000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn ics_with_rrule_tzid_exdate_and_overrides_expands() {
        let from = ms("2026-11-03T00:00:00Z");
        let to = ms("2026-11-07T00:00:00Z");
        let parsed = parse_ics(FIXTURE, from, to).unwrap();
        assert_eq!(parsed.events, 6);
        let list: Vec<(&str, i64)> = parsed.occurrences.iter().map(|m| (m.title.as_str(), m.start)).collect();
        assert_eq!(
            list,
            vec![
                // Paris is UTC+1 in November.
                ("Standup", ms("2026-11-03T08:30:00Z")),
                // 4th: the standup is excluded; the Windows-named zone is Los Angeles (UTC-8).
                ("Sync", ms("2026-11-04T13:00:00Z")),
                ("Review", ms("2026-11-04T16:00:00Z")),
                // 5th: moved from 09:30 to 11:00.
                ("Standup (moved)", ms("2026-11-05T10:00:00Z")),
                ("Standup", ms("2026-11-06T08:30:00Z")),
            ]
        );
        let standup = &parsed.occurrences[0];
        assert_eq!(standup.end - standup.start, 15 * 60 * 1000);
        assert_eq!(standup.location, "Room 4");
        assert_eq!(standup.link.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x"));
        assert_eq!(parsed.occurrences[1].link.as_deref(), Some("https://us02web.zoom.us/j/123456789?pwd=abc"));
        assert_eq!(parsed.occurrences[2].link.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!(parsed.occurrences[2].end - parsed.occurrences[2].start, 3_600_000);
    }

    #[test]
    fn floating_until_and_dates_are_made_utc() {
        let paris = Tz::Tz(chrono_tz::Europe::Paris);
        assert_eq!(normalise_until("FREQ=DAILY;UNTIL=20261231T235959", paris), "FREQ=DAILY;UNTIL=20261231T225959Z");
        assert_eq!(normalise_until("FREQ=WEEKLY;UNTIL=20260701", paris), "FREQ=WEEKLY;UNTIL=20260701T215959Z");
        assert_eq!(normalise_until("FREQ=DAILY;UNTIL=20261231T000000Z", paris), "FREQ=DAILY;UNTIL=20261231T000000Z");
    }

    #[test]
    fn not_a_calendar_is_an_error() {
        assert!(parse_ics("<html>nope</html>", 0, 1).is_err());
    }

    #[test]
    fn meeting_links_are_found() {
        assert_eq!(
            find_meeting_link("Click here <https://zoom.us/j/999>. Thanks"),
            Some("https://zoom.us/j/999".into())
        );
        assert_eq!(find_meeting_link("https://example.com/x and https://acme.webex.com/meet/bob."), Some("https://acme.webex.com/meet/bob".into()));
        assert_eq!(find_meeting_link("https://teams.live.com/meet/123"), Some("https://teams.live.com/meet/123".into()));
        assert_eq!(find_meeting_link("no link, https://notzoom.us.example.com/j/1"), None);
        assert_eq!(find_meeting_link("https://evilzoom.us/j/1"), None);
        assert_eq!(find_meeting_link(""), None);
    }

    fn m(title: &str, start: i64, end: i64) -> Meeting {
        Meeting { title: title.into(), start, end, link: None, location: String::new() }
    }

    #[test]
    fn the_ongoing_meeting_wins_else_the_next_today() {
        let list = vec![m("allday-ish", 0, 1000), m("a", 100, 200), m("b", 300, 400), m("tomorrow", 900, 950)];
        assert_eq!(choose(&list, 150, 800).unwrap().title, "a");
        // A long block still going wins over the next short one.
        assert_eq!(choose(&list, 250, 800).unwrap().title, "allday-ish");
        assert_eq!(choose(&list, 500, 800).unwrap().title, "allday-ish");
        let short = vec![m("a", 100, 200), m("b", 300, 400), m("tomorrow", 900, 950)];
        assert_eq!(choose(&short, 450, 800), None);
        assert_eq!(choose(&short, 450, 1000).unwrap().title, "tomorrow");
        assert_eq!(choose(&short, 200, 800).unwrap().title, "b");
    }

    #[test]
    fn the_next_boundary_is_a_start_an_end_or_midnight() {
        let list = vec![m("a", 100, 200), m("b", 300, 400)];
        assert_eq!(next_boundary(&list, 50, 800), 100);
        assert_eq!(next_boundary(&list, 150, 800), 200);
        assert_eq!(next_boundary(&list, 200, 800), 300);
        assert_eq!(next_boundary(&list, 450, 800), 800);
    }

    #[test]
    fn durations_and_offsets_parse() {
        assert_eq!(parse_duration("PT1H30M"), Some(5400));
        assert_eq!(parse_duration("P1D"), Some(86_400));
        assert_eq!(parse_duration("P1W"), Some(604_800));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
        assert_eq!(parse_duration("P1DT2H"), Some(93_600));
        assert_eq!(parse_duration("bogus"), None);
        assert_eq!(utc_offset("+0530"), Some(19_800));
        assert_eq!(utc_offset("-0800"), Some(-28_800));
    }

    #[test]
    fn tzids_resolve() {
        let none = HashMap::new();
        assert_eq!(resolve_tzid("Europe/Berlin", &none).unwrap().name(), "Europe/Berlin");
        assert_eq!(resolve_tzid("/mozilla.org/20050126_1/Europe/Berlin", &none).unwrap().name(), "Europe/Berlin");
        assert_eq!(resolve_tzid("W. Europe Standard Time", &none).unwrap().name(), "Europe/Berlin");
        assert_eq!(resolve_tzid("FLE Standard Time", &none).unwrap().name(), "Europe/Kyiv");
        let offsets = HashMap::from([("Mine".to_string(), 7200)]);
        assert_eq!(resolve_tzid("Mine", &offsets).unwrap().name(), "Etc/GMT-2");
        assert!(resolve_tzid("Nowhere", &none).is_none());
    }

    #[test]
    fn webcal_links_become_https() {
        assert_eq!(normalise_url("webcal://p01-caldav.icloud.com/x.ics").unwrap().as_str(), "https://p01-caldav.icloud.com/x.ics");
        assert_eq!(normalise_url(" WEBCALS://Example.com/A.ics ").unwrap().as_str(), "https://example.com/A.ics");
        assert!(normalise_url("file:///etc/passwd").is_err());
        assert!(normalise_url("").is_err());
    }
}
