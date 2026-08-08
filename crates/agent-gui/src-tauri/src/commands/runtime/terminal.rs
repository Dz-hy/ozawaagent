use std::sync::Arc;

use tauri::State;

use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::{
    terminal_shell_options as runtime_terminal_shell_options, SshTerminalTabsSnapshot,
    TerminalListResponse, TerminalSessionRecord, TerminalSessionRegistry,
    TerminalShellOptionsResponse, TerminalSnapshotResponse, TerminalSshCreateResponse,
    TerminalSshLatencyResponse, TerminalStreamSnapshotResponse,
};

/// 返回可用的终端 Shell 选项清单。
///
/// # 参数
/// 该命令无业务参数，仅可能包含 Tauri 注入状态。
///
/// # 返回
/// `TerminalShellOptionsResponse`
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    runtime_terminal_shell_options()
}

/// 列出项目关联的终端会话。
///
/// # 参数
/// - `project_path_key`：项目路径键
///
/// # 返回
/// `TerminalListResponse`
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_list(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: Option<String>,
) -> TerminalListResponse {
    registry.list(project_path_key)
}

/// 创建本地终端会话。
///
/// # 参数
/// - `cwd`：当前工作目录
/// - `project_path_key`：项目路径键
/// - `shell`：Shell 路径
/// - `title`：会话标题
/// - `cols`：列数
/// - `rows`：行数
///
/// # 返回
/// - `Ok(TerminalSnapshotResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_create(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    cwd: String,
    project_path_key: Option<String>,
    shell: Option<String>,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSnapshotResponse, String> {
    registry.create(cwd, project_path_key, shell, title, cols, rows)
}

/// 创建 SSH 终端会话并进入连接流程。
///
/// # 参数
/// - `cwd`：当前工作目录
/// - `project_path_key`：项目路径键
/// - `ssh_host_id`：ssh_host_id
/// - `title`：会话标题
/// - `cols`：列数
/// - `rows`：行数
///
/// # 返回
/// - `Ok(TerminalSshCreateResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_create_ssh(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    cwd: String,
    project_path_key: Option<String>,
    ssh_host_id: String,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    sftp_enabled: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    registry
        .inner()
        .clone()
        .create_ssh(
            cwd,
            project_path_key,
            ssh_host_id,
            title,
            cols,
            rows,
            sftp_enabled.unwrap_or(false),
        )
        .await
}

/// 回答 SSH 连接的交互式提示（密码、指纹确认等）。
///
/// # 参数
/// - `prompt_id`：提示 id
/// - `prompt_answer`：提示应答
/// - `trust_host_key`：是否信任主机指纹
///
/// # 返回
/// - `Ok(TerminalSshCreateResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_answer_ssh_prompt(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    prompt_id: String,
    prompt_answer: Option<String>,
    trust_host_key: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    registry
        .inner()
        .clone()
        .answer_ssh_prompt(prompt_id, prompt_answer, trust_host_key.unwrap_or(false))
        .await
}

/// 取消当前 SSH 连接提示。
///
/// # 参数
/// - `prompt_id`：提示 id
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_cancel_ssh_prompt(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    prompt_id: String,
) -> Result<(), String> {
    registry.cancel_ssh_prompt(prompt_id)
}

/// 重连已断开的 SSH 终端会话。
///
/// # 参数
/// - `session_id`：终端会话 id
///
/// # 返回
/// - `Ok(TerminalSessionRecord)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_reconnect(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    registry.inner().clone().ssh_reconnect(session_id).await
}

/// 探测 SSH 会话的往返延迟。
///
/// # 参数
/// - `session_id`：终端会话 id
///
/// # 返回
/// - `Ok(TerminalSshLatencyResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_latency(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSshLatencyResponse, String> {
    registry.ssh_latency(session_id).await
}

/// 列出 SSH 终端会话内的标签页。
///
/// # 参数
/// - `project_path_key`：项目路径键
///
/// # 返回
/// - `Ok(SshTerminalTabsSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tabs_list(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tabs_list(project_path_key)
}

/// 在 SSH 终端会话内打开指定类型的标签页。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `kind`：类型
///
/// # 返回
/// - `Ok(SshTerminalTabsSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tab_open(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    kind: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tab_open(session_id, kind)
}

/// 关闭 SSH 终端会话内的标签页。
///
/// # 参数
/// - `tab_id`：tab_id
///
/// # 返回
/// - `Ok(SshTerminalTabsSnapshot)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tab_close(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    tab_id: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tab_close(tab_id)
}

/// 建立终端输出流附加并回放最近内容。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `max_bytes`：读取字节上限
///
/// # 返回
/// - `Ok(TerminalStreamSnapshotResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_attach(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    max_bytes: Option<usize>,
) -> Result<TerminalStreamSnapshotResponse, String> {
    registry.stream_attach(session_id, max_bytes)
}

/// 向终端会话写入输入字节。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `bytes`：原始字节
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_input(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    registry.input_bytes(session_id, bytes)
}

/// 调整终端伪终端尺寸。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `cols`：列数
/// - `rows`：行数
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_resize(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.stream_resize(session_id, cols, rows)
}

/// 重命名终端会话标题。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `title`：会话标题
///
/// # 返回
/// - `Ok(TerminalSessionRecord)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_rename(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    title: String,
) -> Result<TerminalSessionRecord, String> {
    registry.rename(session_id, title)
}

/// 关闭指定终端会话（连同其 SFTP 关联）。
///
/// # 参数
/// - `session_id`：终端会话 id
///
/// # 返回
/// - `Ok(TerminalSessionRecord)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    sftp_registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    let response = registry.close(session_id)?;
    sftp_registry.close_session(&response.id);
    Ok(response)
}

/// 关闭项目下全部终端与 SFTP 会话。
///
/// # 参数
/// - `project_path_key`：项目路径键
///
/// # 返回
/// - `Ok(TerminalListResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close_project(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    sftp_registry: State<'_, Arc<SftpSessionRegistry>>,
    project_path_key: String,
) -> Result<TerminalListResponse, String> {
    let response = registry.close_project(project_path_key)?;
    for session in &response.sessions {
        sftp_registry.close_session(&session.id);
    }
    Ok(response)
}
