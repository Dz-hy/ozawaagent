use russh::client;

use super::*;

pub(crate) async fn open_ssh_shell_channel(
    handle: &client::Handle<LiveAgentSshClient>,
    size: TerminalSize,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH channel open failed: {error}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(size.cols),
            u32::from(size.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("SSH PTY request failed: {error}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|error| format!("SSH shell request failed: {error}"))?;
    Ok(channel)
}

impl TerminalSessionRegistry {
    /// Opens an SFTP subsystem channel on the SSH session's existing
    /// authenticated connection. No re-authentication happens, so this works
    /// for every auth type including keyboard-interactive. The returned
    /// connection id identifies the underlying connection: after a reconnect
    /// the id changes and cached SFTP sessions must be reopened.
    pub(crate) async fn open_ssh_sftp_session(
        &self,
        session_id: &str,
    ) -> Result<(TerminalSftpConnection, usize), String> {
        let entry = self.entry(session_id)?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        let connection_id = runtime.current_connection_id();
        let channel = {
            let handle = runtime.handle.lock().await;
            let Some(handle) = handle.as_ref() else {
                return Err("SSH connection is not connected".to_string());
            };
            handle
                .channel_open_session()
                .await
                .map_err(|error| format!("SFTP channel open failed: {error}"))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("SFTP subsystem request failed: {error}"))?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("SFTP session failed: {error}"))?;
        Ok((TerminalSftpConnection { session }, connection_id))
    }

    pub(crate) fn ssh_connection_id(&self, session_id: &str) -> Result<usize, String> {
        let entry = self.entry(session_id)?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        Ok(runtime.current_connection_id())
    }
}
