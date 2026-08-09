import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Brain, RefreshCw, Upload } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaKnowledgeCatalog, GaMemoryImportResult } from "../../lib/ga/types";

export function GaMemorySection() {
  const { t } = useLocale();
  const [catalog, setCatalog] = useState<GaKnowledgeCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceDir, setSourceDir] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<GaMemoryImportResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await gaBridgeClient.getKnowledgeCatalog());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const doImport = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await gaBridgeClient.importMemory(sourceDir.trim());
      setImportResult(result);
      if (result.ok) {
        await refresh();
      }
    } catch (reason) {
      setImportResult({
        ok: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setImporting(false);
    }
  }, [sourceDir, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10">
            <Brain className="h-[18px] w-[18px] text-violet-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.memoryTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.memoryDesc")}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.memoryRefresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.memoryImportTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.memoryImportDesc1")} <code>memory/</code>{" "}
              {t("settings.memoryImportDesc2")} <code>temp/model_responses/</code>
              {t("settings.memoryImportDesc3")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={sourceDir}
            onChange={(event) => setSourceDir(event.target.value)}
            placeholder="e.g. D:\\path\\to\\another\\GA"
            className="h-8 min-w-[240px] flex-1 rounded-lg border border-border/70 bg-background/70 px-3 text-xs outline-none focus:border-violet-500/60"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={importing || !sourceDir.trim()}
            onClick={() => void doImport()}
          >
            <Upload className={`h-3.5 w-3.5 ${importing ? "animate-pulse" : ""}`} />
            {importing ? t("settings.memoryImporting") : t("settings.memoryImport")}
          </Button>
        </div>
        {importResult ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
              importResult.ok
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            {importResult.ok
              ? `${t("settings.memoryImported")} ${importResult.memory_copied ?? 0} ${t("settings.memoryFiles")}, ${t("settings.memoryResponses")} ${importResult.responses_copied ?? 0} (${t("settings.memorySkipped")} ${importResult.responses_skipped ?? 0})${importResult.sessions_imported ? `, ${importResult.sessions_imported} ${t("settings.memorySessions")}` : ""}. ${t("settings.memoryBackup")} ${importResult.backup_dir || t("settings.memoryNone")}.`
              : `${t("settings.memoryImportFailed")}: ${importResult.error ?? t("settings.memoryUnknown")}`}
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">{t("settings.memoryLayeredTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{t("settings.memoryLayeredDesc")}</p>
          </div>
          <span className="text-xs text-muted-foreground">
            {catalog?.memory.layers.length ?? 0} {t("settings.memoryLayers")}
          </span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(catalog?.memory.layers ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {loading ? t("settings.memoryLoading") : t("settings.memoryNoLayers")}
            </p>
          ) : (
            catalog?.memory.layers.map((layer) => (
              <article
                key={layer.id}
                className="rounded-xl border border-border/50 bg-background/70 p-3"
              >
                <code className="text-[11px] font-semibold text-violet-500">{layer.id}</code>
                <h5 className="mt-1 text-sm font-semibold">{layer.name}</h5>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{layer.purpose}</p>
              </article>
            ))
          )}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">{t("settings.memoryFooter")}</p>
    </div>
  );
}
