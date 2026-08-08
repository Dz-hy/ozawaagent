use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStopResponse,
};

/// 停止指定的托管进程。
///
/// # 参数
/// - `process_id`：process_id
///
/// # 返回
/// - `Ok(ManagedProcessStopResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_stop(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
) -> Result<ManagedProcessStopResponse, String> {
    registry.stop(process_id)
}

/// 读取指定托管进程的日志（受字节上限约束）。
///
/// # 参数
/// - `process_id`：process_id
/// - `max_bytes`：读取字节上限
///
/// # 返回
/// - `Ok(ManagedProcessLogResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_read_log(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessLogResponse, String> {
    registry.read_log(process_id, max_bytes)
}

/// 返回全部托管进程运行状态快照。
///
/// # 参数
/// 该命令无业务参数，仅可能包含 Tauri 注入状态。
///
/// # 返回
/// - `Ok(ManagedProcessSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_snapshot(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.snapshot()
}

/// 清理已结束的托管进程记录。
///
/// # 参数
/// - `process_id`：process_id
///
/// # 返回
/// - `Ok(ManagedProcessSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_clear(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.clear(process_id)
}
