use std::sync::Arc;

use crate::services::workspace_watch::{WatchSource, WorkspaceWatchService};

/// Replaces the local webview's desired workdir watch set wholesale and
/// reconciles watchers against it.
#[tauri::command]
pub fn workspace_watch_set(
    workdirs: Vec<String>,
    workspace_watch: tauri::State<'_, Arc<WorkspaceWatchService>>,
) -> Result<(), String> {
    workspace_watch.set_desired(WatchSource::Local, workdirs);
    Ok(())
}
