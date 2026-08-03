import { invoke } from "@tauri-apps/api/core";
import type {
  GaAutomation,
  GaAutomationInput,
  GaAutomationRun,
  GaAutomationsSnapshot,
  GaBridgeEvent,
  GaCommandDto,
  GaCommandResult,
  GaConductorSnapshot,
  GaEnvelope,
  GaHooksSnapshot,
  GaKnowledgeCatalog,
  GaMessageDto,
  GaMessagesSnapshot,
  GaModelProfile,
  GaModelProfileInput,
  GaModelProfilesSnapshot,
  GaProjectMemoryStatus,
  GaPromptAccepted,
  GaPromptRequest,
  GaRuntimeStartResponse,
  GaServicePanel,
  GaServiceState,
  GaSessionDto,
  GaSessionSnapshot,
  GaTokenHistorySnapshot,
  GaTokenStatsSnapshot,
} from "./types";
import { GaBridgeError } from "./types";

type FetchLike = typeof fetch;

function unwrap<T>(value: T | GaEnvelope<T>): T {
  if (value && typeof value === "object" && "payload" in value) {
    return (value as GaEnvelope<T>).payload;
  }
  return value as T;
}

export class GaBridgeClient {
  private runtime: GaRuntimeStartResponse | null = null;
  private starting: Promise<GaRuntimeStartResponse> | null = null;
  private wsManager: GaWebSocketManager | null = null;

