use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

use crate::runtime::ga_supervisor::{GaRuntimeStatus, GaRuntimeSupervisor};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaRuntimeStartResponse {
    pub status: GaRuntimeStatus,
    pub base_url: String,
    pub token: String,
}

/// 启动 GenericAgent 运行时（sidecar）。
///
/// # 参数
/// - `ga_root`：ga_root
/// - `bundled_root`：bundled_root
///
/// # 返回
/// - `Ok(GaRuntimeStartResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn ga_runtime_start(
    app: tauri::AppHandle,
    supervisor: State<'_, Arc<GaRuntimeSupervisor>>,
    ga_root: Option<String>,
    bundled_root: Option<String>,
) -> Result<GaRuntimeStartResponse, String> {
    let bundled = match bundled_root {
        Some(root) => Some(PathBuf::from(root)),
        None => {
            let resource_root = app
                .path()
                .resource_dir()
                .map_err(|e| format!("Cannot resolve Tauri resource directory: {e}"))?
                .join("ga-runtime");
            resource_root.is_dir().then_some(resource_root)
        }
    };
    let bundled_data = Some(
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Cannot resolve OzawaAgent data directory: {e}"))?
            .join("ga-runtime"),
    );
    let launch = GaRuntimeSupervisor::discover(
        ga_root.as_deref(),
        bundled.as_deref(),
        bundled_data.as_deref(),
    )?;
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
