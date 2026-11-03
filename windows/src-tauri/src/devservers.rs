// Dev servers, for the notch's right side: local TCP ports something is
// listening on that look like a development server (3000, 5173, 8000, 8080…, or
// any port held by node, python, deno, bun, ruby, php, java, dotnet, go…).
//
// Windows reads the listening sockets with GetExtendedTcpTable and the owner's
// image name with QueryFullProcessImageNameW; Linux reads /proc/net/tcp{,6} and
// matches socket inodes to processes through /proc/<pid>/fd. Either takes a few
// milliseconds. The watch runs only while the page asks for it, every 5 s, and
// tells the page only when the list changed.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Also the `dev-servers` event payload (a list).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevServer {
    pub port: u16,
    pub pid: u32,
    /// Process name without ".exe" ("node", "python"…).
    pub process: String,
    /// "http://localhost:5173".
    pub url: String,
}

const PERIOD: Duration = Duration::from_secs(5);

/// The watch's generation: bumped on every start and stop, so a thread from an
/// earlier watch sees it is no longer wanted and ends.
static WATCH: Mutex<(bool, u64)> = Mutex::new((false, 0));
static WAKE: Condvar = Condvar::new();

/// Starts/stops watching; while on, `dev-servers` is sent when the list changes
/// (checked every 5 s, only while on).
#[tauri::command]
pub fn devservers_watch(app: AppHandle, on: bool) {
    let mut watch = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    if watch.0 == on {
        return;
    }
    watch.0 = on;
    watch.1 = watch.1.wrapping_add(1);
    let gen = watch.1;
    WAKE.notify_all();
    drop(watch);
    if on {
        std::thread::spawn(move || watch_loop(app, gen));
    }
}

#[tauri::command]
pub fn devservers_now() -> Vec<DevServer> {
    scan()
}

/// Opens the server's URL in the default browser.
#[tauri::command]
pub fn devserver_open(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("no port".into());
    }
    crate::platform::open_url(&url_for(port));
    Ok(())
}

fn watch_loop(app: AppHandle, gen: u64) {
    let mut last: Option<Vec<DevServer>> = None;
    loop {
        let now = scan();
        if last.as_ref() != Some(&now) {
            let _ = app.emit("dev-servers", &now);
            last = Some(now);
        }
        let watch = WATCH.lock().unwrap_or_else(|e| e.into_inner());
        let (watch, _) = WAKE
            .wait_timeout_while(watch, PERIOD, |w| w.0 && w.1 == gen)
            .unwrap_or_else(|e| e.into_inner());
        if !watch.0 || watch.1 != gen {
            return;
        }
    }
}

fn url_for(port: u16) -> String {
    format!("http://localhost:{port}")
}

// ── Which listeners are dev servers ───────────────────────────────────────────

/// A listening socket and the process holding it.
#[derive(Debug, Clone)]
struct Listener {
    addr: IpAddr,
    port: u16,
    pid: u32,
}

/// Runtimes and tools that serve a project while it is being built. Any port
/// they hold below the ephemeral range counts.
const DEV_RUNTIMES: &[&str] = &[
    "node", "nodejs", "deno", "bun", "python", "python3", "pythonw", "py", "ruby", "php", "php-cgi",
    "java", "javaw", "dotnet", "go", "cargo", "vite", "uvicorn", "gunicorn", "hypercorn", "flask",
    "rails", "puma", "hugo", "jekyll", "beam.smp", "erl", "elixir", "iex", "mix", "esbuild",
    "webpack", "next-server", "air", "trunk", "zola", "miniserve", "http-server", "serve", "caddy",
    "pnpm", "npm", "yarn", "tsx", "ts-node", "wrangler", "workerd", "streamlit", "jupyter-lab",
    "jupyter-notebook",
];

/// Never a dev server, whatever port: the system and everyday apps.
const NOT_DEV: &[&str] = &[
    "system", "idle", "svchost", "lsass", "services", "wininit", "csrss", "smss", "spoolsv",
    "searchhost", "searchindexer", "explorer", "msedge", "msedgewebview2", "chrome", "firefox",
    "spotify", "steam", "discord", "teams", "ms-teams", "onedrive", "dropbox", "zoom", "slack",
    "systemd", "systemd-resolved", "sshd", "cupsd", "avahi-daemon", "dnsmasq", "rpcbind",
    "postgres", "mysqld", "mariadbd", "redis-server", "mongod", "pod",
];

