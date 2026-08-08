use std::sync::Arc;

use crate::services::automation::{
    validate_cron_expression, AutomationApplyInput, AutomationSnapshot, AutomationStore,
    CompletePromptRunInput, CronApplyResponse, CronRunNowResponse, CronRunRecord,
    HooksApplyResponse, PromptCompletionResponse, PromptRunRequest,
};

/// 校验 cron 表达式是否合法。
///
/// # 参数
/// - `expression`：cron 表达式
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn cron_validate_expression(expression: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || validate_cron_expression(&expression))
        .await
        .map_err(|e| format!("cron_validate_expression join 失败：{e}"))?
}

/// 返回自动化任务与运行记录的整体快照。
///
/// # 参数
/// 该命令无业务参数，仅可能包含 Tauri 注入状态。
///
/// # 返回
/// - `Ok(AutomationSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_snapshot(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<AutomationSnapshot, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.snapshot())
        .await
        .map_err(|e| format!("automation_snapshot join 失败：{e}"))?
}

/// 应用 cron 自动化任务（创建、更新、删除）。
///
/// # 参数
/// - `input`：结构化输入
///
/// # 返回
/// - `Ok(CronApplyResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_cron_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.cron_apply(input))
        .await
        .map_err(|e| format!("automation_cron_apply join 失败：{e}"))?
}

/// 应用 hooks 自动化任务（创建、更新、删除）。
///
/// # 参数
/// - `input`：结构化输入
///
/// # 返回
/// - `Ok(HooksApplyResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_hooks_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<HooksApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.hooks_apply(input))
        .await
        .map_err(|e| format!("automation_hooks_apply join 失败：{e}"))?
}

/// 列出指定任务的运行记录。
///
/// # 参数
/// - `task_id`：任务 id
/// - `limit`：条数上限
///
/// # 返回
/// - `Ok(Vec<CronRunRecord)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_list_runs(
    task_id: String,
    limit: Option<usize>,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<CronRunRecord>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.list_runs(&task_id, limit.unwrap_or(100)))
        .await
        .map_err(|e| format!("automation_list_runs join 失败：{e}"))?
}

/// 清空指定任务的运行记录。
///
/// # 参数
/// - `task_id`：任务 id
///
/// # 返回
/// - `Ok(usize)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_clear_runs(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<usize, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.clear_runs(&task_id))
        .await
        .map_err(|e| format!("automation_clear_runs join 失败：{e}"))?
}

/// 立即手动触发一次 cron 任务。
///
/// # 参数
/// - `task_id`：任务 id
///
/// # 返回
/// - `Ok(CronRunNowResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_run_cron_now(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronRunNowResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.run_cron_task_now(&task_id))
        .await
        .map_err(|e| format!("automation_run_cron_now join 失败：{e}"))?
}

/// 领取待处理的 prompt 运行任务。
///
/// # 参数
/// 该命令无业务参数，仅可能包含 Tauri 注入状态。
///
/// # 返回
/// - `Ok(Vec<PromptRunRequest)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_claim_prompt_runs(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<PromptRunRequest>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.claim_prompt_runs())
        .await
        .map_err(|e| format!("automation_claim_prompt_runs join 失败：{e}"))?
}

/// 释放或回退指定的 prompt 运行任务。
///
/// # 参数
/// - `execution_id`：执行 id
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_release_prompt_run(
    execution_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<(), String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.release_prompt_run(&execution_id))
        .await
        .map_err(|e| format!("automation_release_prompt_run join 失败：{e}"))?
}

/// 上报 prompt 运行任务的执行结果。
///
/// # 参数
/// - `input`：结构化输入
///
/// # 返回
/// - `Ok(PromptCompletionResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn automation_complete_prompt_run(
    input: CompletePromptRunInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<PromptCompletionResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.complete_prompt_run(input))
        .await
        .map_err(|e| format!("automation_complete_prompt_run join 失败：{e}"))?
}
