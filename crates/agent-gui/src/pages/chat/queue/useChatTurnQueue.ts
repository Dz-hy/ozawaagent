import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MentionComposerHandle } from "../../../components/chat/MentionComposer";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  isAgentExecutionMode,
  type SystemToolId,
} from "../../../lib/settings";
import type { ChatQueueTurnPreview } from "../components/ChatComposerBar";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import type { SendChatAction } from "../runtime/useSendChatTurn";
import {
  appendQueuedChatTurn,
  buildQueuedChatTurnPreview,
  createQueuedChatTurn,
  getQueuedConversationIds,
  insertQueuedChatTurnAtSlot,
  moveQueuedChatTurn,
  promoteQueuedChatTurn,
  type QueuedChatTurn,
  type QueuedChatTurnEditSlot,
  queuedChatTurnHasContent,
  removeQueuedChatTurn,
  resolveQueuedChatTurnSlotIndex,
  takeNextQueuedChatTurn,
} from "./chatTurnQueue";

type UseChatTurnQueueParams = {
  settings: AppSettings;
  currentConversationId: string;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  isConversationRunning: (conversationId: string) => boolean;
  runningConversationIds: ReadonlySet<string>;
  getConversationAbortController: (conversationId: string) => AbortController | null;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  captureAbortSnapshot: (store: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  pendingUploadedFiles: PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  clearCachedComposerDraft: (conversationId?: string) => void;
  displayedConversationWorkdir: string;
  sendActionRef: MutableRefObject<SendChatAction>;
};

/**
 * The chat turn queue: local queued turns (enqueue while a run is active,
 * FIFO drain on run end, in-composer editing with slot restore).
 */
export function useChatTurnQueue(params: UseChatTurnQueueParams) {
  const {
    settings,
    currentConversationId,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    isConversationRunning,
    runningConversationIds,
    getConversationAbortController,
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    sendActionRef,
  } = params;

  const [queuedChatTurns, setQueuedChatTurns] = useState<QueuedChatTurn[]>([]);
  const queuedChatTurnsRef = useRef<QueuedChatTurn[]>([]);
  const queuedChatProcessingConversationIdsRef = useRef(new Set<string>());
  const queuedChatTurnEditSlotRef = useRef<
    | (QueuedChatTurnEditSlot & {
        originalId: string;
        createdAt: number;
        executionMode: ExecutionMode;
        workdir: string;
        selectedSystemToolIds: SystemToolId[];
        runtimeControls: ChatRuntimeControls;
      })
    | null
  >(null);
  const chatQueueRevisionRef = useRef(0);
  const previousRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());

  const setQueuedChatTurnsState = useCallback(
    (updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]) => {
      const previous = queuedChatTurnsRef.current;
      const next = updater(previous).slice();
      queuedChatTurnsRef.current = next;
      setQueuedChatTurns(next);
      chatQueueRevisionRef.current += 1;
      return next;
    },
    [],
  );

  const queuedChatTurnsForCurrentConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns
        .filter((item) => item.conversationId === currentConversationId)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        })),
    [currentConversationId, queuedChatTurns],
  );

  function stopConversation(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return false;
    const controller = getConversationAbortController(targetConversationId);
    if (!controller) return false;
    const transcriptStore = getConversationLiveTranscriptStore(targetConversationId);
    captureAbortSnapshot(transcriptStore);
    updateToolStatus("正在停止当前任务...", transcriptStore);
    controller.abort();
    return true;
  }

  function stopSending() {
    const conversationId = currentConversationIdRef.current.trim();
    if (!conversationId) return;
    const nextQueuedTurn = queuedChatTurnsRef.current.find(
      (item) => item.conversationId === conversationId,
    );
    if (nextQueuedTurn) {
      // Composer Stop is stop-and-continue when this conversation already
      // has queued work; runQueuedTurnNow records the resume intent before
      // aborting the current run.
      runQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    if (!stopConversation(conversationId)) {
      requestQueuedChatTurnProcessing(conversationId);
    }
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    clearCachedComposerDraft(targetConversationId);
  }

  function enqueueCurrentComposerTurn(position: "end" | "edit") {
    const conversationId = currentConversationIdRef.current.trim();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!conversationId || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      buildRuntimeEntryFromVisibleState();
    const editSlot =
      position === "edit" && queuedChatTurnEditSlotRef.current?.conversationId === conversationId
        ? queuedChatTurnEditSlotRef.current
        : null;
    const executionMode = editSlot?.executionMode ?? settings.system.executionMode;
    const workdirForTurn = isAgentExecutionMode(executionMode)
      ? (
          editSlot?.workdir ??
          runtimeEntry.workdir ??
          displayedConversationWorkdir ??
          settings.system.workdir
        ).trim()
      : "";
    const queuedTurn = createQueuedChatTurn({
      id: editSlot?.originalId,
      conversationId,
      draft,
      uploadedFiles,
      executionMode,
      workdir: workdirForTurn,
      selectedSystemToolIds: editSlot?.selectedSystemToolIds ?? settings.system.selectedSystemTools,
      runtimeControls: editSlot?.runtimeControls ?? settings.chatRuntimeControls,
      createdAt: editSlot?.createdAt,
    });

    setQueuedChatTurnsState((current) => {
      if (editSlot) {
        return insertQueuedChatTurnAtSlot(current, queuedTurn, editSlot);
      }
      return appendQueuedChatTurn(current, queuedTurn);
    });
    if (editSlot) {
      queuedChatTurnEditSlotRef.current = null;
    }
    clearCurrentComposerDraftForQueuedTurn(conversationId);
    return true;
  }

  function isQueuedChatTurnEditBlockingProcessing(conversationId: string) {
    const slot = queuedChatTurnEditSlotRef.current;
    if (!slot || slot.conversationId !== conversationId.trim()) return false;
    const queue = queuedChatTurnsRef.current;
    const firstQueuedIndex = queue.findIndex((item) => item.conversationId === slot.conversationId);
    if (firstQueuedIndex < 0) return false;
    return resolveQueuedChatTurnSlotIndex(queue, slot) <= firstQueuedIndex;
  }

  function requestQueuedChatTurnProcessing(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return;
    if (queuedChatProcessingConversationIdsRef.current.has(targetConversationId)) return;
    if (isConversationRunning(targetConversationId)) return;
    if (isQueuedChatTurnEditBlockingProcessing(targetConversationId)) return;
    if (!queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)) {
      return;
    }

    queuedChatProcessingConversationIdsRef.current.add(targetConversationId);
    let inFlightQueuedTurn: QueuedChatTurn | null = null;
    void Promise.resolve()
      .then(async () => {
        if (isConversationRunning(targetConversationId)) return;
        const taken = takeNextQueuedChatTurn(queuedChatTurnsRef.current, targetConversationId);
        if (!taken.item) return false;
        const queuedTurn = taken.item;
        inFlightQueuedTurn = queuedTurn;
        setQueuedChatTurnsState(() => taken.queue);
        const accepted = await sendActionRef.current({
          composerDraftOverride: queuedTurn.draft,
          uploadedFilesOverride: queuedTurn.uploadedFiles,
          conversationIdOverride: targetConversationId,
          executionModeOverride: queuedTurn.executionMode,
          workdirOverride: queuedTurn.workdir,
          selectedSystemToolIdsOverride: queuedTurn.selectedSystemToolIds,
          runtimeControlsOverride: queuedTurn.runtimeControls,
          preserveComposerOnStart: true,
        });
        if (!accepted) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(appendQueuedChatTurn(current, queuedTurn), queuedTurn.id),
          );
          inFlightQueuedTurn = null;
        }
        return accepted;
      })
      .then((accepted) => {
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
        if (
          accepted &&
          !isConversationRunning(targetConversationId) &&
          queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)
        ) {
          requestQueuedChatTurnProcessing(targetConversationId);
        }
      })
      .catch(() => {
        const failedQueuedTurn = inFlightQueuedTurn;
        if (failedQueuedTurn) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(
              appendQueuedChatTurn(current, failedQueuedTurn),
              failedQueuedTurn.id,
            ),
          );
          inFlightQueuedTurn = null;
        }
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
      });
  }

  useEffect(() => {
    const previousRunningConversationIds = previousRunningConversationIdsRef.current;
    previousRunningConversationIdsRef.current = runningConversationIds;
    for (const conversationId of getQueuedConversationIds(queuedChatTurnsRef.current)) {
      if (
        previousRunningConversationIds.has(conversationId) &&
        !runningConversationIds.has(conversationId)
      ) {
        requestQueuedChatTurnProcessing(conversationId);
      }
    }
  }, [runningConversationIds, queuedChatTurns]);

  function runQueuedTurnNow(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    if (!queuedTurn) return;
    setQueuedChatTurnsState((current) => promoteQueuedChatTurn(current, queuedTurn.id));
    if (isConversationRunning(queuedTurn.conversationId)) {
      stopConversation(queuedTurn.conversationId);
      return;
    }
    requestQueuedChatTurnProcessing(queuedTurn.conversationId);
  }

  function moveQueuedTurnUp(id: string) {
    setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, id, "up"));
  }

  function editQueuedTurn(id: string) {
    const key = id.trim();
    const queuedTurnIndex = queuedChatTurnsRef.current.findIndex((item) => item.id === key);
    const queuedTurn = queuedTurnIndex >= 0 ? queuedChatTurnsRef.current[queuedTurnIndex] : null;
    if (!queuedTurn) return;
    const targetConversationId = queuedTurn.conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current.trim() !== targetConversationId) {
      return;
    }

    const currentDraft = composerRef.current?.getDraft() ?? null;
    const currentUploads = pendingUploadedFiles.slice();
    if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
      enqueueCurrentComposerTurn(queuedChatTurnEditSlotRef.current ? "edit" : "end");
    }

    const sameConversationQueue = queuedChatTurnsRef.current.filter(
      (item) => item.conversationId === targetConversationId,
    );
    const sameConversationIndex = sameConversationQueue.findIndex((item) => item.id === key);
    const previousId =
      sameConversationIndex > 0
        ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
        : null;
    const nextId =
      sameConversationIndex >= 0
        ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
        : null;
    queuedChatTurnEditSlotRef.current = {
      conversationId: targetConversationId,
      previousId,
      nextId,
      index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
      originalId: queuedTurn.id,
      createdAt: queuedTurn.createdAt,
      executionMode: queuedTurn.executionMode,
      workdir: queuedTurn.workdir,
      selectedSystemToolIds: queuedTurn.selectedSystemToolIds.slice(),
      runtimeControls: { ...queuedTurn.runtimeControls },
    };
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, key));
    composerRef.current?.setDraft(queuedTurn.draft);
    setPendingUploadsForConversation(targetConversationId, queuedTurn.uploadedFiles);
    clearCachedComposerDraft(targetConversationId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQueuedTurn(id: string) {
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, id));
  }

  return {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    queuedChatTurnsForCurrentConversation,
    stopConversation,
    stopSending,
    enqueueCurrentComposerTurn,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
  };
}
