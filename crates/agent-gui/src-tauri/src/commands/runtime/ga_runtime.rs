use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::runtime::ga_supervisor::{GaRuntimeStatus, GaRuntimeSupervisor};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaRuntimeStartResponse {
    pub status: GaRuntimeStatus,
    pub base_url: String,
    pub token: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ga_runtime_status(supervisor: State<'_, Arc<GaRuntimeSupervisor>>) -> GaRuntimeStatus {
    supervisor.status()
}

#[tauri::command(rename_all = "snake_case")]
pub fn ga_runtime_start(
    supervisor: State<'_, Arc<GaRuntimeSupervisor>>,
    ga_root: Option<String>,
    bundled_root: Option<String>,
) -> Result<GaRuntimeStartResponse, String> {
    let bundled = bundled_root.as_deref().map(PathBuf::from);
    let launch = GaRuntimeSupervisor::discover(ga_root.as_deref(), bundled.as_deref())?;
    let (status, token) = supervisor.start_with_credentials(launch)?;
    let port = status
        .port
        .ok_or_else(|| "GA runtime did not publish a port".to_string())?;
    Ok(GaRuntimeStartResponse {
        status,
        base_url: format!("http://127.0.0.1:{port}"),
        token,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn ga_runtime_stop(supervisor: State<'_, Arc<GaRuntimeSupervisor>>) -> GaRuntimeStatus {
    supervisor.stop()
}

#[tauri::command(rename_all = "snake_case")]
pub fn ga_runtime_read_log(
    supervisor: State<'_, Arc<GaRuntimeSupervisor>>,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    supervisor.read_log(max_bytes.unwrap_or(64 * 1024))
}
