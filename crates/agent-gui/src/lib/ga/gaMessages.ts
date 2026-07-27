import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import {
  type ConversationViewState,
  replaceActiveSegmentMessages,
} from "../chat/conversation/conversationState";
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

export function gaMessageToPiMessage(message: GaMessageDto, model: GaRenderModel): Message {
  const role = String(message.role ?? "assistant");
  const text = String(message.display ?? message.content ?? "");
  const common = {
    id: `ga-${String(message.id ?? "unknown")}`,
    timestamp: timestamp(message.ts ?? message.timestamp),
  };
  if (role === "user") {
    return { role: "user", content: text, ...common } as UserMessage;
  }
  const error = role === "error" ? text || "GenericAgent request failed" : undefined;
  return {
    role: "assistant",
    content: [{ type: "text", text: error ? `Request failed: ${error}` : text }],
    api: model.api,
    provider: model.provider,
    model: model.model,
    usage: EMPTY_USAGE,
    stopReason: error ? "error" : message.stopped ? "aborted" : "stop",
    ...(error ? { errorMessage: error } : {}),
    ...common,
  } as AssistantMessage;
}

export function gaSnapshotToConversationState(
  current: ConversationViewState,
  snapshot: GaMessagesSnapshot,
  model: GaRenderModel,
): ConversationViewState {
  const messages = snapshot.messages.map((message) => gaMessageToPiMessage(message, model));
  if (snapshot.partial?.content) {
    messages.push(
      gaMessageToPiMessage(
        { ...snapshot.partial, role: "assistant", id: `partial-${snapshot.msgSeq}` },
        model,
      ),
    );
  }
  return replaceActiveSegmentMessages(current, messages);
}
