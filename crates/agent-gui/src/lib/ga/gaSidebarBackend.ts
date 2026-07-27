import type { SidebarBackend } from "../sidebar/backend";
import type {
  SidebarBackendEvent,
  SidebarConversation,
  SidebarScope,
  SidebarWorkdirSummary,
} from "../sidebar/types";
import { gaBridgeClient, type GaBridgeClient } from "./GaBridgeClient";
import type { GaBridgeEvent, GaSessionDto } from "./types";

function epochMillis(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 10_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

function sessionId(session: GaSessionDto): string {
  const candidate = session.id ?? session.sessionId;
  return typeof candidate === "string" ? candidate : "";
}

export function gaSessionToSidebar(session: GaSessionDto): SidebarConversation {
  const id = sessionId(session);
  const model = session.model;
  const modelName =
    typeof model === "string"
      ? model
      : model && typeof model === "object" && "model" in model
        ? String((model as { model?: unknown }).model ?? "")
        : "";
  return {
    id,
    sessionId: id,
    title: typeof session.title === "string" && session.title.trim() ? session.title : "New chat",
    providerId: "genericagent",
    model: modelName || "default",
    cwd: String(session.cwd ?? session.path ?? "") || undefined,
    messageCount: Number(session.messageCount ?? session.message_count ?? session.msgSeq ?? 0),
    createdAt: epochMillis(session.createdAt ?? session.created_at),
    updatedAt: epochMillis(session.updatedAt ?? session.updated_at),
    isPinned: Boolean(session.pinned),
  };
}

function matchesScope(item: SidebarConversation, scope: SidebarScope): boolean {
  if (scope.kind === "none") return false;
  if (scope.kind === "unscoped") return !item.cwd;
  return (item.cwd ?? "").toLocaleLowerCase() === scope.cwd.toLocaleLowerCase();
}

function eventSessionId(event: GaBridgeEvent): string {
  const id = event.session_id ?? event.sessionId;
  return typeof id === "string" ? id : "";
}

export function createGaSidebarBackend(client: GaBridgeClient = gaBridgeClient): SidebarBackend {
  const manager = client.events();
  const mapSession = (session: GaSessionDto) => gaSessionToSidebar(session);

  return {
    async listConversations(page, pageSize, scope) {
      const response = await client.listSessions();
      const all = response.sessions.map(mapSession).filter((item) => item.id && matchesScope(item, scope));
      all.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const start = Math.max(0, page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), totalCount: all.length };
    },
    async listWorkdirs(): Promise<SidebarWorkdirSummary[]> {
      const response = await client.listSessions();
      const workdirs = new Map<string, SidebarWorkdirSummary>();
      for (const session of response.sessions.map(mapSession)) {
        if (!session.cwd) continue;
        const current = workdirs.get(session.cwd);
        workdirs.set(session.cwd, {
          path: session.cwd,
          conversationCount: (current?.conversationCount ?? 0) + 1,
          updatedAt: Math.max(current?.updatedAt ?? 0, session.updatedAt),
        });
      }
      return [...workdirs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async renameConversation(id, title) {
      return mapSession(await client.renameSession(id, title));
    },
    async setConversationPinned(id, isPinned) {
      return mapSession(await client.setSessionPinned(id, isPinned));
    },
    async deleteConversation(id) {
      await client.deleteSession(id);
    },
    subscribeEvents(listener): () => void {
      return manager.subscribe((event) => {
        const id = eventSessionId(event);
        if (!id || event.type === "bridge-ready") return;
        const state = event.state;
        if (state === "closed" || state === "deleted") {
          listener({ kind: "delete", conversationId: id });
          return;
        }
        void client
          .getSession(id)
          .then((snapshot) => {
            const conversation = mapSession(snapshot.session);
            listener({ kind: "upsert", conversationId: id, conversation });
            const running = snapshot.session.status === "running";
            const runningEvent: SidebarBackendEvent = running
              ? { kind: "running", conversationId: id, workdir: conversation.cwd, updatedAt: conversation.updatedAt }
              : { kind: "idle", conversationId: id };
            listener(runningEvent);
          })
          .catch(() => undefined);
      });
    },
    subscribeConnection(listener): () => void {
      return manager.subscribeConnection(listener);
    },
    getProtectedConversationIds: () => [],
  };
}
