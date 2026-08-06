import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, RefreshCw, Search, Shield } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaBridgeCapabilities, GaCommandDto } from "../../lib/ga/types";

export function GaCapabilitiesSection() {
  const { t } = useLocale();
  const [commands, setCommands] = useState<GaCommandDto[] | null>(null);
  const [bridge, setBridge] = useState<GaBridgeCapabilities | null>(null);
  const [health, setHealth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "control" | "prompt">("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cmds, caps, h] = await Promise.all([
        gaBridgeClient.listCommands(),
        gaBridgeClient.getCapabilities(),
        gaBridgeClient.getHealth(),
      ]);
      setCommands(cmds);
      setBridge(caps);
      setHealth(h?.status ?? "unknown");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = query.trim().toLowerCase();
    return commands.filter((cmd) => {
      if (kindFilter !== "all" && cmd.kind !== kindFilter) return false;
      if (!q) return true;
      return [cmd.id, cmd.title, cmd.description, cmd.arg_hint]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [commands, query, kindFilter]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const cmd of commands ?? []) if (cmd.kind) set.add(cmd.kind);
    return [...set];
  }, [commands]);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10">
            <Layers className="h-[18px] w-[18px] text-cyan-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.capabilitiesTitle")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("settings.capabilitiesDescription")}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.servicesRefresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <Shield className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.capabilitiesBridge")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.capabilitiesHealth")}:{" "}
              <span
                className={
                  health === "ready" ? "text-emerald-600" : "text-muted-foreground"
                }
              >
                {health ?? "…"}
              </span>
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(bridge?.capabilities ?? []).map((cap) => (
            <span
              key={cap}
              className="rounded-md bg-cyan-500/10 px-2 py-0.5 font-mono text-[11px] text-cyan-600"
            >
              {cap}
            </span>
          ))}
        </div>
        {bridge?.events?.length ? (
          <div className="mt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("settings.capabilitiesEvents")}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {bridge.events.map((ev) => (
                <span
                  key={ev}
                  className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {ev}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {bridge?.unknown_events_preserved ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("settings.capabilitiesUnknownEvents")}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.capabilitiesCommands")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {filtered.length} / {commands?.length ?? 0}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.capabilitiesSearch")}
                className="h-8 w-52 rounded-lg border border-border/70 bg-background/70 pl-8 pr-3 text-xs outline-none focus:border-cyan-500/60"
              />
            </div>
            <select
              value={kindFilter}
              onChange={(event) =>
                setKindFilter(event.target.value as "all" | "control" | "prompt")
              }
              className="h-8 rounded-lg border border-border/70 bg-background/70 px-2 text-xs outline-none"
            >
              <option value="all">{t("settings.capabilitiesAll")}</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3 grid gap-2">
          {loading && !commands ? (
            <p className="text-xs text-muted-foreground">{t("settings.capabilitiesLoading")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("settings.capabilitiesEmpty")}</p>
          ) : (
            filtered.map((cmd) => (
              <article
                key={cmd.id}
                className="rounded-xl border border-border/50 bg-background/70 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-[11px] font-semibold text-cyan-600">{cmd.name}</code>
                  {cmd.kind ? (
                    <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-600">
                      {cmd.kind}
                    </span>
                  ) : null}
                  <span className="text-[10px] text-muted-foreground">
                    {t("settings.capabilitiesSource")}: {cmd.plugin_version}
                  </span>
                </div>
                <h5 className="mt-1 text-sm font-semibold">{cmd.title}</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{cmd.description}</p>
                {cmd.arg_hint ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {t("settings.capabilitiesExample")}:{" "}
                    <code className="font-mono text-cyan-600">{cmd.arg_hint}</code>
                  </p>
                ) : null}
                {cmd.requires_capabilities?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cmd.requires_capabilities.map((cap) => (
                      <span
                        key={cap}
                        className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-600"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                ) : null}
                {cmd.aliases?.length ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {cmd.aliases.map((a) => `/ ${a}`).join(" ")}
                  </p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
