// The notch's system glance: CPU, memory, battery and network speed, sampled
// only while the island asks for it.
//
// One thread, started by glance_watch(true): it samples, emits, and sleeps 2 s
// on a channel, so glance_watch(false) wakes and ends it at once. Off, nothing
// runs and nothing is kept.

use serde::Serialize;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const EVENT: &str = "system-glance";
const PERIOD: Duration = Duration::from_secs(2);
/// sysinfo needs two CPU samples this far apart for a first reading.
const FIRST_SAMPLE: Duration = Duration::from_millis(250);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

/// Also the `system-glance` event payload.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Glance {
    /// 0–100, whole machine.
    pub cpu: f32,
    pub ram_used: u64,
    pub ram_total: u64,
    /// None on a desktop without a battery.
    pub battery: Option<Battery>,
    /// Bytes per second, all interfaces.
    pub net_down: u64,
    pub net_up: u64,
}

/// The running sampler's stop line; None when off.
static RUNNING: Mutex<Option<Sender<()>>> = Mutex::new(None);

/// While on, a `system-glance` event every 2 s. Off: nothing is sampled.
#[tauri::command]
pub fn glance_watch(app: AppHandle, on: bool) {
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if !on {
        // Dropping the sender wakes the thread, which ends.
        running.take();
        return;
    }
    if running.is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name("pod-glance".into()).spawn(move || {
        let mut sampler = Sampler::new();
        let mut wait = FIRST_SAMPLE;
        loop {
            match rx.recv_timeout(wait) {
                Err(RecvTimeoutError::Timeout) => {}
                // Stopped (sender dropped) or told to.
                _ => break,
            }
            let _ = app.emit(EVENT, sampler.sample());
            wait = PERIOD;
        }
    });
    match spawned {
        Ok(_) => *running = Some(tx),
        Err(err) => crate::log::line(format!("glance: no sampler thread: {err}")),
    }
}

struct Sampler {
    sys: sysinfo::System,
    nets: sysinfo::Networks,
    last: Instant,
}

impl Sampler {
    fn new() -> Sampler {
        let mut sys = sysinfo::System::new();
        sys.refresh_cpu_usage();
        Sampler { sys, nets: sysinfo::Networks::new_with_refreshed_list(), last: Instant::now() }
    }

    fn sample(&mut self) -> Glance {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        let now = Instant::now();
        let elapsed = now.duration_since(self.last);
        self.last = now;
        let (mut down, mut up) = (0u64, 0u64);
        for (name, data) in self.nets.list() {
            if counts(name) {
                down = down.saturating_add(data.received());
                up = up.saturating_add(data.transmitted());
            }
        }
        Glance {
            cpu: self.sys.global_cpu_usage().clamp(0.0, 100.0),
            ram_used: self.sys.used_memory(),
            ram_total: self.sys.total_memory(),
            battery: battery(),
            net_down: per_second(down, elapsed),
            net_up: per_second(up, elapsed),
        }
    }
}

/// Bytes moved over `elapsed` → bytes per second (0 for no time at all).
pub fn per_second(bytes: u64, elapsed: Duration) -> u64 {
    let ms = elapsed.as_millis();
    if ms == 0 {
        return 0;
    }
    (bytes as u128 * 1000 / ms).min(u64::MAX as u128) as u64
}

/// Real interfaces only: loopback, VM, container and VPN-tunnel adapters would
/// count the same traffic twice (or traffic that never leaves the machine).
pub fn counts(interface: &str) -> bool {
    let n = interface.to_ascii_lowercase();
    const SKIP_PREFIX: [&str; 13] = [
        "loopback", "vethernet", "docker", "veth", "br-", "virbr", "vmnet", "vboxnet", "tailscale", "wg",
        "tun", "tap", "zt",
    ];
    const SKIP_ANYWHERE: [&str; 6] = ["virtual", "hyper-v", "wsl", "pseudo-interface", "vmware", "virtualbox"];
    !(n == "lo" || SKIP_PREFIX.iter().any(|p| n.starts_with(p)) || SKIP_ANYWHERE.iter().any(|p| n.contains(p)))
}

#[cfg(windows)]
fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.ok()?;
    // 128: no system battery; 255: unknown.
    if status.BatteryFlag & 128 != 0 || status.BatteryFlag == 255 || status.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery { percent: status.BatteryLifePercent, charging: status.BatteryFlag & 8 != 0 })
}

#[cfg(not(windows))]
fn battery() -> Option<Battery> {
    let dir = std::fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in dir.flatten() {
        let path = entry.path();
        let read = |name: &str| std::fs::read_to_string(path.join(name)).map(|s| s.trim().to_string()).ok();
        if read("type").as_deref() != Some("Battery") {
            continue;
        }
        // A mouse or a headset reports its battery here too, scoped "Device".
        if read("scope").as_deref() == Some("Device") {
            continue;
        }
        let Some(percent) = read("capacity").and_then(|s| s.parse::<u8>().ok()) else { continue };
        let charging = read("status").as_deref() == Some("Charging");
        return Some(Battery { percent: percent.min(100), charging });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_rate_is_bytes_per_second() {
        assert_eq!(per_second(4000, Duration::from_secs(2)), 2000);
        assert_eq!(per_second(1500, Duration::from_millis(500)), 3000);
        assert_eq!(per_second(123, Duration::ZERO), 0);
        assert_eq!(per_second(0, Duration::from_secs(2)), 0);
        assert_eq!(per_second(u64::MAX, Duration::from_millis(1)), u64::MAX);
    }

    #[test]
    fn loopback_and_virtual_interfaces_are_left_out() {
        for skip in ["lo", "Loopback Pseudo-Interface 1", "vEthernet (WSL)", "docker0", "veth12ab", "virbr0", "tailscale0"] {
            assert!(!counts(skip), "{skip}");
        }
        for keep in ["Wi-Fi", "Ethernet", "eth0", "wlp2s0", "enp3s0"] {
            assert!(counts(keep), "{keep}");
        }
    }

    #[test]
    fn a_sample_is_sane() {
        let mut s = Sampler::new();
        std::thread::sleep(FIRST_SAMPLE);
        let g = s.sample();
        assert!(g.ram_total > 0 && g.ram_used <= g.ram_total);
        assert!((0.0..=100.0).contains(&g.cpu));
    }
}
