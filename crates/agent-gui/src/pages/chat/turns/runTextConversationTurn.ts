import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import {
  createUserMessageWithUploads,
  type PendingUploadedFile,
} from "../../../lib/chat/messages/uploadedFiles";
import { streamAssistantMessage } from "../../../lib/providers/llm";
import type { ProviderRuntimeConfig } from "../../../lib/providers/runtime/types";
import type { ProviderId } from "../../../lib/settings";

export type RunTextConversationTurnParams = {
  baseState: ConversationViewState;
  text: string;
  uploads: PendingUploadedFile[];
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  workdir?: string;
  sessionId?: string;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  applyState: (state: ConversationViewState) => void;
};

export type RunTextConversationTurnResult = {
  state: ConversationViewState;
  assistant: AssistantMessage;
};

/**
 * Legacy-provider turn boundary. It deliberately owns only text streaming and
 * conversation-state updates; tools and GenericAgent snapshots stay outside.
 */
export async function runTextConversationTurn(
  params: RunTextConversationTurnParams,
): Promise<RunTextConversationTurnResult> {
  const userMessage = createUserMessageWithUploads(params.text, params.uploads);
  if (!userMessage) {
    throw new Error("Cannot send an empty message");
  }

  const stateWithUser = appendMessagesToConversation(params.baseState, [userMessage]);
  params.applyState(stateWithUser);

  const assistant = await streamAssistantMessage({
    providerId: params.providerId,
    model: params.model,
    runtime: params.runtime,
    context: buildRequestContext(stateWithUser, {
      includeUploadedFilesMetadata: true,
    }),
    workdir: params.workdir,
    sessionId: params.sessionId,
    signal: params.signal,
    nativeWebSearch: params.runtime.nativeWebSearchEnabled,
    onTextDelta: (delta) => params.onTextDelta?.(delta),
  });

  const finalState = appendMessagesToConversation(stateWithUser, [assistant]);
  params.applyState(finalState);
  return { state: finalState, assistant };
}

export { runTextConversationTurn as runLegacyTextTurn };