/// Ports that are never a web page to open (databases, remote desktop, the
/// Node inspector…), even when a dev runtime holds them. Postgres side
/// instances (5430-5449) are checked in `is_not_http`.
const NOT_HTTP_PORTS: &[u16] = &[
    3306, 3389, 5037, 5040, 5353, 5355, 5357, 5432, 5433, 5672, 5900, 5985, 5986, 6379, 6380, 9229,
    11211, 27017,
];

/// Ports development servers usually pick.
fn is_dev_port(port: u16) -> bool {
    matches!(port, 1313 | 1420 | 3000..=3999 | 4000 | 4173 | 4200 | 4321 | 4567 | 5000..=5999 | 6006 | 7860 | 8000..=8999)
}

/// "C:\\Program Files\\nodejs\\node.exe" or "/usr/bin/node" → "node".
fn process_name(image: &str) -> String {
    let base = image.rsplit(['/', '\\']).next().unwrap_or(image);
    let lower = base.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(stem) => base[..stem.len()].to_string(),
        None => base.to_string(),
    }
}

/// Something a browser can reach at localhost: loopback or every address.
fn is_local(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_unspecified() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_unspecified() || v4.is_loopback())
        }
    }
}

/// A port that is never a web page.
fn is_not_http(port: u16) -> bool {
    NOT_HTTP_PORTS.contains(&port) || (5430..=5449).contains(&port)
}

/// Whether the listener `port`, held by `pid` running `image` (its full path,
/// empty when unknown), is shown as a dev server. Port forwarders (wslrelay,
/// Docker) count on dev ports only, like any other program.
fn keep(port: u16, pid: u32, image: &str, own_pid: u32) -> bool {
    if pid == own_pid || pid <= 4 || image.is_empty() || port < 1024 || is_not_http(port) {
        return false;
    }
    let name = process_name(image).to_ascii_lowercase();
    if NOT_DEV.contains(&name.as_str()) {
        return false;
    }
    let path = image.replace('\\', "/").to_ascii_lowercase();
    // Windows' own services live in C:\Windows (wslrelay does not).
    if path.contains(":/windows/") {
        return false;
    }
    if DEV_RUNTIMES.contains(&name.as_str()) {
        // Below the ephemeral ports, where workers and debuggers pick theirs.
        return port < 32768;
    }
    is_dev_port(port)
}

/// The dev servers among `listeners`, one per port, sorted by port.
fn filter(listeners: Vec<Listener>, image_of: &mut dyn FnMut(u32) -> String, own_pid: u32) -> Vec<DevServer> {
    let mut images: HashMap<u32, String> = HashMap::new();
    let mut by_port: HashMap<u16, DevServer> = HashMap::new();
    for l in listeners {
        if !is_local(&l.addr) || by_port.contains_key(&l.port) {
            continue;
        }
        let image = images.entry(l.pid).or_insert_with(|| image_of(l.pid)).clone();
        if keep(l.port, l.pid, &image, own_pid) {
            by_port.insert(
                l.port,
                DevServer { port: l.port, pid: l.pid, process: process_name(&image), url: url_for(l.port) },
            );
        }
    }
    let mut out: Vec<DevServer> = by_port.into_values().collect();
    out.sort_by_key(|s| s.port);
    out
}

fn scan() -> Vec<DevServer> {
    filter(os::listeners(), &mut os::image_of, std::process::id())
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod os {
    use super::*;
    use ::windows::core::PWSTR;
    use ::windows::Win32::Foundation::CloseHandle;
    use ::windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    /// The raw table for one address family; u64s keep the rows aligned.
    fn table(family: u32) -> Option<Vec<u64>> {
        let mut size = 0u32;
        unsafe { GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) };
        // Sockets can open between the two calls: a few tries with room to spare.
        for _ in 0..4 {
            let mut buf = vec![0u64; (size as usize + 1024) / 8 + 1];
            let mut len = (buf.len() * 8) as u32;
            let ret = unsafe {
                GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut len, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
            };
            match ret {
                0 => return Some(buf),
                ERROR_INSUFFICIENT_BUFFER => size = len,
                _ => return None,
            }
        }
        None
    }

    /// Rows of a MIB_TCP(6)TABLE_OWNER_PID: a u32 count, then the rows, which
    /// are made of u32s and so start right after it.
    fn rows<T: Copy>(buf: &[u64]) -> Vec<T> {
        let bytes = buf.len() * 8;
        let base = buf.as_ptr().cast::<u8>();
        let count = unsafe { base.cast::<u32>().read_unaligned() } as usize;
        let size = std::mem::size_of::<T>();
        let count = count.min(bytes.saturating_sub(4) / size);
        (0..count).map(|i| unsafe { base.add(4 + i * size).cast::<T>().read_unaligned() }).collect()
    }

    pub fn listeners() -> Vec<Listener> {
        let mut out = Vec::new();
        if let Some(buf) = table(AF_INET) {
            for row in rows::<MIB_TCPROW_OWNER_PID>(&buf) {
                out.push(Listener {
                    addr: IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes())),
                    port: u16::from_be(row.dwLocalPort as u16),
                    pid: row.dwOwningPid,
                });
            }
        }
        if let Some(buf) = table(AF_INET6) {
            for row in rows::<MIB_TCP6ROW_OWNER_PID>(&buf) {
                out.push(Listener {
                    addr: IpAddr::V6(Ipv6Addr::from(row.ucLocalAddr)),
                    port: u16::from_be(row.dwLocalPort as u16),
                    pid: row.dwOwningPid,
                });
            }
        }
        out
    }

    /// The process's executable path, empty when it can't be read (system
    /// processes, another user's).
    pub fn image_of(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(handle);
            if ok {
                String::from_utf16_lossy(&buf[..len as usize])
            } else {
                String::new()
            }
        }
    }
}

