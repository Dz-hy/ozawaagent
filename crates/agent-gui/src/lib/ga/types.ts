export type GaRuntimePhase =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "failed";
export type GaRuntimeStatus = {
  phase: GaRuntimePhase;
  pid?: number | null;
  port?: number | null;
  restartCount: number;
  lastError?: string | null;
  generation: number;
};
export type GaRuntimeStartResponse = { status: GaRuntimeStatus; baseUrl: string; token: string };

export type GaSessionModel = {
  current?: string | null;
  isMixin?: boolean;
  llmNo?: number | null;
};
export type GaSetSessionModelResult = {
  ok: boolean;
  sessionId: string;
  llmNo: number;
  model?: GaSessionModel | null;
};
export type GaModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type GaModelServiceTier = "auto" | "default" | "priority" | "flex";
export type GaModelThinkingType = "adaptive" | "enabled" | "disabled";
export type GaSessionRuntime = {
  reasoning_effort: GaModelReasoningEffort | null;
  service_tier: GaModelServiceTier | null;
  thinking_type: GaModelThinkingType | null;
};
export type GaSessionRuntimePatch = Partial<GaSessionRuntime>;
export type GaSessionRuntimeResult = GaSessionRuntime & { sessionId?: string };
export type GaSessionDto = {
  id: string;
  title?: string;
  cwd?: string;
  projectId?: string;
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
  model?: GaSessionModel | null;
  [key: string]: unknown;
};
export type GaMessageDto = Record<string, unknown> & {
  id?: string | number;
  role?: string;
  content?: string;
  ts?: number;
  timestamp?: number;
  turn_segs?: string[];
  partial?: boolean;
  stopped?: boolean;
  event_id?: string;
};
export type GaMessagesSnapshot = {
  sessionId: string;
  status: string;
  messages: GaMessageDto[];
  partial?: GaMessageDto | null;
  msgSeq: number;
  updatedAt?: number;
  lastError?: string;
  model?: unknown;
};
export type GaPromptRequest = {
  prompt: string;
  display?: string;
  files?: Array<{ name: string; path: string }>;
  imageMetas?: Array<{ name: string; path: string }>;
};
export type GaPromptAccepted = {
  ok: boolean;
  sessionId: string;
  accepted: boolean;
  userMessageId: number;
  seq: number;
};
export type GaCommandDto = {
  id: string;
  name: string;
  title: string;
  description: string;
  arg_hint: string;
  owner: "ga" | string;
  api_version: string;
  plugin_version: string;
  argument_schema: Record<string, unknown>;
  permissions: string[];
  aliases?: string[];
  kind?: "control" | "prompt" | string;
  requires_capabilities?: string[];
};
export type GaBridgeCapabilities = {
  capabilities: string[];
  events: string[];
  unknown_events_preserved?: boolean;
};
export type GaCommandPromptResult = { type: "prompt"; prompt: string };
export type GaCommandControlResult = {
  type: "control";
  handled: boolean;
  runtime: GaSessionRuntime;
  model?: GaSessionModel | null;
};
export type GaCommandResult = {
  command_id: string;
  result: GaCommandPromptResult | GaCommandControlResult;
};
export type GaProjectMemoryStatus = {
  projectId: string;
  status: "missing" | "empty" | "available";
  lineCount: number;
  updatedAt: string | null;
};
export type GaTokenUsageRecord = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  model: string;
  timestamp?: number;
};
export type GaTokenStatsSnapshot = {
  schema: "ga.token_usage.v1";
  records: GaTokenUsageRecord[];
  truncated: boolean;
};
export type GaTokenHistorySnapshot = {
  schema: "ga.token_usage.v1";
  history: GaTokenUsageRecord[];
  truncated: boolean;
};
export type GaModelProtocol = "oai" | "claude" | "unknown";
export type GaModelProtocolSource = "official" | "var_name_heuristic" | "unknown";
export type GaModelApiMode = "chat_completions" | "responses";
export type GaModelProfile = {
  id: number;
  varName?: string;
  kind: "native" | "mixin";
  name: string;
  model?: string;
  active: boolean;
  protocol?: GaModelProtocol;
  protocol_source?: GaModelProtocolSource;
  group?: "native" | "std";
  in_mixin?: boolean;
  members?: string[];
  apibase?: string;
  api_key_configured?: boolean;
  max_retries?: number;
  connect_timeout?: number;
  read_timeout?: number;
  stream?: boolean;
  api_mode?: GaModelApiMode;
  reasoning_effort?: GaModelReasoningEffort;
  service_tier?: GaModelServiceTier;
  thinking_type?: GaModelThinkingType;
  thinking_budget_tokens?: number;
  temperature?: number;
  max_tokens?: number;
  context_win?: number;
  trim_keep_prefix?: number;
  proxy?: string;
  proxy_configured?: boolean;
  user_agent?: string;
  originator?: string;
  codex_client?: boolean;
  codex_client_metadata?: boolean;
  fake_cc_system_prompt?: boolean;
  verify?: boolean;
  omit_thinking?: boolean;
};
export type GaModelProfileInput = {
  protocol?: Exclude<GaModelProtocol, "unknown">;
  name?: string;
  model?: string;
  apibase?: string;
  api_key?: string;
  max_retries?: number;
  connect_timeout?: number;
  read_timeout?: number;
  stream?: boolean;
  api_mode?: GaModelApiMode;
  reasoning_effort?: GaModelReasoningEffort | "";
  service_tier?: GaModelServiceTier | "";
  thinking_type?: GaModelThinkingType | "";
  thinking_budget_tokens?: number | null;
  temperature?: number | null;
  max_tokens?: number | null;
  context_win?: number | null;
  trim_keep_prefix?: number | null;
  proxy?: string;
  user_agent?: string;
  originator?: string;
  codex_client?: boolean;
  codex_client_metadata?: boolean;
  fake_cc_system_prompt?: boolean;
  verify?: boolean;
  omit_thinking?: boolean;
};
export type GaModelProfilesSnapshot = { profiles: GaModelProfile[] };
export type GaKnowledgeSkill = {
  id: string;
  kind: string;
  triggers: string[];
  verified: boolean;
};
export type GaMemoryLayer = { id: string; name: string; purpose: string };
export type GaKnowledgeCatalog = {
  schema: "ga.knowledge_catalog.v1";
  read_only: true;
  registry_state: "loaded" | "unavailable";
  skills: GaKnowledgeSkill[];
  memory: { layers: GaMemoryLayer[] };
  morphling: {
    kind: string;
    summary: string;
    completion: string;
    skill_ids: string[];
  };
};
export type GaGovernanceCategory =
  | "command"
  | "command_pack"
  | "skill"
  | "connector"
  | "hook"
  | "automation";
