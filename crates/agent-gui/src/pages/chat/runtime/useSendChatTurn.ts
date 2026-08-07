import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect } from "react";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "../../../components/chat/MentionComposer";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "../../../lib/chat/messages/uploadedFiles";
import type { ScrollFollowHandle } from "../../../lib/chat-scroll/useScrollFollow";
import { gaBridgeClient } from "../../../lib/ga/GaBridgeClient";
import { registerGaAskSender } from "../../../lib/ga/gaAskUser";
import type { GaCommandControlResult } from "../../../lib/ga/types";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  isAgentExecutionMode,
  type SystemToolId,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import type { SkillSummary } from "../../../lib/skills";
import type { SubagentStoreManager } from "../../../lib/subagents";
import { asErrorMessage } from "../chatPageUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "../composer/composerDraftText";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import { runLegacyTextTurn } from "../turns/runTextConversationTurn";
import { expandGaCommandPrompt } from "./gaCommands";
import { resolveEffectiveChatModelSelection } from "./modelSelection";
import { buildProviderRuntimeConfig } from "./providerRuntimeConfig";
import { runGaChatTurn } from "./runGaChatTurn";

type LiveTranscriptController = ReturnType<typeof useLiveTranscriptController>;
type ChatPageRuntimeStore = ReturnType<typeof useChatPageRuntimeStore>;

