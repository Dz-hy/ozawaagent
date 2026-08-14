import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassPanel, HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import { Loader2, RefreshCw, Search, Shield, X } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaGovernanceAudit,
  GaGovernanceAuditCategory,
  GaGovernanceAuditOutcome,
  GaGovernanceCategory,
  GaGovernanceInventory,
  GaGovernanceItem,
  GaGovernancePolicy,
  GaGovernancePolicyEntry,
  GaGovernancePolicyInput,
  GaGovernancePolicyScope,
  GaGovernanceRisk,
  GaGovernanceSource,
} from "../../lib/ga/types";
import { cn } from "../../lib/shared/utils";

const CATEGORIES: GaGovernanceCategory[] = [
  "command",
  "command_pack",
  "skill",
  "connector",
  "hook",
  "automation",
];
// 审计历史额外包含确认决策记录（票 05）与策略变更记录（票 06）。
const AUDIT_CATEGORIES: GaGovernanceAuditCategory[] = [...CATEGORIES, "confirmation", "policy"];
const SOURCES: GaGovernanceSource[] = ["builtin", "user", "third_party", "unknown"];
const RISKS: GaGovernanceRisk[] = [
  "shell",
  "write",
  "delete",
  "network",
  "credentials",
  "scheduled",
];
const OUTCOMES: GaGovernanceAuditOutcome[] = ["ok", "error"];
const TIME_RANGES = ["all", "today", "week", "month"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

// 风险标签 → 展示色阶：数值越大风险越需要注意。
const RISK_TONES: Record<GaGovernanceRisk, string> = {
  shell: "bg-orange-500/15 text-orange-600",
  write: "bg-amber-500/15 text-amber-600",
  delete: "bg-red-500/15 text-red-600",
  network: "bg-sky-500/15 text-sky-600",
  credentials: "bg-fuchsia-500/15 text-fuchsia-600",
  scheduled: "bg-violet-500/15 text-violet-600",
};
const CATEGORY_TONES: Record<GaGovernanceAuditCategory, string> = {
  command: "bg-foreground/[0.06] text-muted-foreground",
  command_pack: "bg-amber-500/10 text-amber-600",
  skill: "bg-emerald-500/10 text-emerald-600",
  connector: "bg-sky-500/10 text-sky-600",
  hook: "bg-violet-500/10 text-violet-600",
  automation: "bg-rose-500/10 text-rose-600",
  confirmation: "bg-cyan-500/10 text-cyan-600",
  policy: "bg-teal-500/10 text-teal-600",
};

function matchesQuery(item: GaGovernanceItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.id, item.description, item.kind].join(" ").toLowerCase().includes(needle);
}

function matchesAuditQuery(
  record: { target: string; params_summary: string | null },
  query: string,
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [record.target, record.params_summary ?? ""].join(" ").toLowerCase().includes(needle);
}

function withinTimeRange(timestamp: string, range: TimeRange): boolean {
  if (range === "all") return true;
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return true;
  const now = Date.now();
  if (range === "today") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return time >= startOfToday.getTime();
  }
  const days = range === "week" ? 7 : 30;
  return time >= now - days * 24 * 3600 * 1000;
}

