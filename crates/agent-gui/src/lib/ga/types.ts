export type GaRuntimePhase = "stopped" | "starting" | "running" | "restarting" | "stopping" | "failed";
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
export type GaMessageDto = Record<string, unknown> & { id?: string | number; event_id?: string };
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
