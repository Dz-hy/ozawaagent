import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Trash2,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaModelApiMode,
  GaModelProfile,
  GaModelProfileInput,
  GaModelProfilesSnapshot,
  GaModelProtocol,
  GaModelReasoningEffort,
  GaModelServiceTier,
  GaModelThinkingType,
} from "../../lib/ga/types";

const EMPTY_SNAPSHOT: GaModelProfilesSnapshot = { profiles: [] };
const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-input accent-primary focus:ring-2 focus:ring-primary/30";

type FormValue = {
  protocol: Exclude<GaModelProtocol, "unknown">;
  name: string;
  model: string;
  apibase: string;
  api_key: string;
  max_retries: string;
  connect_timeout: string;
  read_timeout: string;
  stream: boolean;
  api_mode: GaModelApiMode;
  reasoning_effort: GaModelReasoningEffort | "";
  service_tier: GaModelServiceTier | "";
  thinking_type: GaModelThinkingType | "";
  thinking_budget_tokens: string;
  temperature: string;
  max_tokens: string;
  context_win: string;
  trim_keep_prefix: string;
  proxy: string;
  user_agent: string;
  originator: string;
  codex_client: boolean;
  codex_client_metadata: boolean;
  fake_cc_system_prompt: boolean;
  verify: boolean;
  omit_thinking: boolean;
};

type EditorState =
  | { mode: "create"; value: FormValue }
  | { mode: "edit"; profileId: number; value: FormValue }
  | null;

type EditorSection = "connection" | "runtime" | "transport";

type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
};

function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground/80">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function emptyForm(): FormValue {
  return {
    protocol: "oai",
    name: "",
    model: "",
    apibase: "",
    api_key: "",
    max_retries: "",
    connect_timeout: "",
    read_timeout: "",
    stream: true,
    api_mode: "chat_completions",
    reasoning_effort: "",
    service_tier: "",
    thinking_type: "",
    thinking_budget_tokens: "",
    temperature: "",
    max_tokens: "",
    context_win: "",
    trim_keep_prefix: "",
    proxy: "",
    user_agent: "",
    originator: "",
    codex_client: false,
    codex_client_metadata: true,
    fake_cc_system_prompt: false,
    verify: true,
    omit_thinking: false,
  };
}

