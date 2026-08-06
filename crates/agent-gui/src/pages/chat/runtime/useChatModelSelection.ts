import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setChatHistoryModel } from "../../../lib/chat/history/chatHistory";
import { buildModelOptions } from "../../../lib/chat/page/chatPageHelpers";
import { gaBridgeClient } from "../../../lib/ga/GaBridgeClient";
import type {
  GaModelProfile,
  GaSessionRuntime,
  GaSessionRuntimePatch,
} from "../../../lib/ga/types";
import { isThinkingAlwaysOnForModel, toModelValue } from "../../../lib/providers/llm";
import {
  type AppSettings,
  type ChatRuntimeControls,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControls,
  normalizeChatRuntimeControlsForProvider,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  type ReasoningLevel,
  type SelectedModel,
  serializeSelectedModelJson,
  setSelectedModel,
  updateChatRuntimeControlsForProvider,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import type { SidebarConversation } from "../../../lib/sidebar/types";
import { asErrorMessage } from "../chatPageUtils";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import { resolveActiveModelSelection } from "./modelSelection";
import { selectedModelsMatch } from "./providerRuntimeConfig";

type UseChatModelSelectionParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  t: (key: string) => string;
  sidebarStore: SidebarStore;
  sidebarConversationsById: ReadonlyMap<string, SidebarConversation>;
  currentConversationId: string;
  currentConversationSessionId: string;
  currentConversationSelectedModel: SelectedModel | undefined;
  gaModelProfiles: readonly GaModelProfile[];
  gaCurrentModelNo?: number | null;
  onSelectGaProfile: (profileId: number) => void;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => ConversationRuntimeEntry;
};

const GA_RUNTIME_REASONING_OPTIONS: ReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function gaReasoningToUi(
  value: GaSessionRuntime["reasoning_effort"] | GaModelProfile["reasoning_effort"],
  fallback: ReasoningLevel,
): ReasoningLevel {
  if (!value) return fallback;
  return value === "none" ? "off" : value;
}

function uiReasoningToGa(value: ReasoningLevel): NonNullable<GaSessionRuntime["reasoning_effort"]> {
  return value === "off" ? "none" : value;
}

/**
 * Per-conversation model selection UI state: the model dropdown options and
 * labels, the runtime-controls (reasoning / web search) derivations for the
 * current provider, the selection handler that persists per-conversation
 * model choices, and the history-sync write-back of remotely-selected models.
 */
