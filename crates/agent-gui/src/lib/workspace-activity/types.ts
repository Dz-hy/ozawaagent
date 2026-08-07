// Workspace activity invalidation types.
//
// NOTE: desktop GUI only (the former agent-gateway/web mirror was removed);
// keep imports to relative or @tauri-apps/* only.

export type WorkspaceActivity = {
  workdir: string;
  revision: number;
  fs: boolean;
  git: boolean;
  changedPaths: string[];
  truncated: boolean;
};

// `{ kind: "reset" }` marks a continuity break (reconnect / resubscribe):
// events may have been missed, so consumers must treat everything as dirty.
export type WorkspaceActivityEventPayload = WorkspaceActivity | { kind: "reset" };

export type WorkspaceActivityClient = {
  subscribe(workdir: string, listener: (ev: WorkspaceActivityEventPayload) => void): () => void;
};
