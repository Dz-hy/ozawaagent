use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::runtime::platform::strip_windows_verbatim_prefix;
use crate::runtime::process::{configure_child_process_group, terminate_child_process_tree};

pub const GA_RUNTIME_STATUS_EVENT: &str = "ga-runtime:status";
const PINNED_MANIFEST: &str = include_str!("../../../../../runtime/ga/runtime_manifest.json");
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_GRACE: Duration = Duration::from_secs(2);
const MAX_RESTARTS: u8 = 2;

#[derive(Debug, Clone, Deserialize)]
struct RuntimeManifest {
    ga_commit: String,
    official_bridge: BridgeManifest,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgeManifest {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct GaRuntimeLaunch {
    pub python: PathBuf,
    /// Immutable source/resource root used for manifest and bridge validation.
    pub ga_root: PathBuf,
    /// Writable per-user root used by bundled GenericAgent, if applicable.
    pub data_root: Option<PathBuf>,
    pub adapter: PathBuf,
    pub manifest: PathBuf,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GaRuntimePhase {
    Stopped,
    Starting,
    Running,
    Restarting,
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaRuntimeStatus {
    pub phase: GaRuntimePhase,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub ga_root: Option<String>,
    pub runtime_kind: Option<String>,
    pub restart_count: u8,
    pub last_error: Option<String>,
    pub log_path: Option<String>,
    pub generation: u64,
}

impl Default for GaRuntimeStatus {
    fn default() -> Self {
        Self {
            phase: GaRuntimePhase::Stopped,
            port: None,
            pid: None,
            ga_root: None,
            runtime_kind: None,
            restart_count: 0,
            last_error: None,
            log_path: None,
            generation: 0,
        }
    }
}

struct RuntimeProcess {
    child: Child,
    launch: GaRuntimeLaunch,
    token: String,
    origin: String,
    port: u16,
}

pub struct GaRuntimeSupervisor {
    process: Mutex<Option<RuntimeProcess>>,
    status: Mutex<GaRuntimeStatus>,
    app: Mutex<Option<tauri::AppHandle>>,
    log_dir: PathBuf,
}

impl Default for GaRuntimeSupervisor {
    fn default() -> Self {
        Self::new(default_log_dir())
    }
}

impl GaRuntimeSupervisor {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            status: Mutex::new(GaRuntimeStatus::default()),
            app: Mutex::new(None),
            log_dir,
        }
    }

    pub fn attach_app(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    pub fn status(&self) -> GaRuntimeStatus {
        self.status.lock().unwrap().clone()
    }

    fn publish(&self, status: GaRuntimeStatus) {
        *self.status.lock().unwrap() = status.clone();
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit(GA_RUNTIME_STATUS_EVENT, &status);
        }
    }

    pub fn discover(
        external_root: Option<&str>,
        bundled_root: Option<&Path>,
        bundled_data_root: Option<&Path>,
    ) -> Result<GaRuntimeLaunch, String> {
        let is_bundled = external_root.is_none()
            && std::env::var_os("GA_ROOT").is_none()
            && bundled_root.is_some();
        let root = external_root
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("GA_ROOT").map(PathBuf::from))
            .or_else(|| bundled_root.map(Path::to_path_buf))
            .or_else(|| {
                let p = PathBuf::from(r"D:\GenericAgent");
                p.is_dir().then_some(p)
            })
            .ok_or_else(|| {
                "GenericAgent runtime was not found. Set GA_ROOT to a compatible runtime directory."
                    .to_string()
            })?;
        let root = fs::canonicalize(&root)
            .map(strip_windows_verbatim_prefix)
            .map_err(|e| format!("GenericAgent path is not accessible: {e}"))?;
        let manifest = root.join("runtime_manifest.json");
        let manifest = if manifest.is_file() {
            manifest
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../runtime/ga/runtime_manifest.json")
        };
        let adapter = resolve_application_adapter(if is_bundled {
            Some(root.as_path())
        } else {
            bundled_root
        })?;
        let python = find_python(&root)?;
        validate_manifest(&root, &manifest)?;
        let data_root = if is_bundled {
            let path = bundled_data_root
                .ok_or_else(|| "Bundled GenericAgent data directory is unavailable".to_string())?;
            Some(
                fs::canonicalize(path)
                    .map(strip_windows_verbatim_prefix)
                    .unwrap_or_else(|_| strip_windows_verbatim_prefix(path.to_path_buf())),
            )
        } else {
            None
        };
        Ok(GaRuntimeLaunch {
            python,
            ga_root: root,
            data_root,
            adapter,
            manifest,
            extra_args: Vec::new(),
        })
    }

    pub fn start_with_credentials(
        self: &Arc<Self>,
        launch: GaRuntimeLaunch,
    ) -> Result<(GaRuntimeStatus, String), String> {
        let existing = self
            .process
            .lock()
            .unwrap()
            .as_ref()
            .map(|process| process.token.clone());
        if let Some(token) = existing {
            let deadline = Instant::now() + START_TIMEOUT;
            loop {
                let status = self.status();
                if status.phase == GaRuntimePhase::Running {
                    let port = self
                        .process
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|process| process.port)
                        .ok_or_else(|| "GA runtime process disappeared".to_string())?;
                    let mut current = status;
                    current.port = Some(port);
                    return Ok((current, token));
                }
                if status.phase != GaRuntimePhase::Restarting {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("GA runtime restart timed out; inspect the runtime log".into());
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        let status = self.start(launch)?;
        let token = self
            .process
            .lock()
            .unwrap()
            .as_ref()
            .map(|process| process.token.clone())
            .ok_or_else(|| "GA runtime credentials are unavailable".to_string())?;
        Ok((status, token))
    }

    pub fn start(self: &Arc<Self>, launch: GaRuntimeLaunch) -> Result<GaRuntimeStatus, String> {
        if self.process.lock().unwrap().is_some() {
            return Ok(self.status());
        }
        fs::create_dir_all(&self.log_dir)
            .map_err(|e| format!("Cannot create GA runtime log directory: {e}"))?;
        validate_manifest(&launch.ga_root, &launch.manifest)?;
        let port = reserve_loopback_port()?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let origin = "http://tauri.localhost".to_string();
        let generation = self.status().generation + 1;
        let log_path = self.log_dir.join(format!("ga-runtime-{generation}.log"));
        let child = spawn_runtime_child(&launch, port, &token, &origin, &log_path)?;
        let pid = child.id();
        let starting = GaRuntimeStatus {
            phase: GaRuntimePhase::Starting,
            port: Some(port),
            pid: Some(pid),
            ga_root: Some(
                launch
                    .data_root
                    .as_ref()
                    .unwrap_or(&launch.ga_root)
                    .to_string_lossy()
                    .into_owned(),
            ),
            runtime_kind: Some(
                if launch.data_root.is_some() {
                    "bundled"
                } else {
                    "external"
                }
                .into(),
            ),
            restart_count: 0,
            last_error: None,
            log_path: Some(log_path.to_string_lossy().into_owned()),
            generation,
        };
        self.publish(starting);
        *self.process.lock().unwrap() = Some(RuntimeProcess {
            child,
            launch,
            token,
            origin,
            port,
        });
        match self.wait_until_healthy(START_TIMEOUT) {
            Ok(()) => {
                let mut ready = self.status();
                ready.phase = GaRuntimePhase::Running;
                self.publish(ready.clone());
                self.spawn_monitor(generation);
                Ok(ready)
            }
            Err(error) => {
                self.stop_internal(Some(error.clone()));
                Err(error)
            }
        }
    }

    fn wait_until_healthy(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            {
                let mut guard = self.process.lock().unwrap();
                let process = guard
                    .as_mut()
                    .ok_or_else(|| "GA runtime stopped during startup".to_string())?;
                if let Some(exit) = process.child.try_wait().map_err(|e| e.to_string())? {
                    return Err(format!(
                        "GA runtime exited before health check succeeded ({exit})"
                    ));
                }
                if health_ok(process.port, &process.token, &process.origin) {
                    return Ok(());
                }
            }
            if started.elapsed() >= timeout {
                return Err("GA runtime health check timed out; inspect the runtime log".into());
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn spawn_monitor(self: &Arc<Self>, generation: u64) {
        let weak = Arc::downgrade(self);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(1));
            let Some(supervisor) = weak.upgrade() else {
                return;
            };
            let current = supervisor.status();
            if current.generation != generation || current.phase != GaRuntimePhase::Running {
                return;
            }
            let crashed = {
                let mut guard = supervisor.process.lock().unwrap();
                let exited = guard
                    .as_mut()
                    .and_then(|process| process.child.try_wait().ok().flatten());
                exited.and_then(|exit| guard.take().map(|process| (process, exit)))
            };
            let Some((mut process, exit)) = crashed else {
                continue;
            };
            let mut last_error = format!("GA runtime exited unexpectedly ({exit})");
            for attempt in 1..=MAX_RESTARTS {
                let port = match reserve_loopback_port() {
                    Ok(port) => port,
                    Err(error) => {
                        last_error = error;
                        continue;
                    }
                };
                let log_path = supervisor
                    .status()
                    .log_path
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        supervisor
                            .log_dir
                            .join(format!("ga-runtime-{generation}.log"))
                    });
                match spawn_runtime_child(
                    &process.launch,
                    port,
                    &process.token,
                    &process.origin,
                    &log_path,
                ) {
                    Ok(child) => {
                        let pid = child.id();
                        process.child = child;
                        process.port = port;
                        *supervisor.process.lock().unwrap() = Some(process);
                        let mut restarting = supervisor.status();
                        restarting.phase = GaRuntimePhase::Restarting;
                        restarting.port = Some(port);
                        restarting.pid = Some(pid);
                        restarting.restart_count = attempt;
                        restarting.last_error = Some(last_error.clone());
                        supervisor.publish(restarting);
                        match supervisor.wait_until_healthy(START_TIMEOUT) {
                            Ok(()) => {
                                let snapshot = supervisor.status();
                                if snapshot.generation != generation
                                    || snapshot.phase != GaRuntimePhase::Restarting
                                {
                                    return;
                                }
                                let mut ready = snapshot;
                                ready.phase = GaRuntimePhase::Running;
                                ready.last_error = None;
                                supervisor.publish(ready);
                                break;
                            }
                            Err(error) => {
                                last_error = error;
                                let Some(mut failed_process) =
                                    supervisor.process.lock().unwrap().take()
                                else {
                                    return;
                                };
                                let _ = terminate_child_process_tree(
                                    &mut failed_process.child,
                                    STOP_GRACE,
                                );
                                process = failed_process;
                            }
                        }
                    }
                    Err(error) => last_error = error,
                }
                if attempt == MAX_RESTARTS {
                    let mut failed = supervisor.status();
                    failed.phase = GaRuntimePhase::Failed;
                    failed.pid = None;
                    failed.port = None;
                    failed.restart_count = attempt;
                    failed.last_error = Some(last_error.clone());
                    supervisor.publish(failed);
                    return;
                }
            }
        });
    }