// ── Linux ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use std::collections::HashSet;

    pub fn listeners() -> Vec<Listener> {
        let mut sockets = Vec::new();
        for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
            if let Ok(text) = std::fs::read_to_string(file) {
                sockets.extend(parse_proc_net_tcp(&text, v6));
            }
        }
        // Only the candidates are worth finding an owner for.
        sockets.retain(|(addr, port, _)| is_local(addr) && *port >= 1024 && !is_not_http(*port));
        if sockets.is_empty() {
            return Vec::new();
        }
        let wanted: HashSet<u64> = sockets.iter().map(|(_, _, inode)| *inode).collect();
        let owners = owners_of(&wanted);
        sockets
            .into_iter()
            .filter_map(|(addr, port, inode)| Some(Listener { addr, port, pid: *owners.get(&inode)? }))
            .collect()
    }

    /// Socket inode → pid, from the fds of the processes we may read (our own
    /// user's, which is where dev servers run). Stops once all are found.
    fn owners_of(wanted: &HashSet<u64>) -> HashMap<u64, u32> {
        let mut found = HashMap::new();
        let Ok(procs) = std::fs::read_dir("/proc") else { return found };
        for entry in procs.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else { continue };
            for fd in fds.flatten() {
                let Ok(link) = std::fs::read_link(fd.path()) else { continue };
                let link = link.to_string_lossy();
                let Some(inode) = link.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')) else { continue };
                if let Ok(inode) = inode.parse::<u64>() {
                    if wanted.contains(&inode) {
                        found.insert(inode, pid);
                    }
                }
            }
            if found.len() == wanted.len() {
                break;
            }
        }
        found
    }

    /// The executable's path, else its short name; empty when unreadable.
    pub fn image_of(pid: u32) -> String {
        if let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) {
            return exe.to_string_lossy().into_owned();
        }
        std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_string()).unwrap_or_default()
    }
}