export function useChatModelSelection(params: UseChatModelSelectionParams) {
  const {
    settings,
    setSettings,
    t,
    sidebarStore,
    sidebarConversationsById,
    currentConversationId,
    currentConversationSessionId,
    currentConversationSelectedModel,
    gaModelProfiles,
    gaCurrentModelNo,
    onSelectGaProfile,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    updateConversationRuntimeEntry,
  } = params;

  const [gaSessionRuntime, setGaSessionRuntime] = useState<GaSessionRuntime | null>(null);
  const gaSessionRuntimeRef = useRef<GaSessionRuntime | null>(null);
  useEffect(() => {
    const sessionId = currentConversationSessionId.trim();
    gaSessionRuntimeRef.current = null;
    setGaSessionRuntime(null);
    if (!sessionId) return undefined;
    let cancelled = false;
    void gaBridgeClient
      .getSessionRuntime(sessionId)
      .then((runtime) => {
        if (cancelled) return;
        gaSessionRuntimeRef.current = runtime;
        setGaSessionRuntime(runtime);
      })
      .catch(() => {
        if (!cancelled) {
          gaSessionRuntimeRef.current = null;
          setGaSessionRuntime(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentConversationSessionId]);

  const legacyModelOptions = useMemo(
    () => buildModelOptions(settings, { floatSelectedFirst: false }),
    [settings],
  );
  const gaModelOptions = useMemo(
    () =>
      gaModelProfiles.map((profile) => {
        const model = profile.model?.trim();
        const label =
          profile.kind === "mixin"
            ? profile.name?.trim() || profile.varName?.trim() || `channel-${profile.id}`
            : model || profile.name?.trim() || profile.varName?.trim() || `llm-${profile.id}`;
        return {
          value: `ga:${profile.id}`,
          label,
          providerId: "genericagent",
          providerName: "GenericAgent",
          providerType: "genericagent" as const,
          model: label,
          gaProfileId: profile.id,
        };
      }),
    [gaModelProfiles],
  );
  const modelOptions = useMemo(
    () => [...legacyModelOptions, ...gaModelOptions],
    [gaModelOptions, legacyModelOptions],
  );
  const activeSelectedModel = resolveActiveModelSelection(
    settings,
    currentConversationSelectedModel,
  );
  const defaultGaProfileId = gaModelProfiles.find((profile) => profile.active)?.id;
  const gaSelectedProfile = useMemo(
    () =>
      gaModelProfiles.find((profile) => profile.id === (gaCurrentModelNo ?? defaultGaProfileId)),
    [defaultGaProfileId, gaCurrentModelNo, gaModelProfiles],
  );
  const gaSelectedValue =
    gaCurrentModelNo != null &&
    gaModelOptions.some((option) => option.value === `ga:${gaCurrentModelNo}`)
      ? `ga:${gaCurrentModelNo}`
      : undefined;
  const legacySelectedValue = activeSelectedModel
    ? toModelValue(activeSelectedModel.customProviderId, activeSelectedModel.model)
    : undefined;
  const conversationModelMode =
    conversationRuntimeCacheRef.current.get(currentConversationId)?.modelMode;
  const inferredModelMode =
    conversationModelMode ??
    (currentConversationSelectedModel ? "legacy" : gaSelectedValue ? "ga" : "legacy");
  const gaModeActive = inferredModelMode === "ga";
  const selectedValue = gaModeActive ? gaSelectedValue : legacySelectedValue;
  const hasModels = modelOptions.length > 0;

  const currentModelLabel = (() => {
    const opt = modelOptions.find((option) => option.value === selectedValue);
    return opt ? `${opt.providerName} / ${opt.label}` : t("chat.selectModel");
  })();

  const currentModelContextWindow = (() => {
    if (!activeSelectedModel) return undefined;
    const provider = settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    if (!provider) return undefined;
    return findProviderModelConfig(provider, activeSelectedModel.model).contextWindow;
  })();
  const currentChatProvider = activeSelectedModel
    ? settings.customProviders.find((item) => item.id === activeSelectedModel.customProviderId)
    : undefined;
  const currentChatModelId = activeSelectedModel?.model;

  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const conversationId = currentConversationIdRef.current;
      updateConversationRuntimeEntry(conversationId, (prev) =>
        selectedModelsMatch(prev.selectedModel, selection) && prev.modelMode === "legacy"
          ? prev
          : { ...prev, selectedModel: selection, modelMode: "legacy" },
      );
      const persistedRow = sidebarStore.peek(conversationId);
      const selectedModelJson = serializeSelectedModelJson(selection);
      if (persistedRow && !persistedRow.isPending && selectedModelJson) {
        void setChatHistoryModel(conversationId, selectedModelJson)
          .then((summary) => sidebarStore.upsertLocal({ ...summary, isPending: undefined }))
          .catch((error) => {
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              errorMessage: asErrorMessage(error, "保存会话模型选择失败。"),
            }));
          });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [currentConversationIdRef, setSettings, sidebarStore, updateConversationRuntimeEntry],
  );

  // 跨端收敛：history-sync 带回的会话模型选择（如 WebUI 发消息后落库）
  // 写回当前会话的 runtime entry；值相等或发送中不动，无回环。
  const displayedConversationPersistedModelJson =
    sidebarConversationsById.get(currentConversationId)?.selectedModelJson;
  useEffect(() => {
    const parsed = normalizeSelectedModelForProviders(
      parseSelectedModelJson(displayedConversationPersistedModelJson),
      settings.customProviders,
    );
    if (!parsed) return;
    const entry = conversationRuntimeCacheRef.current.get(currentConversationId);
    if (!entry || entry.isSending) return;
    if (selectedModelsMatch(entry.selectedModel, parsed) && entry.modelMode === "legacy") return;
    updateConversationRuntimeEntry(currentConversationId, (prev) => ({
      ...prev,
      selectedModel: parsed,
      modelMode: "legacy",
    }));
  }, [
    conversationRuntimeCacheRef,
    currentConversationId,
    displayedConversationPersistedModelJson,
    settings.customProviders,
    updateConversationRuntimeEntry,
  ]);

  const currentChatModelConfig = useMemo(
    () =>
      currentChatProvider && currentChatModelId
        ? findProviderModelConfig(currentChatProvider, currentChatModelId)
        : undefined,
    [currentChatProvider, currentChatModelId],
  );
  const chatRuntimeReasoningParams = useMemo(
    () => ({
      providerId: currentChatProvider?.type,
      requestFormat: currentChatProvider?.requestFormat,
      modelId: currentChatModelId,
      baseUrl: currentChatProvider?.baseUrl,
      modelConfig: currentChatModelConfig,
    }),
    [
      currentChatModelConfig,
      currentChatModelId,
      currentChatProvider?.baseUrl,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
    ],
  );
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      gaModeActive
        ? GA_RUNTIME_REASONING_OPTIONS
        : getChatRuntimeReasoningLevelsForProvider(chatRuntimeReasoningParams),
    [chatRuntimeReasoningParams, gaModeActive],
  );
  const gaDefaultReasoning = gaReasoningToUi(
    gaSessionRuntime?.reasoning_effort ?? gaSelectedProfile?.reasoning_effort,
    "off",
  );
  const gaDefaultThinkingEnabled =
    (gaSessionRuntime?.thinking_type ?? gaSelectedProfile?.thinking_type) !== "disabled";
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      gaModeActive
        ? false
        : isThinkingAlwaysOnForModel(
            currentChatProvider?.type ?? "claude_code",
            currentChatModelId ?? "",
            currentChatProvider?.baseUrl ?? "",
            currentChatProvider?.requestFormat,
            currentChatModelConfig,
          ),
    [
      currentChatModelConfig,
      currentChatModelId,
      currentChatProvider?.baseUrl,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      gaModeActive,
    ],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(() => {
    if (gaModeActive) {
      const oldControls = normalizeChatRuntimeControls(settings.chatRuntimeControls);
      return {
        ...oldControls,
        reasoning: gaSessionRuntime
          ? gaReasoningToUi(gaSessionRuntime.reasoning_effort, gaDefaultReasoning)
          : gaDefaultReasoning,
        // gaDefaultThinkingEnabled already folds the session runtime's
        // authoritative thinking_type, so no extra branching is needed.
        thinkingEnabled: gaDefaultThinkingEnabled,
      };
    }
    return normalizeChatRuntimeControlsForProvider(
      settings.chatRuntimeControls,
      chatRuntimeReasoningParams,
    );
  }, [
    chatRuntimeReasoningParams,
    gaDefaultReasoning,
    gaDefaultThinkingEnabled,
    gaModeActive,
    gaSessionRuntime,
    settings.chatRuntimeControls,
  ]);
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      if (gaModeActive) {
        const sessionId = currentConversationSessionId.trim();
        if (!sessionId) return;
        const runtimePatch: GaSessionRuntimePatch = {};
        if (patch.reasoning !== undefined) {
          runtimePatch.reasoning_effort = uiReasoningToGa(patch.reasoning);
        }
        if (patch.thinkingEnabled !== undefined) {
          runtimePatch.thinking_type = patch.thinkingEnabled ? "enabled" : "disabled";
        }
        if (Object.keys(runtimePatch).length === 0) return;
        const previous = gaSessionRuntimeRef.current;
        const next: GaSessionRuntime = {
          reasoning_effort: runtimePatch.reasoning_effort ?? previous?.reasoning_effort ?? null,
          service_tier: previous?.service_tier ?? null,
          thinking_type: runtimePatch.thinking_type ?? previous?.thinking_type ?? null,
        };
        gaSessionRuntimeRef.current = next;
        setGaSessionRuntime(next);
        void gaBridgeClient.updateSessionRuntime(sessionId, runtimePatch).catch(() => {
          if (gaSessionRuntimeRef.current !== next) return;
          gaSessionRuntimeRef.current = previous;
          setGaSessionRuntime(previous);
        });
        return;
      }
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(
          prev.chatRuntimeControls,
          patch,
          chatRuntimeReasoningParams,
        ),
      }));
    },
    [currentConversationSessionId, gaModeActive, chatRuntimeReasoningParams, setSettings],
  );

  /**
   * Applies the authoritative session runtime returned by a GA control
   * command (e.g. /effort) to the same state owner that backs the visible
   * runtime controls. Guards against stale results from another
   * conversation, so a late control reply cannot pollute the current page.
   */
  const applyGaSessionRuntime = useCallback(
    (conversationId: string, runtime: GaSessionRuntime) => {
      if (conversationId !== currentConversationIdRef.current) return;
      gaSessionRuntimeRef.current = runtime;
      setGaSessionRuntime(runtime);
    },
    [currentConversationIdRef],
  );

  const handleSelectGaProfile = useCallback(
    (profileId: number) => {
      const conversationId = currentConversationIdRef.current;
      updateConversationRuntimeEntry(conversationId, (prev) =>
        prev.modelMode === "ga" ? prev : { ...prev, modelMode: "ga" },
      );
      onSelectGaProfile(profileId);
    },
    [currentConversationIdRef, onSelectGaProfile, updateConversationRuntimeEntry],
  );

  return {
    modelOptions,
    activeSelectedModel,
    selectedValue,
    hasModels,
    currentModelLabel,
    currentModelContextWindow,
    handleSelectModel,
    handleSelectGaProfile,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    chatRuntimeControlsForCurrentProvider,
    handleChatRuntimeControlsChange,
    applyGaSessionRuntime,
  };
}
