import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  MessageSquare,
  Radio,
  RefreshCw,
  Waypoints,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaConductorSnapshot } from "../../lib/ga/types";

function formatTimestamp(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "";
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(milliseconds));
}

function statusClass(status: string): string {
  if (status === "running") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (status === "stopped") return "bg-muted text-muted-foreground";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

export function GaConductorSection() {
  const { locale, t } = useLocale();
  const [snapshot, setSnapshot] = useState<GaConductorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.getConductorSnapshot());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subagents = snapshot?.subagents ?? [];
  const recentChat = [...(snapshot?.chat ?? [])].reverse().slice(0, 20);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10">
            <Waypoints className="h-[18px] w-[18px] text-cyan-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.conductorTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.conductorDescription")}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.conductorRefresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!snapshot && loading ? (
        <section className="rounded-2xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
          {t("settings.conductorLoading")}
        </section>
      ) : null}

      {snapshot ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <section className="rounded-2xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {t("settings.conductorRunning")}
                </span>
                <Radio className="h-4 w-4 text-emerald-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {snapshot.counts.running}
              </div>
            </section>
            <section className="rounded-2xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {t("settings.conductorStopped")}
                </span>
                <Bot className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {snapshot.counts.stopped}
              </div>
            </section>
            <section className="rounded-2xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {t("settings.conductorTotal")}
                </span>
                <Waypoints className="h-4 w-4 text-cyan-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{subagents.length}</div>
            </section>
          </div>

          <section className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">{t("settings.conductorSubagentsTitle")}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.conductorSubagentsDescription")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {subagents.length} {t("settings.conductorAgents")}
              </span>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {subagents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("settings.conductorNoSubagents")}
                </p>
              ) : (
                subagents.map((agent) => (
                  <article
                    key={agent.id}
                    className="rounded-xl border border-border/50 bg-background/70 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <code className="truncate text-xs font-semibold text-cyan-600 dark:text-cyan-400">
                        {agent.id}
                      </code>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${statusClass(agent.status)}`}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2 text-xs">
                      <div>
                        <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                          {t("settings.conductorPrompt")}
                        </div>
                        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-foreground/90">
                          {agent.prompt || "—"}
                        </p>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                          {t("settings.conductorReply")}
                        </div>
                        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                          {agent.reply || "—"}
                        </p>
                      </div>
                    </div>
                    {agent.updatedAt !== undefined ? (
                      <time
                        className="mt-3 block text-[11px] text-muted-foreground"
                        dateTime={String(agent.updatedAt)}
                      >
                        {formatTimestamp(agent.updatedAt, locale)}
                      </time>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">{t("settings.conductorChatTitle")}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.conductorChatDescription")}
                </p>
              </div>
              <MessageSquare className="h-4 w-4 text-cyan-500" />
            </div>
            <div className="mt-4 space-y-2">
              {recentChat.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("settings.conductorNoChat")}</p>
              ) : (
                recentChat.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl border border-border/40 bg-background/70 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {item.role}
                      </span>
                      {item.timestamp !== undefined ? (
                        <time
                          className="text-[11px] text-muted-foreground"
                          dateTime={String(item.timestamp)}
                        >
                          {formatTimestamp(item.timestamp, locale)}
                        </time>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground/90">
                      {item.message || "—"}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("settings.conductorReadOnlyNote")}</p>
    </div>
  );
}
