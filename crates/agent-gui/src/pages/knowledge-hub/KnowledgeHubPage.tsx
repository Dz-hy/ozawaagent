import { useCallback, useEffect, useState } from "react";
import { GlassPanel, HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import { BookOpen, Brain, Loader2, RefreshCw, Sparkles } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaKnowledgeCatalog, GaMorphlingClassifyResult } from "../../lib/ga/types";

export function KnowledgeHubPage(props: { sidebarOpen: boolean; onOpenSidebar: () => void }) {
  const [catalog, setCatalog] = useState<GaKnowledgeCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [morphText, setMorphText] = useState("");
  const [morphResult, setMorphResult] = useState<GaMorphlingClassifyResult | null>(null);
  const [morphBusy, setMorphBusy] = useState(false);
  const [morphError, setMorphError] = useState<string | null>(null);

  const classify = useCallback(async () => {
    setMorphBusy(true);
    setMorphError(null);
    setMorphResult(null);
    try {
      setMorphResult(await gaBridgeClient.classifyMorphling(morphText));
    } catch (cause) {
      setMorphError(cause instanceof Error ? cause.message : "Classification failed");
    } finally {
      setMorphBusy(false);
    }
  }, [morphText]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await gaBridgeClient.getKnowledgeCatalog());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Knowledge catalog is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <HubBackdrop tone="neutral" />
      <HubHeader
        icon={<BookOpen className="h-5 w-5" />}
        title="Knowledge"
        subtitle="GenericAgent skills, layered memory, and Morphling capability absorption"
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
            Refresh
          </Button>
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-5">
        {error ? (
          <GlassPanel tone="neutral" className="text-sm text-destructive">
            {error}
          </GlassPanel>
        ) : null}
        {loading && !catalog ? (
          <div className="flex min-h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading GA knowledge…
          </div>
        ) : null}
        {catalog ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
            <section>
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                <h2 className="text-base font-semibold">Registered skills</h2>
                <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-xs text-muted-foreground">
                  {catalog.skills.length}
                </span>
              </div>
              {catalog.registry_state === "loaded" ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {catalog.skills.map((skill) => (
                    <GlassPanel key={skill.id} tone="amber" className="min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <code className="truncate text-sm font-semibold" title={skill.id}>
                          {skill.id}
                        </code>
                        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                          {skill.kind}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {skill.triggers.length ? (
                          skill.triggers.map((trigger) => (
                            <span
                              key={trigger}
                              className="rounded-md bg-background/50 px-2 py-1 text-xs text-muted-foreground"
                            >
                              {trigger}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">No trigger metadata</span>
                        )}
                      </div>
                    </GlassPanel>
                  ))}
                </div>
              ) : (
                <GlassPanel tone="neutral" className="text-sm text-muted-foreground">
                  The GA skill registry is not available. No fallback or legacy catalog is used.
                </GlassPanel>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2">
                <Brain className="h-5 w-5 text-violet-500" />
                <h2 className="text-base font-semibold">Layered memory</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {catalog.memory.layers.map((layer) => (
                  <GlassPanel key={layer.id} tone="violet">
                    <div className="text-xs font-semibold text-violet-500">{layer.id}</div>
                    <h3 className="mt-1 text-sm font-semibold">{layer.name}</h3>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{layer.purpose}</p>
                  </GlassPanel>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                <h2 className="text-base font-semibold">Morphling</h2>
              </div>
              <GlassPanel tone="amber">
                <p className="text-sm leading-6">{catalog.morphling.summary}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {catalog.morphling.completion}
                </p>
                {catalog.morphling.skill_ids.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {catalog.morphling.skill_ids.map((id) => (
                      <code key={id} className="rounded-md bg-background/50 px-2 py-1 text-xs">
                        {id}
                      </code>
                    ))}
                  </div>
                ) : null}
              </GlassPanel>
              <GlassPanel tone="amber" className="mt-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  <h3 className="text-sm font-semibold">Absorption wizard</h3>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Paste a fragment and let the classifier suggest the correct absorption target. The
                  wizard never writes anything: Memory goes through the Memory import flow, SOPs
                  through Skills, and callable logic through Tool/Connector + tests.
                </p>
                <textarea
                  value={morphText}
                  onChange={(event) => setMorphText(event.target.value)}
                  placeholder={"e.g. When X fails, retry with backoff; endpoint GET /api/v1/…"}
                  rows={3}
                  className="mt-3 w-full resize-y rounded-xl border border-border/60 bg-background/60 p-3 font-mono text-xs outline-none focus:border-primary/50"
                />
                <div className="mt-2 flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={morphBusy || morphText.trim().length === 0}
                    onClick={() => void classify()}
                  >
                    {morphBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Classify target
                  </Button>
                  {morphError ? (
                    <span className="text-xs text-destructive">{morphError}</span>
                  ) : null}
                </div>
                {morphResult ? (
                  <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-600">
                      <Sparkles className="h-3.5 w-3.5" />
                      Suggested target:{" "}
                      <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                        {morphResult.suggestion.class}
                      </code>
                    </div>
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {morphResult.suggestion.reasons.map((reason) => (
                        <li key={reason}>· {reason}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                      {morphResult.suggestion.class.startsWith("memory_")
                        ? "→ Layered memory (L1 index / L2 facts / L3 procedural) via the Memory import flow."
                        : morphResult.suggestion.class === "tool"
                          ? "→ Callable logic: register as Tool/Connector with tests, not as Memory."
                          : "→ Discard: informational only, no absorption target required."}
                    </p>
                  </div>
                ) : null}
              </GlassPanel>
            </section>

            <p className="text-center text-xs text-muted-foreground">
              Read-only metadata from GenericAgent. File paths and knowledge content are never
              exposed here. Skills and SOPs are discovered by the GA kernel on every request;
              placing files in the GA skills directory takes effect on next refresh.
            </p>
          </div>
        ) : null}
      </main>
    </>
  );
}
