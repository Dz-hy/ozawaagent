export type SystemToolRuntimeScope = "chat" | "cron_auto_prompt";
export type SystemToolId = never;

export type SystemToolOption = {
  id: SystemToolId;
  label: string;
  description: string;
  kind: "builtin" | "custom";
  runtimeScopes: readonly SystemToolRuntimeScope[];
};

/** Compatibility whitelist for persisted selectedSystemTools values. */
export const SYSTEM_TOOL_OPTIONS: SystemToolOption[] = [];
