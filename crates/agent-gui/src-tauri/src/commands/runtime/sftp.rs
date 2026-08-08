use std::sync::Arc;

use tauri::State;

use crate::runtime::sftp::{
    SftpActionResponse, SftpListResponse, SftpSessionRegistry, SftpStatResponse,
    SftpTransferResponse,
};

/// 列出 SFTP 会话某侧目录。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `side`：SFTP 侧（local/remote）
/// - `path`：工作区相对路径（须安全解析）
///
/// # 返回
/// - `Ok(SftpListResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_list(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpListResponse, String> {
    registry
        .list(session_id, project_path_key, workdir, side, path)
        .await
}

/// 获取 SFTP 会话某侧文件或目录的状态。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `side`：SFTP 侧（local/remote）
/// - `path`：工作区相对路径（须安全解析）
///
/// # 返回
/// - `Ok(SftpStatResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_stat(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpStatResponse, String> {
    registry
        .stat(session_id, project_path_key, workdir, side, path)
        .await
}

/// 在 SFTP 会话某侧创建目录。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `side`：SFTP 侧（local/remote）
/// - `path`：工作区相对路径（须安全解析）
///
/// # 返回
/// - `Ok(SftpActionResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_mkdir(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
) -> Result<SftpActionResponse, String> {
    registry
        .mkdir(session_id, project_path_key, workdir, side, path)
        .await
}

/// 重命名 SFTP 会话某侧的文件或目录。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `side`：SFTP 侧（local/remote）
/// - `from_path`：源路径
/// - `to_path`：目标路径
///
/// # 返回
/// - `Ok(SftpActionResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_rename(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    from_path: String,
    to_path: String,
) -> Result<SftpActionResponse, String> {
    registry
        .rename(
            session_id,
            project_path_key,
            workdir,
            side,
            from_path,
            to_path,
        )
        .await
}

/// 删除 SFTP 会话某侧的文件或目录。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `side`：SFTP 侧（local/remote）
/// - `path`：工作区相对路径（须安全解析）
/// - `recursive`：是否递归
///
/// # 返回
/// - `Ok(SftpActionResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_delete(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
    recursive: Option<bool>,
) -> Result<SftpActionResponse, String> {
    registry
        .delete(
            session_id,
            project_path_key,
            workdir,
            side,
            path,
            recursive.unwrap_or(false),
        )
        .await
}

/// 发起双向文件传输。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `project_path_key`：项目路径键
/// - `workdir`：工作区绝对路径
/// - `direction`：传输方向
/// - `source_path`：source_path
/// - `target_path`：目标路径
///
/// # 返回
/// - `Ok(SftpTransferResponse)`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_transfer(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    direction: String,
    source_path: String,
    target_path: String,
    recursive: Option<bool>,
    overwrite: Option<bool>,
) -> Result<SftpTransferResponse, String> {
    registry
        .inner()
        .clone()
        .transfer(
            session_id,
            project_path_key,
            workdir,
            direction,
            source_path,
            target_path,
            recursive.unwrap_or(false),
            overwrite.unwrap_or(false),
        )
        .await
}

/// 取消正在进行的 SFTP 传输。
///
/// # 参数
/// - `session_id`：终端会话 id
/// - `transfer_id`：传输 id
///
/// # 返回
/// - `Ok(())`：操作成功后的结果
/// - `Err(String)`：可读的错误描述
#[tauri::command(rename_all = "snake_case")]
pub fn sftp_cancel_transfer(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    registry.cancel_transfer(session_id, transfer_id)
}
