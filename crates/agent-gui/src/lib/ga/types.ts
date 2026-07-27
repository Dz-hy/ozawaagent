export type GaRuntimePhase =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "failed";
export type GaRuntimeStatus = {
  phase: GaRuntimePhase;
  pid?: number | null;
  port?: number | null;
  restartCount: number;
  lastError?: string | null;
  generation: number;
};
export type GaRuntimeStartResponse = { status: GaRuntimeStatus; baseUrl: string; token: string };

export type GaSessionDto = {
  id: string;
  title?: string;
  cwd?: string;
  path?: string;
  state?: string;
  status?: string;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
  pinned?: boolean;
  messageCount?: number;
  message_count?: number;
  [key: string]: unknown;
};
export type GaMessageDto = Record<string, unknown> & {
  id?: string | number;
  role?: string;
  content?: string;
  ts?: number;
  timestamp?: number;
  turn_segs?: string[];
  stopped?: boolean;
  event_id?: string;
};
export type GaMessagesSnapshot = {
  sessionId: string;
  status: string;
  messages: GaMessageDto[];
  partial?: GaMessageDto | null;
  msgSeq: number;
  updatedAt?: number;
  lastError?: string;
  model?: unknown;
};
export type GaPromptRequest = {
  prompt: string;
  display?: string;
  files?: Array<{ name: string; path: string }>;
  imageMetas?: Array<{ name: string; path: string }>;
};
export type GaPromptAccepted = {
  ok: boolean;
  sessionId: string;
  accepted: boolean;
  userMessageId: number;
  seq: number;
};
export type GaCommandDto = {
  id: string;
  name: string;
  title: string;
  description: string;
  arg_hint: string;
  owner: "ga" | string;
  api_version: string;
  plugin_version: string;
  argument_schema: Record<string, unknown>;
  permissions: string[];
};
export type GaCommandResult = {
  command_id: string;
  result: { type: "prompt"; prompt: string };
};
export type GaSessionSnapshot = {
  sessionId: string;
  session: GaSessionDto;
  messages: GaMessageDto[];
  partial?: unknown;
};
export type GaBridgeEvent = Record<string, unknown> & {
  type?: string;
  event_id?: string;
  eventId?: string;
  session_id?: string;
  sessionId?: string;
};
export type GaEnvelope<T> = { payload: T; type?: string; request_id?: string };

export class GaBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GaBridgeError";
  }
}