    fn stop_internal(&self, error: Option<String>) -> GaRuntimeStatus {
        let mut current = self.status();
        current.phase = GaRuntimePhase::Stopping;
        self.publish(current.clone());
        if let Some(mut process) = self.process.lock().unwrap().take() {
            let _ = terminate_child_process_tree(&mut process.child, STOP_GRACE);
        }
        current.phase = if error.is_some() {
            GaRuntimePhase::Failed
        } else {
            GaRuntimePhase::Stopped
        };
        current.pid = None;
        current.port = None;
        current.last_error = error;
        self.publish(current.clone());
        current
    }

    pub fn stop(&self) -> GaRuntimeStatus {
        self.stop_internal(None)
    }
}

impl Drop for GaRuntimeSupervisor {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut() {
            if let Some(mut process) = process.take() {
                let _ = terminate_child_process_tree(&mut process.child, STOP_GRACE);
            }
        }
    }
}

fn spawn_runtime_child(
    launch: &GaRuntimeLaunch,
    port: u16,
    token: &str,
    origin: &str,
    log_path: &Path,
) -> Result<Child, String> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Cannot open GA runtime log: {e}"))?;
    let mut command = Command::new(&launch.python);
    command.arg(&launch.adapter);
    command.arg("--ga-root").arg(&launch.ga_root);
    if let Some(data_root) = &launch.data_root {
        command.arg("--data-root").arg(data_root);
    }
    command
        .arg("--port")
        .arg(port.to_string())
        .args(&launch.extra_args)
        .env("GA_BRIDGE_TOKEN", token)
        .env("GA_BRIDGE_ALLOWED_ORIGINS", bridge_allowed_origins(origin))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    configure_child_process_group(&mut command);
    command
        .spawn()
        .map_err(|e| actionable_spawn_error(&launch.python, e))
}