function formFromProfile(profile: GaModelProfile): FormValue {
  return {
    protocol: profile.protocol === "claude" ? "claude" : "oai",
    name: profile.name,
    model: profile.model ?? "",
    apibase: profile.apibase ?? "",
    api_key: "",
    max_retries: profile.max_retries?.toString() ?? "",
    connect_timeout: profile.connect_timeout?.toString() ?? "",
    read_timeout: profile.read_timeout?.toString() ?? "",
    stream: profile.stream ?? true,
    api_mode: profile.api_mode ?? "chat_completions",
    reasoning_effort: profile.reasoning_effort ?? "",
    service_tier: profile.service_tier ?? "",
    thinking_type: profile.thinking_type ?? "",
    thinking_budget_tokens: profile.thinking_budget_tokens?.toString() ?? "",
    temperature: profile.temperature?.toString() ?? "",
    max_tokens: profile.max_tokens?.toString() ?? "",
    context_win: profile.context_win?.toString() ?? "",
    trim_keep_prefix: profile.trim_keep_prefix?.toString() ?? "",
    proxy: profile.proxy ?? "",
    user_agent: profile.user_agent ?? "",
    originator: profile.originator ?? "",
    codex_client: profile.codex_client ?? false,
    codex_client_metadata: profile.codex_client_metadata ?? true,
    fake_cc_system_prompt: profile.fake_cc_system_prompt ?? false,
    verify: profile.verify ?? true,
    omit_thinking: profile.omit_thinking ?? false,
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function toInput(value: FormValue, creating: boolean): GaModelProfileInput {
  const input: GaModelProfileInput = {
    name: value.name.trim(),
    model: value.model.trim(),
    apibase: value.apibase.trim(),
    max_retries: optionalNumber(value.max_retries),
    connect_timeout: optionalNumber(value.connect_timeout),
    read_timeout: optionalNumber(value.read_timeout),
    stream: value.stream,
    api_mode: value.api_mode,
    reasoning_effort: value.reasoning_effort,
    service_tier: value.service_tier,
    thinking_type: value.thinking_type,
    thinking_budget_tokens: optionalNumber(value.thinking_budget_tokens),
    temperature: optionalNumber(value.temperature),
    max_tokens: optionalNumber(value.max_tokens),
    context_win: optionalNumber(value.context_win),
    trim_keep_prefix: optionalNumber(value.trim_keep_prefix),
    user_agent: value.user_agent.trim(),
    originator: value.originator.trim(),
    codex_client: value.codex_client,
    codex_client_metadata: value.codex_client_metadata,
    fake_cc_system_prompt: value.fake_cc_system_prompt,
    verify: value.verify,
    omit_thinking: value.omit_thinking,
  };
  // A redacted proxy is deliberately omitted so the backend preserves the
  // existing credential instead of ever receiving it from the UI.
  if (!value.proxy.includes("[REDACTED]")) input.proxy = value.proxy.trim();
  if (creating) input.protocol = value.protocol;
  // Empty keys on PATCH intentionally preserve the configured secret.
  if (creating || value.api_key !== "") input.api_key = value.api_key;
  return input;
}

export function GaModelProfilesSection() {
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<GaModelProfilesSnapshot>(EMPTY_SNAPSHOT);
  const [editor, setEditor] = useState<EditorState>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("connection");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.listModelProfiles());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (snapshot.profiles.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!snapshot.profiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(snapshot.profiles[0].id);
    }
  }, [selectedId, snapshot.profiles]);

  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setEditor(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, saving]);

  const filteredProfiles = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return snapshot.profiles;
    return snapshot.profiles.filter((profile) =>
      [profile.name, profile.model, profile.apibase, profile.protocol]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }, [searchQuery, snapshot.profiles]);

  const selectedProfile = snapshot.profiles.find((profile) => profile.id === selectedId) ?? null;
  const nativeCount = snapshot.profiles.filter((profile) => profile.kind === "native").length;
  const mixinCount = snapshot.profiles.filter((profile) => profile.kind === "mixin").length;

  async function saveEditor() {
    if (!editor) return;
    const value = editor.value;
    if (!value.model.trim() || !value.apibase.trim()) {
      setError("Model and API base are required.");
      return;
    }
    if (editor.mode === "create" && !value.api_key.trim()) {
      setError("API key is required for a new model profile.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editor.mode === "create") {
        const created = await gaBridgeClient.createModelProfile({
          ...toInput(value, true),
          protocol: value.protocol,
          model: value.model.trim(),
          apibase: value.apibase.trim(),
        });
        setSelectedId(created.id);
      } else {
        const updated = await gaBridgeClient.updateModelProfile(
          editor.profileId,
          toInput(value, false),
        );
        setSelectedId(updated.id);
      }
      setEditor(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(profile: GaModelProfile) {
    setBusyId(profile.id);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.setDefaultModelProfile(profile.id));
      setSelectedId(profile.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(profile: GaModelProfile) {
    if (!window.confirm(`Delete model profile “${profile.name || profile.model}”?`)) return;
    setBusyId(profile.id);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.deleteModelProfile(profile.id));
      if (editor?.mode === "edit" && editor.profileId === profile.id) setEditor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setEditorSection("connection");
    setEditor({ mode: "create", value: emptyForm() });
  }

  function openEdit(profile: GaModelProfile) {
    setSelectedId(profile.id);
    setEditorSection("connection");
    setEditor({ mode: "edit", profileId: profile.id, value: formFromProfile(profile) });
  }

  function updateForm<K extends keyof FormValue>(key: K, value: FormValue[K]) {
    setEditor((current) =>
      current ? { ...current, value: { ...current.value, [key]: value } } : current,
    );
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
              <Server className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">t("settings.gaModelTitle")</h2>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                t("settings.gaModelDesc")
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {snapshot.profiles.length > 0 ? (
              <div className="hidden items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
                <span className="tabular-nums font-medium text-foreground">{nativeCount}</span>
                native
                {mixinCount > 0 ? (
                  <>
                    <span className="text-border">|</span>
                    <span>{mixinCount} mix-in</span>
                  </>
                ) : null}
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              t("settings.gaModelRefresh")
            </Button>
            <Button type="button" size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              t("settings.gaModelAdd")
            </Button>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-white/[0.58] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none">
            <div className="border-b border-black/[0.06] p-3 dark:border-white/[0.08]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label={t("settings.gaModelSearchLabel")}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("settings.gaModelSearchPlaceholder")}
                  className="h-9 rounded-lg pl-9 text-xs"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading && snapshot.profiles.length === 0 ? (
                <div className="space-y-2 p-1">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="h-[4.75rem] animate-pulse rounded-xl bg-muted/60" />
                  ))}
                </div>
              ) : filteredProfiles.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs leading-5 text-muted-foreground">
                  {snapshot.profiles.length === 0
                    ? "No model profiles found. Add one to connect GenericAgent."
                    : "No profiles match this search."}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredProfiles.map((profile) => {
                    const isSelected = profile.id === selectedId;
                    const readOnly = profile.kind === "mixin";
                    return (
                      <button
                        type="button"
                        key={profile.id}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedId(profile.id)}
                        className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                          isSelected
                            ? "border-primary/20 bg-primary/10 text-foreground"
                            : "border-transparent hover:border-border hover:bg-muted/55"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                              profile.active ? "bg-emerald-500" : "bg-muted-foreground/35"
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">
                                {profile.name || profile.model || "Unnamed profile"}
                              </span>
                              {profile.active ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {profile.model || "No model configured"}
                            </span>
                            <span className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                              {readOnly ? "mix-in" : (profile.protocol ?? "unknown")}
                              {profile.api_key_configured ? (
                                <span>• t("settings.gaModelKeyReady")</span>
                              ) : null}
                            </span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white/[0.58] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none">
            {selectedProfile ? (
              <div className="flex h-full min-h-[28rem] flex-col">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/[0.06] px-5 py-4 dark:border-white/[0.08]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold">
                        {selectedProfile.name || selectedProfile.model || "Unnamed profile"}
                      </h3>
                      {selectedProfile.active ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          Default
                        </span>
                      ) : null}
                      <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                        {selectedProfile.kind === "mixin"
                          ? "Mix-in"
                          : (selectedProfile.protocol ?? "Unknown")}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {selectedProfile.model || "No model configured"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!selectedProfile.active ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void setDefault(selectedProfile)}
                        disabled={busyId !== null}
                      >
                        t("settings.gaModelSetDefault")
                      </Button>
                    ) : null}
                    {selectedProfile.kind !== "mixin" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => openEdit(selectedProfile)}
                        disabled={busyId !== null}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        t("settings.gaModelEdit")
                      </Button>
                    ) : null}
                    {selectedProfile.kind !== "mixin" ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => void remove(selectedProfile)}
                        disabled={busyId !== null || selectedProfile.active}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        t("settings.gaModelDelete")
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <InfoTile
                      label={t("settings.gaModelApiBase")}
                      value={selectedProfile.apibase || "Not configured"}
                      wide
                    />
                    <InfoTile
                      label={t("settings.gaModelApiKey")}
                      value={selectedProfile.api_key_configured ? "Configured" : "Not configured"}
                      tone={selectedProfile.api_key_configured ? "success" : "muted"}
                    />
                    <InfoTile
                      label={t("settings.gaModelProtocol")}
                      value={selectedProfile.protocol_source ?? "Unknown"}
                    />
                    <InfoTile
                      label={t("settings.gaModelStream")}
                      value={selectedProfile.stream === false ? "Disabled" : "Enabled"}
                    />
                  </div>

                  {selectedProfile.kind === "mixin" ? (
                    <div className="mt-5 rounded-xl border border-border/70 bg-muted/25 p-4">
                      <h4 className="text-sm font-semibold">t("settings.gaModelReadonlyMix")</h4>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t("settings.gaModelReadonlyDesc")}
                      </p>
                      {selectedProfile.members?.length ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {selectedProfile.members.map((member) => (
                            <span
                              key={member}
                              className="rounded-md bg-background px-2 py-1 text-xs text-muted-foreground"
                            >
                              {member}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <SummaryTile
                        label={t("settings.gaModelApiMode")}
                        value={selectedProfile.api_mode ?? "chat_completions"}
                      />
                      <SummaryTile
                        label={t("settings.gaModelReasoning")}
                        value={selectedProfile.reasoning_effort || "Provider default"}
                      />
                      <SummaryTile
                        label={t("settings.gaModelCtxWindow")}
                        value={formatNumber(selectedProfile.context_win)}
                      />
                      <SummaryTile
                        label={t("settings.gaModelMaxOutTokens")}
                        value={formatNumber(selectedProfile.max_tokens)}
                      />
                      <SummaryTile
                        label={t("settings.gaModelTimeouts")}
                        value={formatTimeouts(selectedProfile)}
                      />
                      <SummaryTile
                        label={t("settings.gaModelSecurity")}
                        value={
                          selectedProfile.verify === false ? "TLS verification off" : "TLS verified"
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[28rem] flex-col items-center justify-center px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                  <Server className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-sm font-semibold">t("settings.gaModelNoneSelected")</h3>
                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                  {t("settings.gaModelNoneSelectedDesc")}
                </p>
                <Button type="button" size="sm" className="mt-4 gap-1.5" onClick={openCreate}>
                  <Plus className="h-3.5 w-3.5" />
                  t("settings.gaModelAdd")
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>

      {editor && typeof document !== "undefined"
        ? createPortal(
            <div
              className="settings-modal-overlay fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
              data-state="open"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ga-model-profile-editor-title"
            >
              <div className="settings-modal-panel relative flex max-h-[min(92vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-[26px] border border-black/[0.07] bg-white/[0.96] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_32px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-2xl dark:border-white/10 dark:bg-background/[0.96] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_80px_-24px_rgba(0,0,0,0.7)]">
                <div className="flex shrink-0 items-center gap-3.5 border-b border-black/[0.06] px-6 py-5 dark:border-white/[0.08]">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-foreground/70 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground/80">
                    <Settings2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      id="ga-model-profile-editor-title"
                      className="truncate text-base font-semibold"
                    >
                      {editor.mode === "create" ? "Add model profile" : "Edit model profile"}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      t("settings.gaModelWriteNote")
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-full border border-black/[0.06] bg-black/[0.04] text-muted-foreground hover:bg-black/[0.08] hover:text-foreground dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                    onClick={() => setEditor(null)}
                    disabled={saving}
                    aria-label={t("settings.gaModelCloseEditor")}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                    <aside className="h-fit rounded-2xl border border-black/[0.06] bg-white/[0.68] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
                      <p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        t("settings.gaModelProfileSettings")
                      </p>
                      <div className="space-y-1">
                        <EditorNavButton
                          active={editorSection === "connection"}
                          icon={<Server className="h-4 w-4" />}
                          label={t("settings.gaModelLblConnection")}
                          description="Model and credentials"
                          onClick={() => setEditorSection("connection")}
                        />
                        <EditorNavButton
                          active={editorSection === "runtime"}
                          icon={<Settings2 className="h-4 w-4" />}
                          label={t("settings.gaModelLblRuntime")}
                          description="Generation behavior"
                          onClick={() => setEditorSection("runtime")}
                        />
                        <EditorNavButton
                          active={editorSection === "transport"}
                          icon={<Search className="h-4 w-4" />}
                          label={t("settings.gaModelLblTransport")}
                          description="Headers and security"
                          onClick={() => setEditorSection("transport")}
                        />
                      </div>
                    </aside>

                    <section className="min-w-0 rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
                      {editorSection === "connection" ? (
                        <div className="space-y-5">
                          <EditorSectionHeading
                            title="Connection"
                            description="Choose the protocol and endpoint used by GenericAgent."
                          />
                          <div className="grid gap-4 sm:grid-cols-2">
                            <Field
                              label={t("settings.gaModelDisplayName")}
                              htmlFor="model-profile-name"
                              hint="Optional label shown in the model picker."
                            >
                              <Input
                                id="model-profile-name"
                                value={editor.value.name}
                                onChange={(event) => updateForm("name", event.target.value)}
                                placeholder={t("settings.gaModelDisplayNamePh")}
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelProtocol")}
                              htmlFor="model-profile-protocol"
                              hint={
                                editor.mode === "edit"
                                  ? "Protocol cannot be changed after creation."
                                  : undefined
                              }
                            >
                              <select
                                id="model-profile-protocol"
                                className={SELECT_CLASS}
                                value={editor.value.protocol}
                                disabled={editor.mode === "edit"}
                                onChange={(event) =>
                                  updateForm(
                                    "protocol",
                                    event.target.value as FormValue["protocol"],
                                  )
                                }
                              >
                                <option value="oai">t("settings.gaModelOpenAICompat")</option>
                                <option value="claude">t("settings.gaModelClaudeCompat")</option>
                              </select>
                            </Field>
                            <Field label={t("settings.gaModelModel")} htmlFor="model-profile-model">
                              <Input
                                id="model-profile-model"
                                value={editor.value.model}
                                onChange={(event) => updateForm("model", event.target.value)}
                                placeholder="gpt-4.1"
                                autoFocus={editor.mode === "create"}
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelApiBase")}
                              htmlFor="model-profile-base"
                            >
                              <Input
                                id="model-profile-base"
                                value={editor.value.apibase}
                                onChange={(event) => updateForm("apibase", event.target.value)}
                                placeholder="https://api.example.com/v1"
                              />
                            </Field>
                            <div className="sm:col-span-2">
                              <Field
                                label={t("settings.gaModelApiKey")}
                                htmlFor="model-profile-key"
                                hint={
                                  editor.mode === "edit"
                                    ? "Leave blank to preserve the configured key."
                                    : "Required for a new profile. The key is never displayed after saving."
                                }
                              >
                                <Input
                                  id="model-profile-key"
                                  type="password"
                                  autoComplete="new-password"
                                  value={editor.value.api_key}
                                  onChange={(event) => updateForm("api_key", event.target.value)}
                                  placeholder={
                                    editor.mode === "edit"
                                      ? "Leave blank to keep the configured key"
                                      : "Required for a new profile"
                                  }
                                />
                              </Field>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {editorSection === "runtime" ? (
                        <div className="space-y-5">
                          <EditorSectionHeading
                            title="Runtime"
                            description="Tune retries, request limits, and generation behavior."
                          />
                          <div className="grid gap-4 sm:grid-cols-2">
                            <Field
                              label={t("settings.gaModelMaxRetries")}
                              htmlFor="model-profile-retries"
                            >
                              <Input
                                id="model-profile-retries"
                                type="number"
                                min="0"
                                value={editor.value.max_retries}
                                onChange={(event) => updateForm("max_retries", event.target.value)}
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelConnectTimeout")}
                              htmlFor="model-profile-connect"
                            >
                              <Input
                                id="model-profile-connect"
                                type="number"
                                min="1"
                                value={editor.value.connect_timeout}
                                onChange={(event) =>
                                  updateForm("connect_timeout", event.target.value)
                                }
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelReadTimeout")}
                              htmlFor="model-profile-read"
                            >
                              <Input
                                id="model-profile-read"
                                type="number"
                                min="1"
                                value={editor.value.read_timeout}
                                onChange={(event) => updateForm("read_timeout", event.target.value)}
                              />
                            </Field>
                            <label className="flex min-h-9 items-center gap-2 self-end pb-1 text-sm">
                              <input
                                className={CHECKBOX_CLASS}
                                type="checkbox"
                                checked={editor.value.stream}
                                onChange={(event) => updateForm("stream", event.target.checked)}
                              />
                              t("settings.gaModelStream")
                            </label>
                            <Field
                              label={t("settings.gaModelApiMode")}
                              htmlFor="model-profile-api-mode"
                            >
                              <select
                                id="model-profile-api-mode"
                                className={SELECT_CLASS}
                                value={editor.value.api_mode}
                                onChange={(event) =>
                                  updateForm("api_mode", event.target.value as GaModelApiMode)
                                }
                              >
                                <option value="chat_completions">
                                  t("settings.gaModelApiModeOpenAI")
                                </option>
                                <option value="responses">
                                  t("settings.gaModelApiModeResponses")
                                </option>
                              </select>
                            </Field>
                            <Field
                              label={t("settings.gaModelReasonEffort")}
                              htmlFor="model-profile-reasoning"
                            >
                              <select
                                id="model-profile-reasoning"
                                className={SELECT_CLASS}
                                value={editor.value.reasoning_effort}
                                onChange={(event) =>
                                  updateForm(
                                    "reasoning_effort",
                                    event.target.value as FormValue["reasoning_effort"],
                                  )
                                }
                              >
                                <option value="">t("settings.gaModelReasonDefault")</option>
                                <option value="none">t("settings.gaModelReasonNone")</option>
                                <option value="minimal">t("settings.gaModelReasonMinimal")</option>
                                <option value="low">t("settings.gaModelReasonLow")</option>
                                <option value="medium">t("settings.gaModelReasonMed")</option>
                                <option value="high">t("settings.gaModelReasonHigh")</option>
                                <option value="xhigh">t("settings.gaModelReasonXHigh")</option>
                                <option value="max">t("settings.gaModelReasonMax")</option>
                              </select>
                            </Field>
                            <Field
                              label={t("settings.gaModelServiceTier")}
                              htmlFor="model-profile-service-tier"
                            >
                              <select
                                id="model-profile-service-tier"
                                className={SELECT_CLASS}
                                value={editor.value.service_tier}
                                onChange={(event) =>
                                  updateForm(
                                    "service_tier",
                                    event.target.value as FormValue["service_tier"],
                                  )
                                }
                              >
                                <option value="">t("settings.gaModelReasonDefault")</option>
                                <option value="auto">t("settings.gaModelTierAuto")</option>
                                <option value="default">t("settings.gaModelDefault")</option>
                                <option value="priority">t("settings.gaModelTierPriority")</option>
                                <option value="flex">t("settings.gaModelTierFlex")</option>
                              </select>
                            </Field>
                            <Field
                              label={t("settings.gaModelThinking")}
                              htmlFor="model-profile-thinking-type"
                            >
                              <select
                                id="model-profile-thinking-type"
                                className={SELECT_CLASS}
                                value={editor.value.thinking_type}
                                onChange={(event) =>
                                  updateForm(
                                    "thinking_type",
                                    event.target.value as FormValue["thinking_type"],
                                  )
                                }
                              >
                                <option value="">t("settings.gaModelReasonDefault")</option>
                                <option value="adaptive">
                                  t("settings.gaModelThinkingAdaptive")
                                </option>
                                <option value="enabled">t("settings.gaModelThinkingOn")</option>
                                <option value="disabled">t("settings.gaModelThinkingOff")</option>
                              </select>
                            </Field>
                            <Field
                              label={t("settings.gaModelThinkBudget")}
                              htmlFor="model-profile-thinking-budget"
                            >
                              <Input
                                id="model-profile-thinking-budget"
                                type="number"
                                min="1"
                                value={editor.value.thinking_budget_tokens}
                                onChange={(event) =>
                                  updateForm("thinking_budget_tokens", event.target.value)
                                }
                                placeholder="32768"
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelTemperature")}
                              htmlFor="model-profile-temperature"
                            >
                              <Input
                                id="model-profile-temperature"
                                type="number"
                                min="0"
                                max="2"
                                step="0.1"
                                value={editor.value.temperature}
                                onChange={(event) => updateForm("temperature", event.target.value)}
                                placeholder="1"
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelMaxOutTokens")}
                              htmlFor="model-profile-max-tokens"
                            >
                              <Input
                                id="model-profile-max-tokens"
                                type="number"
                                min="1"
                                value={editor.value.max_tokens}
                                onChange={(event) => updateForm("max_tokens", event.target.value)}
                                placeholder="8192"
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelCtxWindow")}
                              htmlFor="model-profile-context-win"
                            >
                              <Input
                                id="model-profile-context-win"
                                type="number"
                                min="1"
                                value={editor.value.context_win}
                                onChange={(event) => updateForm("context_win", event.target.value)}
                                placeholder="30000"
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelKeepFirst")}
                              htmlFor="model-profile-trim-prefix"
                              hint="0 is valid and keeps the default trimming behavior."
                            >
                              <Input
                                id="model-profile-trim-prefix"
                                type="number"
                                min="0"
                                value={editor.value.trim_keep_prefix}
                                onChange={(event) =>
                                  updateForm("trim_keep_prefix", event.target.value)
                                }
                                placeholder="0"
                              />
                            </Field>
                          </div>
                        </div>
                      ) : null}

                      {editorSection === "transport" ? (
                        <div className="space-y-5">
                          <EditorSectionHeading
                            title="Transport"
                            description="Control proxying, client identity, and TLS behavior."
                          />
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                              <Field
                                label={t("settings.gaModelSessionProxy")}
                                htmlFor="model-profile-proxy"
                                hint="Credentials embedded in an existing proxy are hidden and preserved unless you replace the whole value."
                              >
                                <Input
                                  id="model-profile-proxy"
                                  value={editor.value.proxy}
                                  onChange={(event) => updateForm("proxy", event.target.value)}
                                  placeholder="http://127.0.0.1:2082"
                                />
                              </Field>
                            </div>
                            <Field
                              label={t("settings.gaModelUaOverride")}
                              htmlFor="model-profile-user-agent"
                            >
                              <Input
                                id="model-profile-user-agent"
                                value={editor.value.user_agent}
                                onChange={(event) => updateForm("user_agent", event.target.value)}
                                placeholder="codex_cli/0.139.0"
                              />
                            </Field>
                            <Field
                              label={t("settings.gaModelOriginator")}
                              htmlFor="model-profile-originator"
                            >
                              <Input
                                id="model-profile-originator"
                                value={editor.value.originator}
                                onChange={(event) => updateForm("originator", event.target.value)}
                                placeholder="codex_cli"
                              />
                            </Field>
                          </div>
                          <div className="border-t border-black/[0.06] pt-4 dark:border-white/[0.08]">
                            <p className="text-xs font-semibold text-foreground/80">
                              t("settings.gaModelCompatSecurity")
                            </p>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <ToggleField
                                checked={editor.value.codex_client}
                                onChange={(checked) => updateForm("codex_client", checked)}
                                label={t("settings.gaModelCodexFingerprint")}
                              />
                              <ToggleField
                                checked={editor.value.codex_client_metadata}
                                onChange={(checked) => updateForm("codex_client_metadata", checked)}
                                label={t("settings.gaModelSendCodex")}
                              />
                              <ToggleField
                                checked={editor.value.fake_cc_system_prompt}
                                onChange={(checked) => updateForm("fake_cc_system_prompt", checked)}
                                label={t("settings.gaModelClaudePrompt")}
                              />
                              <ToggleField
                                checked={editor.value.verify}
                                onChange={(checked) => updateForm("verify", checked)}
                                label={t("settings.gaModelVerifyTls")}
                              />
                              <ToggleField
                                checked={editor.value.omit_thinking}
                                onChange={(checked) => updateForm("omit_thinking", checked)}
                                label={t("settings.gaModelOmitThinking")}
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  </div>
                </div>

                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-black/[0.06] px-6 py-4 dark:border-white/[0.08]">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditor(null)}
                    disabled={saving}
                  >
                    t("settings.gaModelCancel")
                  </Button>
                  <Button type="button" onClick={() => void saveEditor()} disabled={saving}>
                    {saving ? "Saving…" : "Save profile"}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function EditorSectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function EditorNavButton({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${active ? "bg-primary/10" : "bg-muted/70"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="mt-0.5 block truncate text-[10px] opacity-75">{description}</span>
      </span>
    </button>
  );
}

function ToggleField({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground">
      <input
        className={CHECKBOX_CLASS}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function InfoTile({
  label,
  value,
  wide,
  tone = "default",
}: {
  label: string;
  value: string;
  wide?: boolean;
  tone?: "default" | "success" | "muted";
}) {
  return (
    <div
      className={`rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3 ${wide ? "sm:col-span-2" : ""}`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-sm ${tone === "success" ? "text-emerald-600 dark:text-emerald-400" : tone === "muted" ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 px-3.5 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm text-foreground">{value}</div>
    </div>
  );
}

function formatNumber(value?: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "Provider default";
}

function formatTimeouts(profile: GaModelProfile): string {
  const connect =
    typeof profile.connect_timeout === "number"
      ? `${profile.connect_timeout}s connect`
      : "default connect";
  const read =
    typeof profile.read_timeout === "number" ? `${profile.read_timeout}s read` : "default read";
  return `${connect} · ${read}`;
}
