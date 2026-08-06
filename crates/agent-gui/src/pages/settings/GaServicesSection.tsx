import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Play,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Square,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaRuntimeHealth,
  GaRuntimeVersion,
  GaServiceLogs,
  GaServicePanel,
  GaServiceState,
} from "../../lib/ga/types";

function statusClass(status: string): string {
  if (status === "running") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (status === "offline" || status === "stopped") return "bg-muted text-muted-foreground";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

function isBridgeService(service: GaServiceState): boolean {
  return /bridge/i.test(service.id);
}

export function GaServicesSection() {
  const { t } = useLocale();
  const [panel, setPanel] = useState<GaServicePanel | null>(null);
  const [health, setHealth] = useState<GaRuntimeHealth | null>(null);
  const [version, setVersion] = useState<GaRuntimeVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<GaServiceLogs | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [panelResult, healthResult, versionResult] = await Promise.all([
        gaBridgeClient.getServices(),
        gaBridgeClient.getHealth(),
        gaBridgeClient.getVersion(),
      ]);
      setPanel(panelResult);
      setHealth(healthResult);
      setVersion(versionResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleService = useCallback(
    async (service: GaServiceState) => {
      setBusyId(service.id);
      setError(null);
      try {
        await gaBridgeClient.setServiceRunning(service.id, !service.running);
        await refresh();
        if (logsFor === service.id) {
          setLogs(await gaBridgeClient.getServiceLogs(service.id, 300));
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusyId(null);
      }
    },
    [logsFor, refresh],
  );

  const openLogs = useCallback(
    async (id: string) => {
      if (logsFor === id) {
        setLogsFor(null);
        setLogs(null);
        return;
      }
      setLogsFor(id);
      setLogs(null);
      setLogsLoading(true);
      setError(null);
      try {
        setLogs(await gaBridgeClient.getServiceLogs(id, 300));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLogsLoading(false);
      }
    },
    [logsFor],
  );

  const services = panel?.services ?? [];
  const logLines = Array.isArray(logs?.lines) ? logs.lines : [];

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10">
            <Server className="h-[18px] w-[18px] text-cyan-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.servicesTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.servicesDescription")}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.servicesRefresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!panel && loading ? (
        <section className="rounded-2xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
          {t("settings.servicesLoading")}
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <section className="rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("settings.servicesHealth")}</span>
            <Activity
              className={`h-4 w-4 ${health?.status === "ready" ? "text-emerald-500" : "text-amber-500"}`}
            />
          </div>
          <div className="mt-2 text-sm font-semibold">{health?.status ?? "—"}</div>
          {health?.official_bridge ? (
            <div
              className="mt-1 truncate text-[11px] text-muted-foreground"
              title={health.official_bridge}
            >
              {health.official_bridge}
            </div>
          ) : null}
        </section>
        <section className="rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("settings.servicesAdapter")}</span>
            <Shield className="h-4 w-4 text-cyan-500" />
          </div>
          <div className="mt-2 truncate font-mono text-xs" title={version?.adapter_version}>
            {version?.adapter_version ?? "—"}
          </div>
          {version?.api_version ? (
            <div
              className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
              title={version.api_version}
            >
              {t("settings.servicesApiVersion")} {version.api_version}
            </div>
          ) : null}
        </section>
        <section className="rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("settings.servicesGaCommit")}</span>
            <Server className="h-4 w-4 text-cyan-500" />
          </div>
          <div className="mt-2 truncate font-mono text-[11px]" title={version?.ga_commit}>
            {version?.ga_commit ?? "—"}
          </div>
        </section>
      </div>

      <div className="space-y-3">
        {services.map((service) => (
          <section key={service.id} className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(service.status)}`}
                  >
                    {service.status}
                  </span>
                  <span className="truncate font-mono text-xs">{service.id}</span>
                  {service.name && service.name !== service.id ? (
                    <span className="truncate text-xs text-muted-foreground">{service.name}</span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>
                    {service.running
                      ? t("settings.servicesRunning")
                      : t("settings.servicesStopped")}
                  </span>
                  {typeof service.memMb === "number" ? <span>{service.memMb} MB</span> : null}
                  {typeof service.cpuPct === "number" ? (
                    <span>{service.cpuPct.toFixed(1)}% CPU</span>
                  ) : null}
                  {service.lastError ? (
                    <span className="text-destructive">{service.lastError}</span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openLogs(service.id)}
                  disabled={logsLoading && logsFor === service.id}
                >
                  <ScrollText className="h-3.5 w-3.5" />
                  {logsFor === service.id
                    ? t("settings.servicesHideLogs")
                    : t("settings.servicesLogs")}
                </Button>
                {!isBridgeService(service) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void toggleService(service)}
                    disabled={busyId === service.id}
                  >
                    {service.running ? (
                      <Square className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {service.running ? t("settings.servicesStop") : t("settings.servicesStart")}
                  </Button>
                ) : null}
              </div>
            </div>
            {logsFor === service.id ? (
              <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {logLines.length > 0 ? logLines.join("\n") : t("settings.servicesLogsEmpty")}
              </pre>
            ) : null}
          </section>
        ))}
        {services.length === 0 && !loading ? (
          <section className="rounded-2xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
            {t("settings.servicesLogsEmpty")}
          </section>
        ) : null}
      </div>
    </div>
  );
}