export type GaGovernanceAuditCategory = GaGovernanceCategory | "confirmation" | "policy";
export type GaGovernanceSource = "builtin" | "user" | "third_party" | "unknown";
export type GaGovernanceRisk =
  | "shell"
  | "write"
  | "delete"
  | "network"
  | "credentials"
  | "scheduled";
// 高危执行确认（票 05）：adapter 409 载荷 + /governance/confirm 请求/响应。
export type GaExecutionDecision = "approved" | "denied";
export type GaExecutionConfirmation = {
  category: "command" | "connector";
  target: string;
  name: string;
  risks: GaGovernanceRisk[];
  source: GaGovernanceSource;
  state: "required" | "approved" | "denied" | "not_required";
};
export type GaGovernanceItem = {
  category: GaGovernanceCategory;
  id: string;
  name: string;
  description: string;
  kind: string;
  source: GaGovernanceSource;
  risk: GaGovernanceRisk[];
  scope: string;
  enabled: boolean | null;
  valid: boolean;
  detail: Record<string, unknown>;
};
export type GaGovernanceInventory = {
  schema: "ga.governance_inventory.v1";
  read_only: true;
  items: GaGovernanceItem[];
};
// 治理策略（票 06）：资产启用/禁用（global/project 作用域）与出站 HTTP 域名 allowlist。
export type GaGovernancePolicyScope = "global" | "project";
export type GaGovernancePolicyEntry = {
  category: "command" | "connector";
  target: string;
  enabled: boolean;
  scope: GaGovernancePolicyScope;
  project_id: string | null;
};
export type GaGovernancePolicy = {
  schema: "ga.governance_policy.v1";
  allowlist: string[];
  entries: GaGovernancePolicyEntry[];
};
export type GaGovernancePolicyInput = {
  allowlist: string[];
  entries: GaGovernancePolicyEntry[];
};
export type GaGovernanceAuditOutcome = "ok" | "error";
export type GaGovernanceAuditRecord = {
  id: string;
  category: GaGovernanceAuditCategory;
  target: string;
  timestamp: string;
  outcome: GaGovernanceAuditOutcome;
  params_summary: string | null;
  error: string | null;
  source: "adapter" | "ga";
};
export type GaGovernanceAudit = {
  schema: "ga.governance_audit.v1";
  items: GaGovernanceAuditRecord[];
};
export type GaHookRegistration = { event: string; module: string; handler: string };
export type GaHookObservation = { id: string; event: string; timestamp: string };
export type GaHooksSnapshot = {
  registry_state: "loaded" | "not_loaded";
  events: string[];
  registrations: GaHookRegistration[];
  observations: GaHookObservation[];
};
export type GaCommandPackInfo = {
  pack_id: string;
  file: string;
  valid: boolean;
  command_ids: string[];
};
export type GaCommandPluginInfo = {
  file: string;
  module: string;
  loaded: boolean;
  command_ids: string[];
};
export type GaCommandPackConflict = { command_id: string; sources: string[] };
export type GaCommandPacksSnapshot = {
  packs: GaCommandPackInfo[];
  plugins: GaCommandPluginInfo[];
  conflicts: GaCommandPackConflict[];
  loaded_command_count: number;
};
export type GaConnectorInfo = {
  name: string;
  schema: string;
  transport: "stdio" | "http" | string;
  command?: string;
  args?: string[];
  url?: string;
  env_keys: string[];
  redact_keys: string[];
  valid: boolean;
  error?: string;
};
export type GaConnectorsSnapshot = { connectors: GaConnectorInfo[] };
export type GaMcpTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};
export type GaMcpToolsPayload = { connector: string; tools: GaMcpTool[] };
export type GaMcpCallResult = {
  connector: string;
  tool: string;
  content: string;
  truncated: boolean;
};
export type GaMorphlingSuggestion = {
  class: string;
  reasons: string[];
  analyzed_chars: number;
};
export type GaMorphlingClassifyResult = {
  schema: string;
  suggestion: GaMorphlingSuggestion;
};
export type GaAutomation = {
  id: string;
  schedule: string;
  repeat: string;
  enabled: boolean;
  prompt: string;
  max_delay_hours: number;
};
export type GaAutomationDiagnostic = { id: string; code: string };
export type GaAutomationsSnapshot = {
  automations: GaAutomation[];
  diagnostics: GaAutomationDiagnostic[];
};
export type GaAutomationRun = { id: string; timestamp: string; size: number };
export type GaAutomationInput = Omit<GaAutomation, "id"> & { id: string };
export type GaServiceState = {
  id: string;
  name?: string;
  status: "running" | "offline" | "error" | string;
  running: boolean;
  lastError?: string;
  memMb?: number;
  cpuPct?: number;
  managed?: boolean;
  pid?: number | null;
};
export type GaServicePanel = { services: GaServiceState[] };
export type GaServiceLogs = {
  ok?: boolean;
  lines?: string[];
  error?: string;
};
export type GaRuntimeHealth = {
  status: string;
  official_bridge?: string;
};
export type GaRuntimeVersion = {
  adapter_version?: string;
  api_version?: string;
  ga_commit?: string;
};
export type GaMemoryImportResult = {
  ok?: boolean;
  error?: string;
  memory_copied?: number;
  responses_copied?: number;
  responses_skipped?: number;
  backup_dir?: string;
  sessions_imported?: number;
};
export type GaConductorSubagent = {
  id: string;
  status: "running" | "stopped" | "unknown";
  prompt: string;
  reply: string;
  createdAt?: number;
  updatedAt?: number;
};
export type GaConductorChatItem = {
  id: string;
  role: "conductor" | "system" | "user" | "unknown";
  message: string;
  timestamp?: number;
};
export type GaConductorSnapshot = {
  schema: "ga.conductor.v1";
  read_only: true;
  available: boolean;
  subagents: GaConductorSubagent[];
  chat: GaConductorChatItem[];
  counts: { running: number; stopped: number };
};
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
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GaBridgeError";
  }
}