fn resolve_application_adapter(resource_root: Option<&Path>) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../runtime/ga/ga_bridge_adapter.py");
        if source.is_file() {
            return fs::canonicalize(&source)
                .map(strip_windows_verbatim_prefix)
                .or(Ok(source));
        }
    }

    if let Some(root) = resource_root {
        let bundled = root.join("ga_bridge_adapter.py");
        if bundled.is_file() {
            return fs::canonicalize(&bundled)
                .map(strip_windows_verbatim_prefix)
                .or(Ok(bundled));
        }
    }

    Err("LiveAgent GA bridge adapter was not found in the application runtime".into())
}

fn bridge_allowed_origins(origin: &str) -> String {
    let mut origins = vec![origin.to_owned()];
    #[cfg(debug_assertions)]
    origins.extend(["http://127.0.0.1:1420", "http://localhost:1420"].map(str::to_owned));
    origins.join(",")
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("No loopback port is available for GA runtime: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

fn find_python(root: &Path) -> Result<PathBuf, String> {
    for candidate in [root.join("python/python.exe"), root.join("python.exe")] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    for name in ["python", "python3"] {
        if Command::new(name)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Ok(PathBuf::from(name));
        }
    }
    Err(
        "Python was not found. Install Python 3.12 or select a bundled GenericAgent runtime."
            .into(),
    )
}

fn validate_manifest(root: &Path, manifest_path: &Path) -> Result<(), String> {
    let expected: RuntimeManifest = serde_json::from_str(PINNED_MANIFEST)
        .map_err(|e| format!("Embedded runtime manifest is invalid: {e}"))?;
    let actual_text = fs::read_to_string(manifest_path)
        .map_err(|e| format!("Runtime manifest is missing: {e}"))?;
    let actual: RuntimeManifest = serde_json::from_str(&actual_text)
        .map_err(|e| format!("Runtime manifest is invalid: {e}"))?;
    if actual.ga_commit != expected.ga_commit
        || actual.official_bridge.sha256 != expected.official_bridge.sha256
    {
        return Err(format!(
            "GenericAgent runtime is incompatible; expected commit {}",
            expected.ga_commit
        ));
    }
    let bridge = root.join(&actual.official_bridge.path);
    let bytes = fs::read(&bridge).map_err(|e| format!("Official GA bridge is missing: {e}"))?;
    let digest = Sha256::digest(bytes);
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest_hex != actual.official_bridge.sha256 {
        return Err("Official GA bridge hash does not match the runtime manifest".into());
    }
    Ok(())
}

fn health_ok(port: u16, token: &str, origin: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .ok()
        .and_then(|c| {
            c.get(format!("http://127.0.0.1:{port}/api/v1/health"))
                .bearer_auth(token)
                .header("Origin", origin)
                .send()
                .ok()
        })
        .is_some_and(|r| r.status().is_success())
}

fn actionable_spawn_error(python: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("Python executable was not found: {}", python.display())
    } else {
        format!(
            "Failed to start GA runtime with {}: {error}",
            python.display()
        )
    }
}

