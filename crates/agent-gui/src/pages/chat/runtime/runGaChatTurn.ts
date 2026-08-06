import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import { gaBridgeClient } from "../../../lib/ga/GaBridgeClient";
import { gaSnapshotToConversationState } from "../../../lib/ga/gaMessages";
import type { GaBridgeEvent, GaPromptRequest } from "../../../lib/ga/types";

const POLL_INTERVAL_MS = 750;
const TERMINAL_STATUSES = new Set(["idle", "error", "cancelled"]);
const GA_RENDER_MODEL = {
  api: "openai-completions",
  provider: "genericagent",
  model: "genericagent",
} as Pick<AssistantMessage, "api" | "provider" | "model">;

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export type RunGaChatTurnParams = {
  conversationId: string;
  sessionId?: string;
  prompt: GaPromptRequest;
  baseState: ConversationViewState;
  signal: AbortSignal;
  applyState: (state: ConversationViewState) => void;
};

/**
 * Runs one GenericAgent-owned turn. HTTP snapshots are authoritative; the
 * websocket is only a low-latency hint that a new snapshot should be fetched.
 */
export type ObserveGaChatTurnParams = Omit<RunGaChatTurnParams, "prompt"> & {
  cancelOnAbort?: boolean;
};

export async function observeGaChatTurn(params: ObserveGaChatTurnParams) {
  const {
    conversationId,
    sessionId: requestedSessionId,
    baseState,
    signal,
    applyState,
    cancelOnAbort = false,
  } = params;
  const sessionId = requestedSessionId?.trim() || conversationId;
  let wake: (() => void) | null = null;
  const unsubscribe = gaBridgeClient.events().subscribe((event: GaBridgeEvent) => {
    const sid = String(event.sessionId ?? event.session_id ?? "");
    if (sid === sessionId) wake?.();
  });

  const waitForHintOrPoll = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wake = null;
        resolve();
      };
      wake = finish;
      void delay(POLL_INTERVAL_MS, signal).then(finish);
    });

  try {
    while (true) {
      if (signal.aborted) {
        if (cancelOnAbort) await gaBridgeClient.cancelSession(sessionId).catch(() => undefined);
        return "cancelled";
      }
      const snapshot = await gaBridgeClient.getSessionMessages(sessionId, 0, 10_000);
      applyState(gaSnapshotToConversationState(baseState, snapshot, GA_RENDER_MODEL));
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        if (snapshot.status === "error") {
          throw new Error(snapshot.lastError || "GenericAgent request failed");
        }
        return snapshot.status;
      }
      await waitForHintOrPoll();
    }
  } finally {
    unsubscribe();
  }
}

export async function runGaChatTurn(params: RunGaChatTurnParams) {
  const { prompt, ...observeParams } = params;
  const sessionId = params.sessionId?.trim() || params.conversationId;
  await gaBridgeClient.promptSession(sessionId, prompt);
  return observeGaChatTurn({ ...observeParams, sessionId, cancelOnAbort: true });
}
