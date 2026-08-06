import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, RefreshCw, XCircle } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaCommandPacksSnapshot } from "../../lib/ga/types";

export function GaCommandPacksSection() {
  const [snapshot, setSnapshot] = useState<GaCommandPacksSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.getCommandPacks());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10">
            <FileText className="h-[18px] w-[18px] text-cyan-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Command Packs</h3>
            <p className="text-xs text-muted-foreground">
              Declarative packs and Python plugins merged into /commands; GA core
              wins on duplicate ids.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {snapshot && snapshot.conflicts.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Command id conflicts ({snapshot.conflicts.length})
          </div>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {snapshot.conflicts.map((conflict) => (
              <li key={conflict.command_id}>
                <span className="font-mono font-semibold text-amber-700">/{conflict.command_id}</span>{" "}
                claimed by {conflict.sources.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border/60 bg-card/40 p-4">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Declarative Packs ({snapshot?.packs.length ?? 0})
          </h4>
          {snapshot && snapshot.packs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No command packs found under <span className="font-mono">command_packs/</span>.
            </p>
          ) : null}
          <ul className="space-y-2">
            {(snapshot?.packs ?? []).map((pack) => (
              <li
                key={pack.file}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold">{pack.pack_id}</span>
                    {pack.valid ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {pack.file}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {pack.command_ids.length} cmds
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-border/60 bg-card/40 p-4">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Python Plugins ({snapshot?.plugins.length ?? 0})
          </h4>
          {snapshot && snapshot.plugins.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Python plugins found under <span className="font-mono">command_plugins/</span>.
            </p>
          ) : null}
          <ul className="space-y-2">
            {(snapshot?.plugins ?? []).map((plugin) => (
              <li
                key={plugin.file}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold">{plugin.file}</span>
                    {plugin.loaded ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {plugin.module}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {plugin.command_ids.length} cmds
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {snapshot ? `${snapshot.loaded_command_count} commands available through /commands.` : ""}{" "}
        Packs and plugins are re-scanned on every request; dropping a file into{" "}
        <span className="font-mono">command_packs/</span> or{" "}
        <span className="font-mono">command_plugins/</span> takes effect on next refresh.
      </p>
    </div>
  );
}
