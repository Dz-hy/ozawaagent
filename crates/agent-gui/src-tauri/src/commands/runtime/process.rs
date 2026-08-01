use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStopResponse,
};

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_stop(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
) -> Result<ManagedProcessStopResponse, String> {
    registry.stop(process_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_read_log(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessLogResponse, String> {
    registry.read_log(process_id, max_bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_snapshot(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.snapshot()
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_clear(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.clear(process_id)
}