  constructor(private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis)) {}

  async ensureRuntime(forceRefresh = false): Promise<GaRuntimeStartResponse> {
    if (forceRefresh) {
      this.runtime = null;
      this.starting = null;
    }
    if (this.runtime?.status.phase === "running") return this.runtime;
    if (!this.starting) {
      this.starting = invoke<GaRuntimeStartResponse>("ga_runtime_start", {
        ga_root: null,
        bundled_root: null,
      })
        .then((runtime) => {
          this.runtime = runtime;
          this.starting = null;
          return runtime;
        })
        .catch((error) => {
          this.starting = null;
          throw new GaBridgeError(String(error), "runtime_start_failed", undefined, true);
        });
    }
    return this.starting;
  }

  private async request<T>(path: string, init?: RequestInit, refreshRuntime = true): Promise<T> {
    const runtime = await this.ensureRuntime();
    let response: Response;
    try {
      response = await this.fetcher(`${runtime.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      if (refreshRuntime) {
        await this.ensureRuntime(true);
        return this.request<T>(path, init, false);
      }
      throw new GaBridgeError(
        error instanceof Error ? error.message : "GenericAgent bridge is unavailable",
        "bridge_unavailable",
        undefined,
        true,
      );
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail = unwrap((body ?? {}) as Record<string, unknown>);
      throw new GaBridgeError(
        String(detail.message ?? detail.error ?? `Bridge request failed (${response.status})`),
        String(detail.code ?? "bridge_request_failed"),
        response.status,
        response.status >= 500,
      );
    }
    return unwrap(body as T | GaEnvelope<T>);
  }

  listSessions() {
    return this.request<{ sessions: GaSessionDto[]; activeSessionId?: string }>("/sessions");
  }
  async createSession(options?: { cwd?: string; projectId?: string }): Promise<GaSessionDto> {
    const result = await this.request<{ session: GaSessionDto }>("/session/new", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
    return result.session;
  }
  getSession(id: string) {
    return this.request<GaSessionSnapshot>(`/session/${encodeURIComponent(id)}`);
  }
  async getSessionMessages(id: string, after = 0, limit = 200): Promise<GaMessagesSnapshot> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.request<GaMessagesSnapshot>(
      `/session/${encodeURIComponent(id)}/messages?${query.toString()}`,
    );
  }
  async promptSession(id: string, prompt: GaPromptRequest): Promise<GaPromptAccepted> {
    return this.request<GaPromptAccepted>(`/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify(prompt),
    });
  }
  async cancelSession(id: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.request(`/session/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  async restoreSession(id: string): Promise<Record<string, unknown>> {
    return this.request(`/session/${encodeURIComponent(id)}/restore`, { method: "POST" });
  }
  async renameSession(id: string, title: string): Promise<GaSessionDto> {
    const result = await this.request<{ session: GaSessionDto }>(
      `/session/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
    );
    return result.session;
  }
  async setSessionPinned(id: string, pinned: boolean): Promise<GaSessionDto> {
    const result = await this.request<{ session: GaSessionDto }>(
      `/session/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      },
    );
    return result.session;
  }
  async deleteSession(id: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  messages(id: string, after = 0): Promise<{ messages?: GaMessageDto[] } | GaMessageDto[]> {
    return this.request(`/session/${encodeURIComponent(id)}/messages?after=${after}`);
  }
  async listCommands(): Promise<GaCommandDto[]> {
    const result = await this.request<{ commands: GaCommandDto[] }>("/api/v1/commands");
    return result.commands;
  }
  executeCommand(id: string, argsText = ""): Promise<GaCommandResult> {
    return this.request(`/api/v1/commands/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      body: JSON.stringify({ args_text: argsText }),
    });
  }
  getProjectMemoryStatus(projectId: string): Promise<GaProjectMemoryStatus> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/memory-status`);
  }
  getTokenStats(): Promise<GaTokenStatsSnapshot> {
    return this.request("/api/v1/token-stats");
  }
  getTokenHistory(): Promise<GaTokenHistorySnapshot> {
    return this.request("/api/v1/token-history");
  }
  listModelProfiles(): Promise<GaModelProfilesSnapshot> {
    return this.request("/api/v1/model-profiles");
  }
  async getModelProfile(id: number): Promise<GaModelProfile> {
    const result = await this.request<{ profile: GaModelProfile }>(
      `/api/v1/model-profiles/${encodeURIComponent(id)}`,
    );
    return result.profile;
  }
  async createModelProfile(
    input: Required<Pick<GaModelProfileInput, "protocol" | "model" | "apibase">> &
      GaModelProfileInput,
  ): Promise<GaModelProfile> {
    const result = await this.request<{ profile: GaModelProfile }>("/api/v1/model-profiles", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return result.profile;
  }
  async updateModelProfile(id: number, patch: GaModelProfileInput): Promise<GaModelProfile> {
    const result = await this.request<{ profile: GaModelProfile }>(
      `/api/v1/model-profiles/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    return result.profile;
  }
  async deleteModelProfile(id: number): Promise<GaModelProfilesSnapshot> {
    return this.request(`/api/v1/model-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async setDefaultModelProfile(id: number): Promise<GaModelProfilesSnapshot> {
    return this.request(`/api/v1/model-profiles/${encodeURIComponent(id)}/default`, {
      method: "POST",
    });
  }
  getHooks(): Promise<GaHooksSnapshot> {
    return this.request("/api/v1/hooks");
  }
  getKnowledgeCatalog(): Promise<GaKnowledgeCatalog> {
    return this.request("/api/v1/knowledge");
  }
  listAutomations(): Promise<GaAutomationsSnapshot> {
    return this.request("/api/v1/automations");
  }
  createAutomation(input: GaAutomationInput): Promise<GaAutomation> {
    return this.request<GaAutomation>("/api/v1/automations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateAutomation(id: string, patch: Partial<Omit<GaAutomation, "id">>): Promise<GaAutomation> {
    return this.request<GaAutomation>(`/api/v1/automations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async deleteAutomation(id: string): Promise<void> {
    await this.request(`/api/v1/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async listAutomationRuns(id: string): Promise<GaAutomationRun[]> {
    const result = await this.request<{ id: string; runs: GaAutomationRun[] }>(
      `/api/v1/automations/${encodeURIComponent(id)}/runs`,
    );
    return result.runs;
  }
  getServices(): Promise<GaServicePanel> {
    return this.request("/services/panel");
  }
  async setServiceRunning(id: string, running: boolean): Promise<GaServiceState> {
    const result = await this.request<{ ok: boolean; service: GaServiceState }>(
      running ? "/services/start" : "/services/stop",
      { method: "POST", body: JSON.stringify({ id }) },
    );
    return result.service;
  }

  getConductorSnapshot(): Promise<GaConductorSnapshot> {
    return this.request("/api/v1/conductor");
  }
  events(): GaWebSocketManager {
    this.wsManager ??= new GaWebSocketManager(() => this.ensureRuntime(true));
    return this.wsManager;
  }
}

function eventKey(event: GaBridgeEvent): string | null {
  const explicit = event.event_id ?? event.eventId;
  if (typeof explicit === "string" && explicit) return explicit;
  const revision = event.revision ?? event.updatedAt ?? event.timestamp;
  if (revision === undefined) return null;
  return `${String(event.type ?? "unknown")}:${String(event.session_id ?? event.sessionId ?? "")}:${String(revision)}`;
}

export class GaWebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly eventListeners = new Set<(event: GaBridgeEvent) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly seenEvents = new Set<string>();

  constructor(private readonly runtime: () => Promise<GaRuntimeStartResponse>) {}

  subscribe(listener: (event: GaBridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.connect();
    return () => {
      this.eventListeners.delete(listener);
      if (this.eventListeners.size === 0) this.stop();
    };
  }
  subscribeConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  private publishConnection(connected: boolean) {
    for (const listener of this.connectionListeners) listener(connected);
  }
  private scheduleReconnect() {
    if (this.stopped || this.eventListeners.size === 0 || this.reconnectTimer) return;
    const delay = Math.min(10_000, 250 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  private connect() {
    this.stopped = false;
    if (this.ws || this.eventListeners.size === 0) return;
    void this.runtime()
      .then((runtime) => {
        if (this.stopped || this.ws) return;
        const socket = new WebSocket(`${runtime.baseUrl.replace(/^http/, "ws")}/ws`, [
          `ga-token.${runtime.token}`,
        ]);
        this.ws = socket;
        socket.onopen = () => {
          this.reconnectAttempt = 0;
          this.publishConnection(true);
        };
        socket.onmessage = (message) => {
          let event: GaBridgeEvent;
          try {
            event = JSON.parse(String(message.data)) as GaBridgeEvent;
          } catch {
            return;
          }
          const key = eventKey(event);
          if (key && this.seenEvents.has(key)) return;
          if (key) {
            this.seenEvents.add(key);
            if (this.seenEvents.size > 4096) {
              const oldest = this.seenEvents.values().next().value;
              if (oldest) this.seenEvents.delete(oldest);
            }
          }
          for (const listener of this.eventListeners) listener(event);
        };
        socket.onclose = () => {
          if (this.ws === socket) this.ws = null;
          this.publishConnection(false);
          this.scheduleReconnect();
        };
        socket.onerror = () => socket.close();
      })
      .catch(() => {
        this.publishConnection(false);
        this.scheduleReconnect();
      });
  }
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }
}

export const gaBridgeClient = new GaBridgeClient();