export type SendChatAction = (overrides?: {
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  selectedSystemToolIdsOverride?: SystemToolId[];
  runtimeControlsOverride?: ChatRuntimeControls;
  preserveComposerOnStart?: boolean;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type UseSendChatTurnParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  getMcpSettings: () => AppSettings["mcp"];
  t: (key: string) => string;
  sidebarStore: SidebarStore;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  subagentStoresRef: MutableRefObject<SubagentStoreManager>;
  scrollFollowRef: MutableRefObject<ScrollFollowHandle | null>;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  composerDraftCacheRef: MutableRefObject<Map<string, MentionComposerDraft>>;
  clearCachedComposerDraft: (conversationId?: string) => void;
  resetVisibleTransientState: (conversationId?: string) => void;
  isImportingPastedTextRef: MutableRefObject<boolean>;
  setIsImportingPastedText: Dispatch<SetStateAction<boolean>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  onGaControlResult?: (control: GaCommandControlResult, conversationId: string) => void;
  hydratingConversationIdRef: MutableRefObject<string | null>;
  hydrationFailedConversationIdRef: MutableRefObject<string | null>;
  currentConversationIdRef: ChatPageRuntimeStore["currentConversationIdRef"];
  conversationRuntimeCacheRef: ChatPageRuntimeStore["conversationRuntimeCacheRef"];
  buildRuntimeEntryFromVisibleState: ChatPageRuntimeStore["buildRuntimeEntryFromVisibleState"];
  updateConversationRuntimeEntry: ChatPageRuntimeStore["updateConversationRuntimeEntry"];
  setConversationAbortController: ChatPageRuntimeStore["setConversationAbortController"];
  setConversationSendingState: ChatPageRuntimeStore["setConversationSendingState"];
  pendingUploadedFiles: PendingUploadedFile[];
  getPendingUploadsForConversation: (conversationId: string) => PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  getConversationLiveTranscriptStore: LiveTranscriptController["getConversationLiveTranscriptStore"];
  getCompactionController: LiveTranscriptController["getCompactionController"];
  clearAbortSnapshot: LiveTranscriptController["clearAbortSnapshot"];
  getAbortSnapshot: LiveTranscriptController["getAbortSnapshot"];
  resetLiveTranscript: LiveTranscriptController["resetLiveTranscript"];
  appendDraftAssistantText: LiveTranscriptController["appendDraftAssistantText"];
  batchLiveRoundsUpdate: LiveTranscriptController["batchLiveRoundsUpdate"];
  updateToolStatus: LiveTranscriptController["updateToolStatus"];
  updateRetryAttempts: LiveTranscriptController["updateRetryAttempts"];
  availableSkills: SkillSummary[];
  skillsRootDir: string;
  refreshSkills: () => Promise<{ skills: SkillSummary[]; rootDir: string } | null>;
  selectedSkillNames: string[];
  activeAgentPrompt: string;
  ensureTunnelToolTab: (projectPathKey?: string) => void;
  ensureSshTunnelToolTab: (projectPathKey?: string) => void;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
  pruneIdleConversationCaches: (extraKeepIds?: Iterable<string>) => void;
  requestQueuedChatTurnProcessing: (conversationId: string) => void;
};

export function useSendChatTurn(params: UseSendChatTurnParams) {
  const {
    settings,
    scrollFollowRef,
    composerRef,
    composerDraftCacheRef,
    clearCachedComposerDraft,
    resetVisibleTransientState,
    isImportingPastedTextRef,
    setIsImportingPastedText,
    setErrorMessage,
    onGaControlResult,
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    updateConversationRuntimeEntry,
    setConversationAbortController,
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    appendDraftAssistantText,
    requestQueuedChatTurnProcessing,
  } = params;

  async function send(overrides?: {
    textOverride?: string;
    composerDraftOverride?: MentionComposerDraft;
    uploadedFilesOverride?: PendingUploadedFile[];
    conversationIdOverride?: string;
    executionModeOverride?: ExecutionMode;
    workdirOverride?: string;
    selectedSystemToolIdsOverride?: SystemToolId[];
    runtimeControlsOverride?: ChatRuntimeControls;
    preserveComposerOnStart?: boolean;
    beforeRuntimeStart?: () => Promise<void>;
    afterInitialHistoryPersist?: () => Promise<void>;
    editResendBaseMessageRef?: HistoryMessageRef;
  }) {
    const overrideConversationId = overrides?.conversationIdOverride?.trim() ?? "";
    const conversationId = overrideConversationId || currentConversationIdRef.current;
    if (!conversationId) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      (conversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);

    const effectiveExecutionMode =
      overrides?.executionModeOverride ?? settings.system.executionMode;
    const effectiveIsAgentMode = isAgentExecutionMode(effectiveExecutionMode);
    const effectiveWorkdir = (
      overrides?.workdirOverride ??
      (effectiveIsAgentMode ? (runtimeEntry?.workdir ?? settings.system.workdir) : "")
    ).trim();
    const setConversationErrorState = (message: string | null) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: message,
      }));
    };
    if (!runtimeEntry) {
      const message = `Conversation runtime not found: ${conversationId}`;
      throw new Error(message);
    }
    const modelMode = runtimeEntry.modelMode ?? (runtimeEntry.selectedModel ? "legacy" : "ga");
    const legacySelection =
      modelMode === "legacy"
        ? resolveEffectiveChatModelSelection({
            settings,
            conversationSelectedModel: runtimeEntry.selectedModel,
          })
        : null;
    const legacyProvider = legacySelection?.provider;

    if (runtimeEntry.isSending) {
      return false;
    }
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return false;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      const message = "当前会话仍在补全完整历史，请稍候。";
      setConversationErrorState(message);
      return false;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      const message = "当前会话完整历史加载失败，请重新打开该会话后再继续。";
      setConversationErrorState(message);
      return false;
    }
    if (runtimeEntry.compactionStatus.phase !== "idle") {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        compactionStatus: { phase: "idle" },
      }));
    }

    // GenericAgent is the sole owner of chat semantics.
    const textOverride =
      typeof overrides?.textOverride === "string" ? overrides.textOverride : null;
    const hasTextOverride = textOverride !== null;
    const composerDraft = hasTextOverride
      ? null
      : (overrides?.composerDraftOverride ?? composerRef.current?.getDraft() ?? null);
    let text = hasTextOverride
      ? textOverride.trim()
      : composerDraft
        ? (effectiveIsAgentMode && composerDraft.largePastes.length > 0
            ? composerDraft.textWithoutLargePastes
            : buildTextFromComposerDraft(composerDraft)
          ).trim()
        : "";
    let uploadedFiles = overrides?.uploadedFilesOverride ?? pendingUploadedFiles;

    if (
      effectiveIsAgentMode &&
      composerDraft &&
      composerDraft.largePastes.length > 0 &&
      !hasTextOverride
    ) {
      isImportingPastedTextRef.current = true;
      setIsImportingPastedText(true);
      try {
        const imported = await importPastedTextsAsFiles(
          effectiveWorkdir,
          composerDraft.largePastes,
        );
        text = buildTextFromComposerDraft(composerDraft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(uploadedFiles, imported.files);
      } catch (error) {
        const message = asErrorMessage(error, "大段粘贴内容导入附件失败");
        setConversationErrorState(message);
        setErrorMessage(message);
        return false;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }
    if (!text && uploadedFiles.length === 0) return false;

    let expandedText = text;
    let handledCommand = false;
    if (modelMode === "ga") {
      try {
        const expansion = await expandGaCommandPrompt(
          text,
          (commandId, argsText, sessionId) =>
            gaBridgeClient.executeCommand(commandId, argsText, sessionId),
          runtimeEntry.sessionId,
        );
        expandedText = expansion.text;
        handledCommand = expansion.handled;
        if (expansion.control) {
          onGaControlResult?.(expansion.control, conversationId);
        }
      } catch (error) {
        const message = asErrorMessage(error, "GenericAgent command failed");
        setConversationErrorState(message);
        setErrorMessage(message);
        return false;
      }
    }
    if (handledCommand) {
      if (!hasTextOverride && !overrides?.composerDraftOverride) {
        clearCachedComposerDraft(conversationId);
      }
      if (!overrides?.preserveComposerOnStart) resetVisibleTransientState(conversationId);
      return false;
    }

    const abortController = new AbortController();
    const baseState = runtimeEntry.state;
    const visible = currentConversationIdRef.current === conversationId;
    const savedDraft = composerDraft && !composerDraft.isEmpty ? composerDraft : null;
    const savedUploads = uploadedFiles.slice();
    if (!hasTextOverride && !overrides?.composerDraftOverride) {
      clearCachedComposerDraft(conversationId);
    }
    if (!overrides?.preserveComposerOnStart) resetVisibleTransientState(conversationId);
    setConversationErrorState(null);
    setConversationAbortController(conversationId, abortController);
    setConversationSendingState(conversationId, true);
    if (visible) scrollFollowRef.current?.stickToBottom();

    try {
      if (modelMode === "legacy" && legacySelection && legacyProvider) {
        const transcriptStore = getConversationLiveTranscriptStore(conversationId);
        await runLegacyTextTurn({
          sessionId: runtimeEntry.sessionId,
          text,
          uploads: uploadedFiles,
          baseState,
          providerId: legacySelection.providerId,
          model: legacySelection.model,
          runtime: buildProviderRuntimeConfig(
            legacyProvider,
            legacySelection.model,
            overrides?.runtimeControlsOverride,
          ),
          workdir: effectiveWorkdir || undefined,
          signal: abortController.signal,
          onTextDelta: (delta) => appendDraftAssistantText(delta, transcriptStore),
          applyState: (state) =>
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              state,
              errorMessage: null,
            })),
        });
      } else {
        const files = uploadedFiles.flatMap((file) => {
          const path = file.absolutePath?.trim();
          return file.kind !== "image" && path ? [{ name: file.fileName, path }] : [];
        });
        const imageMetas = uploadedFiles.flatMap((file) => {
          const path = file.absolutePath?.trim();
          return file.kind === "image" && path ? [{ name: file.fileName, path }] : [];
        });
        const attachmentPaths = [...files, ...imageMetas].map((file) => file.path);
        const gaPrompt = [expandedText, ...attachmentPaths].filter(Boolean).join("\n");
        await runGaChatTurn({
          conversationId,
          prompt: {
            prompt: gaPrompt,
            display: text,
            ...(files.length > 0 ? { files } : {}),
            ...(imageMetas.length > 0 ? { imageMetas } : {}),
          },
          baseState,
          signal: abortController.signal,
          applyState: (state) =>
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              state,
              errorMessage: null,
            })),
        });
      }
      return true;
    } catch (error) {
      const message = asErrorMessage(error, "GenericAgent request failed");
      setConversationErrorState(message);
      if (!abortController.signal.aborted) {
        if (visible && savedDraft && composerRef.current && !composerRef.current.hasContent()) {
          composerRef.current.setDraft(savedDraft);
        } else if (savedDraft && !composerDraftCacheRef.current.has(conversationId)) {
          composerDraftCacheRef.current.set(conversationId, savedDraft);
        }
        if (
          savedUploads.length > 0 &&
          getPendingUploadsForConversation(conversationId).length === 0
        ) {
          setPendingUploadsForConversation(conversationId, savedUploads);
        }
      }
      return true;
    } finally {
      setConversationAbortController(conversationId, null);
      setConversationSendingState(conversationId, false);
      requestQueuedChatTurnProcessing(conversationId);
    }
  }

  useEffect(() => {
    const conversationId = currentConversationIdRef.current;
    if (!conversationId) return undefined;
    return registerGaAskSender(conversationId, (prompt) =>
      send({
        textOverride: prompt,
        uploadedFilesOverride: [],
        conversationIdOverride: conversationId,
        preserveComposerOnStart: true,
      }),
    );
  });

  return { send };
}
