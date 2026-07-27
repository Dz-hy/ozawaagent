import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Zap } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaHooksSnapshot } from "../../lib/ga/types";

const EVENT_LABELS: Record<string, string> = {
  agent_before: "Agent before",
  turn_before: "Turn before",
  llm_before: "LLM before",
  llm_after: "LLM after",
  tool_before: "Tool before",
  tool_after: "Tool after",
  turn_after: "Turn after",
  agent_after: "Agent after",
};

export function GaHooksSection() {
  const [snapshot, setSnapshot] = useState<GaHooksSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.getHooks());
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
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10">
            <Zap className="h-[18px] w-[18px] text-violet-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">GenericAgent Hooks</h3>
            <p className="text-xs text-muted-foreground">
              Read-only lifecycle registrations loaded by the GenericAgent runtime.
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

      {snapshot?.registry_state === "not_loaded" ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
          The Hook Registry has not been loaded yet. Start a GenericAgent conversation, then
          refresh.
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {(snapshot?.events ?? Object.keys(EVENT_LABELS)).map((event) => {
          const registrations =
            snapshot?.registrations.filter((item) => item.event === event) ?? [];
          return (
            <section key={event} className="rounded-2xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">{EVENT_LABELS[event] ?? event}</h4>
                  <code className="text-[11px] text-muted-foreground">{event}</code>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {registrations.length}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {registrations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No loaded callbacks</p>
                ) : (
                  registrations.map((registration) => (
                    <div
                      key={`${event}:${registration.module}:${registration.handler}`}
                      className="rounded-lg border border-border/40 bg-background/70 px-3 py-2"
                    >
                      <div className="truncate text-xs font-medium">{registration.handler}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {registration.module}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">Recent lifecycle activity</h4>
          <span className="text-xs text-muted-foreground">
            {snapshot?.observations.length ?? 0} buffered
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {(snapshot?.observations ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No observed lifecycle events yet</p>
          ) : (
            [...(snapshot?.observations ?? [])]
              .reverse()
              .slice(0, 20)
              .map((observation) => (
                <div
                  key={observation.id}
                  className="flex items-center justify-between gap-4 text-xs"
                >
                  <code>{observation.event}</code>
                  <time className="text-muted-foreground" dateTime={observation.timestamp}>
                    {new Date(observation.timestamp).toLocaleString()}
                  </time>
                </div>
              ))
          )}
        </div>
      </section>
      <p className="text-xs text-muted-foreground">
        Install or develop Python Hooks through GenericAgent. This view never imports, edits, or
        executes plugin code.
      </p>
    </div>
  );
}