/// Listening sockets in a /proc/net/tcp or tcp6 table: (address, port, inode).
/// Addresses are the kernel's words printed in hex, in the machine's order.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<(IpAddr, u16, u64)> {
    const LISTEN: &str = "0A";
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != LISTEN {
            continue;
        }
        let Some((addr, port)) = fields[1].split_once(':') else { continue };
        let Ok(port) = u16::from_str_radix(port, 16) else { continue };
        let Ok(inode) = fields[9].parse::<u64>() else { continue };
        let words: Option<Vec<[u8; 4]>> = (0..addr.len() / 8)
            .map(|i| addr.get(i * 8..i * 8 + 8).and_then(|w| u32::from_str_radix(w, 16).ok()).map(u32::to_ne_bytes))
            .collect();
        let Some(words) = words else { continue };
        let ip = match (v6, words.as_slice()) {
            (false, [w]) => IpAddr::V4(Ipv4Addr::from(*w)),
            (true, [a, b, c, d]) => {
                let mut bytes = [0u8; 16];
                for (i, w) in [a, b, c, d].iter().enumerate() {
                    bytes[i * 4..i * 4 + 4].copy_from_slice(&w[..]);
                }
                IpAddr::V6(Ipv6Addr::from(bytes))
            }
            _ => continue,
        };
        out.push((ip, port, inode));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: u32 = 999;

    #[test]
    fn process_names_lose_their_folder_and_exe() {
        assert_eq!(process_name(r"C:\Program Files\nodejs\node.exe"), "node");
        assert_eq!(process_name(r"C:\Python312\Python.EXE"), "Python");
        assert_eq!(process_name("/usr/bin/python3"), "python3");
        assert_eq!(process_name("beam.smp"), "beam.smp");
    }

    #[test]
    fn dev_runtimes_count_on_any_port_and_others_on_dev_ports() {
        assert!(keep(5173, 10, r"C:\Program Files\nodejs\node.exe", ME));
        assert!(keep(24678, 10, "/usr/bin/node", ME));
        assert!(keep(8080, 10, r"D:\proj\target\debug\api.exe", ME));
        assert!(keep(1420, 10, "/home/me/app/target/debug/app", ME));
        assert!(keep(3000, 10, r"C:\Program Files\WSL\wslrelay.exe", ME));
        // A forwarded Redis is not.
        assert!(!keep(6391, 10, r"C:\Program Files\WSL\wslrelay.exe", ME));
        // A random app on a random port is not a dev server.
        assert!(!keep(27036, 10, r"C:\Games\Steam\steamservice.exe", ME));
        // Workers and debuggers above the ephemeral line.
        assert!(!keep(50123, 10, "/usr/bin/node", ME));
        assert!(!keep(9229, 10, "/usr/bin/node", ME));
    }

    #[test]
    fn system_processes_databases_and_pod_are_left_out() {
        assert!(!keep(5040, 1200, r"C:\Windows\System32\svchost.exe", ME));
        assert!(!keep(5357, 4, "", ME));
        assert!(!keep(8000, 1200, r"C:\Windows\System32\something.exe", ME));
        assert!(!keep(5432, 10, "/usr/lib/postgresql/16/bin/postgres", ME));
        assert!(!keep(5433, 10, r"C:\Program Files\Docker\com.docker.backend.exe", ME));
        assert!(!keep(5442, 10, r"C:\Program Files\WSL\wslrelay.exe", ME));
        assert!(!keep(3389, 10, r"C:\Tools\rdp.exe", ME));
        assert!(!keep(5173, ME, r"C:\Program Files\Pod\pod.exe", ME));
        assert!(!keep(5173, 10, "", ME));
        assert!(!keep(80, 10, "/usr/bin/node", ME));
    }

    #[test]
    fn listeners_are_local_only_deduped_by_port_and_sorted() {
        let any4 = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        let lo6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        let lan = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let listeners = vec![
            Listener { addr: any4, port: 8000, pid: 20 },
            Listener { addr: lo6, port: 5173, pid: 10 },
            Listener { addr: any4, port: 5173, pid: 10 },
            Listener { addr: lan, port: 3000, pid: 30 },
            Listener { addr: any4, port: 5432, pid: 40 },
        ];
        let mut calls = 0;
        let mut image_of = |pid: u32| {
            calls += 1;
            match pid {
                10 => r"C:\Program Files\nodejs\node.exe".to_string(),
                20 => r"C:\Python312\python.exe".to_string(),
                _ => r"C:\Program Files\PostgreSQL\bin\postgres.exe".to_string(),
            }
        };
        let servers = filter(listeners, &mut image_of, ME);
        assert_eq!(
            servers,
            vec![
                DevServer { port: 5173, pid: 10, process: "node".into(), url: "http://localhost:5173".into() },
                DevServer { port: 8000, pid: 20, process: "python".into(), url: "http://localhost:8000".into() },
            ]
        );
        // Each process is looked up once.
        assert_eq!(calls, 3);
    }

    /// Reads this machine's real table: `cargo test -p pod --lib devservers -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scans_this_machine() {
        let all = os::listeners();
        assert!(!all.is_empty(), "no listening socket at all");
        println!("{} listening sockets", all.len());
        for server in scan() {
            println!("{server:?}");
        }
    }

    #[test]
    fn local_addresses() {
        assert!(is_local(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_local(&IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        assert!(is_local(&IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped())));
        assert!(!is_local(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))));
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn proc_net_tcp_tables_are_read() {
        let v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41235 1 0000000000000000 100 0 0 10 0\n\
   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41236 1 0000000000000000 20 4 30 10 -1\n";
        assert_eq!(
            parse_proc_net_tcp(v4, false),
            vec![
                (IpAddr::V4(Ipv4Addr::LOCALHOST), 5173, 41234),
                (IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8000, 41235),
            ]
        );
        let v6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 51234 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(parse_proc_net_tcp(v6, true), vec![(IpAddr::V6(Ipv6Addr::LOCALHOST), 3000, 51234)]);
    }
}