export function GovernanceHubPage(props: { sidebarOpen: boolean; onOpenSidebar: () => void }) {
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [activeTab, setActiveTab] = useState<"inventory" | "history" | "policy">("inventory");
  const [inventory, setInventory] = useState<GaGovernanceInventory | null>(null);
  const [audit, setAudit] = useState<GaGovernanceAudit | null>(null);
  const [policy, setPolicy] = useState<GaGovernancePolicy | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [policyEntryDraft, setPolicyEntryDraft] = useState({
    category: "command" as "command" | "connector",
    target: "",
    scope: "global" as GaGovernancePolicyScope,
    projectId: "",
    enabled: false,
  });
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<GaGovernanceAuditCategory>>(
    new Set(),
  );
  const [selectedSources, setSelectedSources] = useState<Set<GaGovernanceSource>>(new Set());
  const [selectedRisks, setSelectedRisks] = useState<Set<GaGovernanceRisk>>(new Set());
  const [selectedOutcomes, setSelectedOutcomes] = useState<Set<GaGovernanceAuditOutcome>>(
    new Set(),
  );
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [disabledIds, setDisabledIds] = useState<Set<string>>(new Set());
  const [disableError, setDisableError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextInventory, nextAudit, nextPolicy] = await Promise.all([
        gaBridgeClient.getGovernanceInventory(),
        gaBridgeClient.getGovernanceAudit(),
        gaBridgeClient.getGovernancePolicy(),
      ]);
      setInventory(nextInventory);
      setAudit(nextAudit);
      setPolicy(nextPolicy);
      setAllowlistDraft(nextPolicy.allowlist.join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Governance data is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  const applyPolicy = useCallback(
    async (next: GaGovernancePolicyInput) => {
      setPolicyBusy(true);
      setPolicyError(null);
      try {
        setPolicy(await gaBridgeClient.putGovernancePolicy(next));
        await load();
      } catch (cause) {
        setPolicyError(cause instanceof Error ? cause.message : "Policy update failed");
      } finally {
        setPolicyBusy(false);
      }
    },
    [load],
  );

  const saveAllowlist = useCallback(async () => {
    if (!policy) return;
    const allowlist = allowlistDraft
      .split("\n")
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0);
    const confirmed = await confirm({
      title: t("governance.policy.confirmSaveTitle"),
      description: t("governance.policy.confirmSaveDescription"),
      confirmLabel: t("governance.policy.confirmSave"),
      cancelLabel: t("governance.confirm.deny"),
      tone: "warning",
    });
    if (!confirmed) return;
    await applyPolicy({ allowlist, entries: policy.entries });
  }, [policy, allowlistDraft, confirm, applyPolicy, t]);

  const removePolicyEntry = useCallback(
    async (entry: GaGovernancePolicyEntry) => {
      if (!policy) return;
      const confirmed = await confirm({
        title: t("governance.policy.confirmRemoveTitle"),
        description: t("governance.policy.confirmRemoveDescription").replace(
          "{target}",
          entry.target,
        ),
        confirmLabel: t("governance.policy.confirmRemove"),
        cancelLabel: t("governance.confirm.deny"),
        tone: "destructive",
      });
      if (!confirmed) return;
      await applyPolicy({
        allowlist: policy.allowlist,
        entries: policy.entries.filter(
          (item) => !(item.category === entry.category && item.target === entry.target),
        ),
      });
    },
    [policy, confirm, applyPolicy, t],
  );

  const addPolicyEntry = useCallback(async () => {
    if (!policy) return;
    const target = policyEntryDraft.target.trim();
    if (!target) return;
    const confirmed = await confirm({
      title: t("governance.policy.confirmAddTitle"),
      description: t("governance.policy.confirmAddDescription").replace(
        "{target}",
        `${policyEntryDraft.category}:${target}`,
      ),
      confirmLabel: t("governance.policy.confirmAdd"),
      cancelLabel: t("governance.confirm.deny"),
      tone: "warning",
    });
    if (!confirmed) return;
    const entry: GaGovernancePolicyEntry = {
      category: policyEntryDraft.category,
      target,
      enabled: policyEntryDraft.enabled,
      scope: policyEntryDraft.scope,
      project_id: policyEntryDraft.scope === "project" ? policyEntryDraft.projectId.trim() : null,
    };
    await applyPolicy({
      allowlist: policy.allowlist,
      entries: [
        ...policy.entries.filter(
          (item) => !(item.category === entry.category && item.target === entry.target),
        ),
        entry,
      ],
    });
    setPolicyEntryDraft((prev) => ({ ...prev, target: "" }));
  }, [policy, policyEntryDraft, confirm, applyPolicy, t]);

  // 清单行开关：command/connector 的全局禁用条目创建/移除（其他类型无执行面，不提供开关）。
  const toggleGlobalPolicyEntry = useCallback(
    async (item: GaGovernanceItem) => {
      if (!policy) return;
      const existing = policy.entries.find(
        (entry) => entry.category === item.category && entry.target === item.id,
      );
      const confirmed = await confirm({
        title: t("governance.policy.confirmToggleTitle"),
        description: t(
          existing
            ? "governance.policy.confirmToggleEnableDescription"
            : "governance.policy.confirmToggleDisableDescription",
        ).replace("{target}", item.name),
        confirmLabel: t(
          existing ? "governance.policy.toggleEnable" : "governance.policy.toggleDisable",
        ),
        cancelLabel: t("governance.confirm.deny"),
        tone: existing ? "warning" : "destructive",
      });
      if (!confirmed) return;
      const entries = policy.entries.filter(
        (entry) => !(entry.category === item.category && entry.target === item.id),
      );
      if (!existing) {
        entries.push({
          category: item.category as "command" | "connector",
          target: item.id,
          enabled: false,
          scope: "global",
          project_id: null,
        });
      }
      await applyPolicy({ allowlist: policy.allowlist, entries });
    },
    [policy, confirm, applyPolicy, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  };

  const visibleItems = useMemo(() => {
    if (!inventory) return [];
    return inventory.items.filter((item) => {
      if (selectedCategories.size > 0 && !selectedCategories.has(item.category)) return false;
      if (selectedSources.size > 0 && !selectedSources.has(item.source)) return false;
      if (selectedRisks.size > 0 && !item.risk.some((risk) => selectedRisks.has(risk)))
        return false;
      return matchesQuery(item, query);
    });
  }, [inventory, query, selectedCategories, selectedSources, selectedRisks]);

  const visibleAudit = useMemo(() => {
    if (!audit) return [];
    return audit.items.filter((record) => {
      if (selectedCategories.size > 0 && !selectedCategories.has(record.category)) return false;
      if (selectedOutcomes.size > 0 && !selectedOutcomes.has(record.outcome)) return false;
      if (!withinTimeRange(record.timestamp, timeRange)) return false;
      return matchesAuditQuery(record, query);
    });
  }, [audit, query, selectedCategories, selectedOutcomes, timeRange]);

  const viewAsset = useCallback((target: string) => {
    setQuery(target);
    setActiveTab("inventory");
  }, []);

  const handleDisableAutomation = useCallback(
    async (id: string) => {
      setDisableError(null);
      try {
        await gaBridgeClient.updateAutomation(id, { enabled: false });
        setDisabledIds((prev) => new Set(prev).add(id));
        void load();
      } catch (cause) {
        setDisableError(cause instanceof Error ? cause.message : "disable failed");
      }
    },
    [load],
  );

  const FilterChips = <T extends string>(props: {
    values: readonly T[];
    selected: Set<T>;
    labelKey: (value: T) => string;
    onToggle: (value: T) => void;
  }) => (
    <div className="flex flex-wrap gap-1.5">
      {props.values.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => props.onToggle(value)}
          className={cn(
            "h-6 rounded-full border px-2.5 text-xs transition-colors",
            props.selected.has(value)
              ? "border-primary/40 bg-primary/15 text-primary"
              : "border-border/60 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground",
          )}
        >
          {props.labelKey(value)}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <HubBackdrop tone="neutral" />
      <HubHeader
        icon={<Shield className="h-5 w-5" />}
        title={t("governance.title")}
        subtitle={t("governance.subtitle")}
        tone="neutral"
        sidebarOpen={props.sidebarOpen}
        onOpenSidebar={props.onOpenSidebar}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("governance.refresh")}
          </Button>
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-5">
        {error ? (
          <GlassPanel tone="error" className="text-sm">
            {error}
          </GlassPanel>
        ) : null}
        {loading && !inventory ? (
          <div className="flex min-h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t("governance.loading")}
          </div>
        ) : null}
        {inventory ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div className="flex items-center gap-1 self-start rounded-lg border border-border/60 bg-background/40 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("inventory")}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  activeTab === "inventory"
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("governance.tabInventory")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("history")}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  activeTab === "history"
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("governance.tabHistory")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("policy")}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  activeTab === "policy"
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("governance.tabPolicy")}
              </button>
            </div>

            {activeTab !== "policy" ? (
              <>
                <GlassPanel tone="muted">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <label className="relative min-w-56 flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("governance.searchPlaceholder")}
                        className="w-full rounded-lg border border-border/60 bg-background/60 py-2 pr-3 pl-9 text-sm outline-none focus:border-primary/50"
                      />
                    </label>
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      {t("governance.total").replace(
                        "{count}",
                        String(
                          activeTab === "inventory" ? visibleItems.length : visibleAudit.length,
                        ),
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-col gap-3">
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("governance.filterCategory")}
                      </p>
                      <FilterChips
                        values={AUDIT_CATEGORIES}
                        selected={selectedCategories}
                        labelKey={(value) => t(`governance.category.${value}`)}
                        onToggle={(value) =>
                          setSelectedCategories((prev) => toggleSet(prev, value))
                        }
                      />
                    </div>
                    {activeTab === "inventory" ? (
                      <>
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            {t("governance.filterSource")}
                          </p>
                          <FilterChips
                            values={SOURCES}
                            selected={selectedSources}
                            labelKey={(value) => t(`governance.source.${value}`)}
                            onToggle={(value) =>
                              setSelectedSources((prev) => toggleSet(prev, value))
                            }
                          />
                        </div>
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            {t("governance.filterRisk")}
                          </p>
                          <FilterChips
                            values={RISKS}
                            selected={selectedRisks}
                            labelKey={(value) => t(`governance.risk.${value}`)}
                            onToggle={(value) => setSelectedRisks((prev) => toggleSet(prev, value))}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            {t("governance.auditFilterOutcome")}
                          </p>
                          <FilterChips
                            values={OUTCOMES}
                            selected={selectedOutcomes}
                            labelKey={(value) => t(`governance.auditOutcome.${value}`)}
                            onToggle={(value) =>
                              setSelectedOutcomes((prev) => toggleSet(prev, value))
                            }
                          />
                        </div>
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            {t("governance.auditFilterTime")}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {TIME_RANGES.map((range) => (
                              <button
                                key={range}
                                type="button"
                                onClick={() => setTimeRange(range)}
                                className={cn(
                                  "h-6 rounded-full border px-2.5 text-xs transition-colors",
                                  timeRange === range
                                    ? "border-primary/40 bg-primary/15 text-primary"
                                    : "border-border/60 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground",
                                )}
                              >
                                {t(`governance.auditTime.${range}`)}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </GlassPanel>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Shield className="h-3.5 w-3.5 shrink-0" />
                  {activeTab === "inventory"
                    ? t("governance.readOnlyNote")
                    : t("governance.auditNote")}
                </p>
              </>
            ) : null}

            {activeTab === "inventory" ? (
              visibleItems.length === 0 ? (
                <GlassPanel tone="neutral" className="text-sm text-muted-foreground">
                  {t("governance.empty")}
                </GlassPanel>
              ) : (
                <div className="flex flex-col gap-2">
                  {visibleItems.map((item) => (
                    <GlassPanel
                      key={`${item.category}:${item.id}`}
                      tone="default"
                      className="min-w-0 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                            CATEGORY_TONES[item.category],
                          )}
                        >
                          {t(`governance.category.${item.category}`)}
                        </span>
                        <code
                          className="min-w-0 flex-1 truncate text-sm font-semibold"
                          title={item.id}
                        >
                          {item.name}
                        </code>
                        <span className="shrink-0 rounded-md bg-background/50 px-2 py-0.5 text-xs text-muted-foreground">
                          {t(`governance.source.${item.source}`)}
                        </span>
                        {item.risk.map((risk) => (
                          <span
                            key={risk}
                            className={cn(
                              "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                              RISK_TONES[risk],
                            )}
                          >
                            {t(`governance.risk.${risk}`)}
                          </span>
                        ))}
                        {item.risk.length === 0 ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            {t("governance.noRisk")}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs text-muted-foreground">{item.scope}</span>
                        <span
                          className={cn(
                            "shrink-0 text-xs",
                            item.enabled === null
                              ? "text-muted-foreground/50"
                              : item.enabled
                                ? "text-emerald-600"
                                : "text-destructive",
                          )}
                        >
                          {item.enabled === null
                            ? t("governance.na")
                            : item.enabled
                              ? t("governance.enabled")
                              : t("governance.disabled")}
                        </span>
                        {item.category === "command" || item.category === "connector" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={!policy || policyBusy}
                            onClick={() => void toggleGlobalPolicyEntry(item)}
                          >
                            {policy?.entries.some(
                              (entry) =>
                                entry.category === item.category && entry.target === item.id,
                            )
                              ? t("governance.policy.toggleEnable")
                              : t("governance.policy.toggleDisable")}
                          </Button>
                        ) : null}
                        {item.valid ? null : (
                          <span className="shrink-0 text-xs text-destructive">
                            {t("governance.invalid")}
                          </span>
                        )}
                      </div>
                      {item.description ? (
                        <p
                          className="mt-1.5 truncate pl-1 text-xs text-muted-foreground"
                          title={item.description}
                        >
                          {item.description}
                        </p>
                      ) : null}
                    </GlassPanel>
                  ))}
                </div>
              )
            ) : activeTab === "history" ? (
              visibleAudit.length === 0 ? (
                <GlassPanel tone="neutral" className="text-sm text-muted-foreground">
                  {t("governance.auditEmpty")}
                </GlassPanel>
              ) : (
                <div className="flex flex-col gap-2">
                  {disableError ? (
                    <GlassPanel tone="error" className="text-sm">
                      {t("governance.auditDisableFailed")}: {disableError}
                    </GlassPanel>
                  ) : null}
                  {visibleAudit.map((record) => (
                    <GlassPanel key={record.id} tone="default" className="min-w-0 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {new Date(record.timestamp).toLocaleString()}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                            CATEGORY_TONES[record.category],
                          )}
                        >
                          {t(`governance.category.${record.category}`)}
                        </span>
                        <code
                          className="min-w-0 flex-1 truncate text-sm font-semibold"
                          title={record.target}
                        >
                          {record.target}
                        </code>
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                            record.outcome === "ok"
                              ? "bg-emerald-500/10 text-emerald-600"
                              : "bg-red-500/10 text-red-600",
                          )}
                        >
                          {t(`governance.auditOutcome.${record.outcome}`)}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => viewAsset(record.target)}
                          title={t("governance.auditViewAsset")}
                        >
                          {t("governance.auditViewAsset")}
                        </Button>
                        {record.category === "automation" ? (
                          disabledIds.has(record.target) ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t("governance.auditDisabled")}
                            </span>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                              onClick={() => void handleDisableAutomation(record.target)}
                            >
                              {t("governance.auditDisable")}
                            </Button>
                          )
                        ) : null}
                      </div>
                      {record.params_summary === null && record.error === null ? null : (
                        <p className="mt-1.5 truncate pl-1 font-mono text-xs text-muted-foreground">
                          {record.params_summary !== null ? `args: ${record.params_summary}` : null}
                          {record.error !== null ? (
                            <span className="text-destructive"> error: {record.error}</span>
                          ) : null}
                        </p>
                      )}
                    </GlassPanel>
                  ))}
                </div>
              )
            ) : policy ? (
              <div className="flex flex-col gap-4">
                {policyError ? (
                  <GlassPanel tone="error" className="text-sm">
                    {t("governance.policy.saveFailed")}: {policyError}
                  </GlassPanel>
                ) : null}
                <GlassPanel tone="muted">
                  <h2 className="text-sm font-semibold">{t("governance.policy.allowlistTitle")}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("governance.policy.allowlistNote")}
                  </p>
                  <textarea
                    value={allowlistDraft}
                    onChange={(event) => setAllowlistDraft(event.target.value)}
                    rows={4}
                    placeholder={t("governance.policy.allowlistPlaceholder")}
                    className="mt-3 w-full resize-y rounded-xl border border-border/60 bg-background/60 p-3 font-mono text-xs outline-none focus:border-primary/50"
                  />
                  <div className="mt-2 flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={policyBusy || allowlistDraft === policy.allowlist.join("\n")}
                      onClick={() => void saveAllowlist()}
                    >
                      {t("governance.policy.allowlistSave")}
                    </Button>
                    {policyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  </div>
                </GlassPanel>

                <GlassPanel tone="muted">
                  <h2 className="text-sm font-semibold">{t("governance.policy.entriesTitle")}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("governance.policy.entriesNote")}
                  </p>
                  {policy.entries.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {t("governance.policy.entriesEmpty")}
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-col gap-2">
                      {policy.entries.map((entry) => (
                        <div
                          key={`${entry.category}:${entry.target}`}
                          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/40 bg-background/40 px-3 py-2"
                        >
                          <span
                            className={cn(
                              "rounded-md px-2 py-0.5 text-[11px] font-medium",
                              CATEGORY_TONES[entry.category],
                            )}
                          >
                            {t(`governance.category.${entry.category}`)}
                          </span>
                          <code className="min-w-0 flex-1 truncate text-sm font-semibold">
                            {entry.target}
                          </code>
                          <span className="rounded-md bg-background/50 px-2 py-0.5 text-xs text-muted-foreground">
                            {entry.scope === "project"
                              ? `${t("governance.policy.scopeProject")}: ${entry.project_id ?? "?"}`
                              : t("governance.policy.scopeGlobal")}
                          </span>
                          <span
                            className={cn(
                              "text-xs",
                              entry.enabled ? "text-emerald-600" : "text-destructive",
                            )}
                          >
                            {entry.enabled ? t("governance.enabled") : t("governance.disabled")}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                            disabled={policyBusy}
                            onClick={() => void removePolicyEntry(entry)}
                          >
                            <X className="mr-1 h-3 w-3" />
                            {t("governance.policy.entryRemove")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border/40 pt-4">
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("governance.policy.entryCategory")}
                      </p>
                      <FilterChips
                        values={["command", "connector"]}
                        selected={new Set([policyEntryDraft.category])}
                        labelKey={(value) => t(`governance.category.${value}`)}
                        onToggle={(value) =>
                          setPolicyEntryDraft((prev) => ({
                            ...prev,
                            category: value as "command" | "connector",
                          }))
                        }
                      />
                    </div>
                    <div className="min-w-40 flex-1">
                      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("governance.policy.entryTarget")}
                      </p>
                      <input
                        value={policyEntryDraft.target}
                        onChange={(event) =>
                          setPolicyEntryDraft((prev) => ({ ...prev, target: event.target.value }))
                        }
                        placeholder={t("governance.policy.entryTargetPlaceholder")}
                        className="w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary/50"
                      />
                    </div>
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("governance.policy.entryScope")}
                      </p>
                      <FilterChips
                        values={["global", "project"]}
                        selected={new Set([policyEntryDraft.scope])}
                        labelKey={(value) => t(`governance.policy.scope.${value}`)}
                        onToggle={(value) =>
                          setPolicyEntryDraft((prev) => ({
                            ...prev,
                            scope: value as GaGovernancePolicyScope,
                          }))
                        }
                      />
                    </div>
                    {policyEntryDraft.scope === "project" ? (
                      <div className="min-w-36">
                        <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                          {t("governance.policy.entryProjectId")}
                        </p>
                        <input
                          value={policyEntryDraft.projectId}
                          onChange={(event) =>
                            setPolicyEntryDraft((prev) => ({
                              ...prev,
                              projectId: event.target.value,
                            }))
                          }
                          placeholder="proj-id"
                          className="w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary/50"
                        />
                      </div>
                    ) : null}
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("governance.policy.entryEnabled")}
                      </p>
                      <FilterChips
                        values={["enabled", "disabled"]}
                        selected={new Set([policyEntryDraft.enabled ? "enabled" : "disabled"])}
                        labelKey={(value) => t(`governance.policy.state.${value}`)}
                        onToggle={(value) =>
                          setPolicyEntryDraft((prev) => ({ ...prev, enabled: value === "enabled" }))
                        }
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={policyBusy || policyEntryDraft.target.trim().length === 0}
                      onClick={() => void addPolicyEntry()}
                    >
                      {t("governance.policy.entryAdd")}
                    </Button>
                  </div>
                </GlassPanel>
              </div>
            ) : null}
          </div>
        ) : null}
      </main>
      {confirmDialog}
    </>
  );
}
