import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Wallet } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaTokenHistorySnapshot,
  GaTokenStatsSnapshot,
  GaTokenUsageRecord,
} from "../../lib/ga/types";

const EMPTY_STATS: GaTokenStatsSnapshot = {
  schema: "ga.token_usage.v1",
  records: [],
  truncated: false,
};
const EMPTY_HISTORY: GaTokenHistorySnapshot = {
  schema: "ga.token_usage.v1",
  history: [],
  truncated: false,
};

type TokenTotals = Omit<GaTokenUsageRecord, "model" | "timestamp">;

type ModelTotals = TokenTotals & { model: string };

function addRecord(target: TokenTotals, record: GaTokenUsageRecord): void {
  target.input += record.input;
  target.output += record.output;
  target.cacheCreate += record.cacheCreate;
  target.cacheRead += record.cacheRead;
}

function totalsFor(records: GaTokenUsageRecord[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  for (const record of records) addRecord(totals, record);
  return totals;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatTimestamp(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function modelTotalsFor(records: GaTokenUsageRecord[]): ModelTotals[] {
  const byModel = new Map<string, ModelTotals>();
  for (const record of records) {
    const model = record.model.trim();
    const current = byModel.get(model) ?? {
      model,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
    };
    addRecord(current, record);
    byModel.set(model, current);
  }
  return [...byModel.values()].sort(
    (left, right) =>
      right.input +
      right.output +
      right.cacheCreate +
      right.cacheRead -
      (left.input + left.output + left.cacheCreate + left.cacheRead),
  );
}

function historyRowsFor(
  records: GaTokenUsageRecord[],
): Array<{ record: GaTokenUsageRecord; key: string }> {
  const occurrences = new Map<string, number>();
  return records.map((record) => {
    const base = [
      record.timestamp ?? "unknown",
      record.model,
      record.input,
      record.output,
      record.cacheCreate,
      record.cacheRead,
    ].join(":");
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { record, key: `${base}:${occurrence}` };
  });
}

function TokenTotalsGrid({ totals, t }: { totals: TokenTotals; t: (key: string) => string }) {
  const items = [
    ["settings.usageInputTokens", totals.input],
    ["settings.usageOutputTokens", totals.output],
    ["settings.usageCacheCreate", totals.cacheCreate],
    ["settings.usageCacheRead", totals.cacheRead],
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map(([labelKey, value]) => (
        <div key={labelKey} className="rounded-xl border border-border/50 bg-background/70 p-3">
          <div className="text-xs text-muted-foreground">{t(labelKey)}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{formatCount(value)}</div>
        </div>
      ))}
    </div>
  );
}

export function GaUsageSection() {
  const { t, locale } = useLocale();
  const [stats, setStats] = useState<GaTokenStatsSnapshot>(EMPTY_STATS);
  const [history, setHistory] = useState<GaTokenHistorySnapshot>(EMPTY_HISTORY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStats, nextHistory] = await Promise.all([
        gaBridgeClient.getTokenStats(),
        gaBridgeClient.getTokenHistory(),
      ]);
      setStats(nextStats);
      setHistory(nextHistory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = useMemo(() => totalsFor(stats.records), [stats.records]);
  const modelTotals = useMemo(() => modelTotalsFor(stats.records), [stats.records]);
  const historyTotals = useMemo(() => totalsFor(history.history), [history.history]);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10">
            <Wallet className="h-[18px] w-[18px] text-emerald-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.usageTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.usageDescription")}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.usageRefresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.usageCurrentTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.usageCurrentDescription")}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {stats.records.length} {t("settings.usageRecords")}
          </span>
        </div>
        <div className="mt-4">
          <TokenTotalsGrid totals={totals} t={t} />
        </div>
        {stats.truncated ? (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            {t("settings.usageTruncated")}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.usageModelsTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.usageModelsDescription")}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {modelTotals.length} {t("settings.usageModels")}
          </span>
        </div>
        {modelTotals.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {loading ? t("settings.usageLoading") : t("settings.usageNoData")}
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {modelTotals.map((model) => (
              <div
                key={model.model || "unknown"}
                className="rounded-xl border border-border/50 bg-background/70 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <code className="truncate text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    {model.model || t("settings.usageUnknownModel")}
                  </code>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatCount(model.input + model.output + model.cacheCreate + model.cacheRead)}
                  </span>
                </div>
                <div className="mt-3">
                  <TokenTotalsGrid totals={model} t={t} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.usageHistoryTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.usageHistoryDescription")}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {history.history.length} {t("settings.usageRecords")}
          </span>
        </div>
        {history.history.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {loading ? t("settings.usageLoading") : t("settings.usageNoData")}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="border-b border-border/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">{t("settings.usageTime")}</th>
                  <th className="px-2 py-2 font-medium">{t("settings.usageModel")}</th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("settings.usageInputTokens")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("settings.usageOutputTokens")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("settings.usageCacheCreate")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("settings.usageCacheRead")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {historyRowsFor(history.history).map(({ record, key }) => (
                  <tr key={key} className="border-b border-border/30 last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                      {formatTimestamp(record.timestamp, locale) || t("settings.usageNoTimestamp")}
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-2 font-medium">
                      {record.model || t("settings.usageUnknownModel")}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCount(record.input)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCount(record.output)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCount(record.cacheCreate)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatCount(record.cacheRead)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.truncated ? (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            {t("settings.usageTruncated")}
          </p>
        ) : null}
        <div className="mt-4 border-t border-border/50 pt-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t("settings.usageHistoryTotal")}
          </div>
          <div className="mt-2">
            <TokenTotalsGrid totals={historyTotals} t={t} />
          </div>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">{t("settings.usagePrivacyNote")}</p>
    </div>
  );
}