pub fn default_log_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("LiveAgent")
        .join("ga-runtime-logs")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dynamic_ports_are_loopback_and_nonzero() {
        assert_ne!(reserve_loopback_port().unwrap(), 0);
    }
    #[test]
    fn bridge_allowed_origins_preserves_runtime_origin_and_scopes_dev_origins() {
        let value = bridge_allowed_origins("http://tauri.localhost");
        let origins = value.split(',').collect::<Vec<_>>();
        assert_eq!(origins.first(), Some(&"http://tauri.localhost"));
        #[cfg(debug_assertions)]
        {
            assert!(origins.contains(&"http://127.0.0.1:1420"));
            assert!(origins.contains(&"http://localhost:1420"));
        }
        #[cfg(not(debug_assertions))]
        assert_eq!(origins, ["http://tauri.localhost"]);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_adapter_is_not_taken_from_external_runtime_root() {
        let external = tempfile::tempdir().unwrap();
        let stale = external.path().join("ga_bridge_adapter.py");
        fs::write(&stale, b"# stale external adapter").unwrap();

        let selected = resolve_application_adapter(Some(external.path())).unwrap();
        assert_ne!(selected, fs::canonicalize(stale).unwrap());
        assert!(selected.ends_with("runtime/ga/ga_bridge_adapter.py"));
    }

    #[test]
    fn incompatible_manifest_is_actionable() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("runtime_manifest.json");
        fs::write(
            &manifest,
            r#"{"ga_commit":"wrong","official_bridge":{"path":"x","sha256":"wrong"}}"#,
        )
        .unwrap();
        assert!(validate_manifest(dir.path(), &manifest)
            .unwrap_err()
            .contains("incompatible"));
    }
    #[test]
    fn mock_runtime_starts_healthy_and_stops_in_unicode_path() {
        let root = tempfile::Builder::new()
            .prefix("GA 测试 space ")
            .tempdir()
            .unwrap();
        let script = root.path().join("mock adapter.py");
        fs::write(
            &script,
            r#"import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
p=argparse.ArgumentParser(); p.add_argument('--ga-root'); p.add_argument('--port',type=int); a=p.parse_args()
class H(BaseHTTPRequestHandler):
 def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',a.port),H).serve_forever()
"#,
        )
        .unwrap();
        let launch = GaRuntimeLaunch {
            python: find_python(root.path()).unwrap(),
            ga_root: root.path().to_path_buf(),
            data_root: None,
            adapter: script,
            manifest: PathBuf::new(),
            extra_args: Vec::new(),
        };
        let port = reserve_loopback_port().unwrap();
        let log = root.path().join("runtime log.txt");
        let mut child =
            spawn_runtime_child(&launch, port, "test-token", "http://tauri.localhost", &log)
                .unwrap();
        let started = Instant::now();
        while !health_ok(port, "test-token", "http://tauri.localhost") {
            assert!(started.elapsed() < Duration::from_secs(10));
            thread::sleep(Duration::from_millis(50));
        }
        let pid = child.id();
        terminate_child_process_tree(&mut child, STOP_GRACE).unwrap();
        assert!(
            child.try_wait().unwrap().is_some(),
            "owned child {pid} must be reaped"
        );
    }

    #[test]
    fn crashed_owned_runtime_restarts_and_becomes_healthy() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("crash_then_serve.py");
        let marker = root.path().join("started.marker");
        fs::write(
            &script,
            r#"import argparse, pathlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
p=argparse.ArgumentParser(); p.add_argument('--ga-root'); p.add_argument('--port',type=int); p.add_argument('--marker'); a=p.parse_args()
m=pathlib.Path(a.marker)
if not m.exists(): m.write_text('1'); sys.exit(17)
class H(BaseHTTPRequestHandler):
 def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',a.port),H).serve_forever()
"#,
        )
        .unwrap();
        let launch = GaRuntimeLaunch {
            python: find_python(root.path()).unwrap(),
            ga_root: root.path().to_path_buf(),
            data_root: None,
            adapter: script,
            manifest: PathBuf::new(),
            extra_args: vec!["--marker".into(), marker.to_string_lossy().into_owned()],
        };
        let port = reserve_loopback_port().unwrap();
        let token = "restart-test-token".to_string();
        let origin = "http://tauri.localhost".to_string();
        let log = root.path().join("restart.log");
        let child = spawn_runtime_child(&launch, port, &token, &origin, &log).unwrap();
        let supervisor_log_dir = root.path().join("logs");
        fs::create_dir_all(&supervisor_log_dir).unwrap();
        let supervisor = Arc::new(GaRuntimeSupervisor::new(supervisor_log_dir));
        *supervisor.process.lock().unwrap() = Some(RuntimeProcess {
            child,
            launch,
            token,
            origin,
            port,
        });
        supervisor.publish(GaRuntimeStatus {
            phase: GaRuntimePhase::Running,
            port: Some(port),
            pid: supervisor
                .process
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.child.id()),
            generation: 1,
            ..GaRuntimeStatus::default()
        });
        supervisor.spawn_monitor(1);
        let started = Instant::now();
        loop {
            let status = supervisor.status();
            if status.phase == GaRuntimePhase::Running && status.restart_count == 1 {
                assert!(health_ok(
                    status.port.unwrap(),
                    "restart-test-token",
                    "http://tauri.localhost"
                ));
                break;
            }
            assert!(
                status.phase != GaRuntimePhase::Failed,
                "restart failed: {:?}",
                status.last_error
            );
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "restart timed out: {:?}",
                status.phase
            );
            thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(supervisor.stop().phase, GaRuntimePhase::Stopped);
    }

    #[test]
    fn tokens_have_256_bits_of_hex_material() {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
