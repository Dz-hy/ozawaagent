import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import {
  type ConversationViewState,
  replaceActiveSegmentMessages,
} from "../chat/conversation/conversationState";
import { gaProtocolToMessages } from "./gaProtocol";
import { gaUnknownMessageToTool } from "./gaUnknownEvent";
import type { GaMessageDto, GaMessagesSnapshot } from "./types";

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type GaRenderModel = Pick<AssistantMessage, "api" | "provider" | "model">;

function timestamp(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return Date.now();
  return n < 10_000_000_000 ? Math.round(n * 1000) : Math.round(n);
}

export function gaMessageToPiMessages(
  message: GaMessageDto,
  model: GaRenderModel,
  conversationId?: string,
): Message[] {
  const role = String(message.role ?? "assistant");
  const text = String(message.display ?? message.content ?? "");
  const messageId = String(message.id ?? "unknown");
  const common = {
    id: `ga-${messageId}`,
    timestamp: timestamp(message.ts ?? message.timestamp),
  };
  if (role === "user") {
    return [{ role: "user", content: text, ...common } as UserMessage];
  }
  const protocolIdPrefix = conversationId ? `ga-${conversationId}-${messageId}` : `ga-${messageId}`;
  if (role !== "assistant" && role !== "error") {
    const unknown = gaUnknownMessageToTool(message, protocolIdPrefix, common.timestamp);
    return [
      {
        role: "assistant",
        content: [unknown.call],
        api: model.api,
        provider: model.provider,
        model: model.model,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        ...common,
      },
      unknown.result,
    ];
  }
  const error = role === "error" ? text || "GenericAgent request failed" : undefined;
  const base = {
    role: "assistant" as const,
    api: model.api,
    provider: model.provider,
    model: model.model,
    usage: EMPTY_USAGE,
    stopReason: error
      ? ("error" as const)
      : message.stopped
        ? ("aborted" as const)
        : ("stop" as const),
    ...(error ? { errorMessage: error } : {}),
    ...common,
  };
  return gaProtocolToMessages(
    error ? `Request failed: ${error}` : text,
    base,
    protocolIdPrefix,
    conversationId,
    { allowUnclosedThinking: message.partial === true },
  );
}

export function gaSnapshotToConversationState(
  current: ConversationViewState,
  snapshot: GaMessagesSnapshot,
  model: GaRenderModel,
): ConversationViewState {
  const messages = snapshot.messages.flatMap((message) =>
    gaMessageToPiMessages(message, model, snapshot.sessionId),
  );
  const partial = snapshot.partial;
  if (partial && typeof partial === "object" && "content" in partial && partial.content) {
    messages.push(
      ...gaMessageToPiMessages(
        { ...(partial as GaMessageDto), role: "assistant", id: `partial-${snapshot.msgSeq}` },
        model,
        snapshot.sessionId,
      ),
    );
  }
  return replaceActiveSegmentMessages(current, messages);
}
