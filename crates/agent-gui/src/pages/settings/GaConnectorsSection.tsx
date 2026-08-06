import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Plug,
  RefreshCw,
  Search,
  XCircle,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type { GaConnectorInfo, GaMcpCallResult, GaMcpTool } from "../../lib/ga/types";

type ExpandedTools = Record<string, GaMcpTool[]>;

export function GaConnectorsSection() {
  const [connectors, setConnectors] = useState<GaConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toolsByConnector, setToolsByConnector] = useState<ExpandedTools>({});
  const [toolError, setToolError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [callResult, setCallResult] = useState<GaMcpCallResult | null>(null);
  const [args, setArgs] = useState<Record<string, Record<string, string>>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await gaBridgeClient.getConnectors();
      setConnectors(snapshot.connectors);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleConnector = useCallback(
    async (connector: GaConnectorInfo) => {
      const name = connector.name;
      const next = { ...expanded, [name]: !expanded[name] };
      setExpanded(next);
      if (next[name] && !toolsByConnector[name]) {
        setBusy(name);
        setToolError((prev) => ({ ...prev, [name]: "" }));
        try {
          const payload = await gaBridgeClient.listConnectorTools(name);
          setToolsByConnector((prev) => ({ ...prev, [name]: payload.tools }));
        } catch (reason) {
          setToolError((prev) => ({
            ...prev,
            [name]: reason instanceof Error ? reason.message : String(reason),
          }));
        } finally {
          setBusy(null);
        }
      }
    },
    [expanded, toolsByConnector],
  );

  const runTool = useCallback(
    async (connector: string, tool: GaMcpTool) => {
      setBusy(`${connector}/${tool.name}`);
      setCallResult(null);
      const argEntries = Object.entries(args[`${connector}/${tool.name}`] ?? {})
        .filter(([, value]) => value.length > 0)
        .reduce<Record<string, unknown>>((acc, [key, value]) => {
          acc[key] = value;
          return acc;
        }, {});
      try {
        const result = await gaBridgeClient.callConnectorTool(connector, tool.name, argEntries);
        setCallResult(result);
      } catch (reason) {
        setCallResult({
          connector,
          tool: tool.name,
          content: reason instanceof Error ? reason.message : String(reason),
          truncated: false,
        });
      } finally {
        setBusy(null);
      }
    },
    [args],
  );

  const allTools = useMemo(() => {
    const rows: Array<{ connector: string; tool: GaMcpTool }> = [];
    for (const [connector, tools] of Object.entries(toolsByConnector)) {
      for (const tool of tools) {
        rows.push({ connector, tool });
      }
    }
    return rows;
  }, [toolsByConnector]);

  const matchingTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    if (!query) return [];
    return allTools.filter(
      (row) =>
        row.tool.name.toLowerCase().includes(query) || row.connector.toLowerCase().includes(query),
    );
  }, [allTools, toolQuery]);

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10">
            <Plug className="h-[18px] w-[18px] text-violet-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Connectors (MCP)</h3>
            <p className="text-xs text-muted-foreground">
              Adapter-owned MCP servers under <span className="font-mono">connectors/</span>. Tools
              can be expanded per server and searched across servers.
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

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={toolQuery}
          onChange={(event) => setToolQuery(event.target.value)}
          placeholder="Search tools across servers (reverse lookup)"
          className="w-full rounded-xl border border-border/60 bg-background/60 py-2 pl-9 pr-3 text-xs outline-none focus:border-primary/50"
        />
      </div>

      {toolQuery.trim() ? (
        <section className="rounded-2xl border border-border/60 bg-card/40 p-4">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Tool reverse lookup ({matchingTools.length})
          </h4>
          {matchingTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No loaded tools match. Expand connectors below to load their tools.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {matchingTools.map((row) => (
                <li
                  key={`${row.connector}/${row.tool.name}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 font-mono text-[11px] text-violet-600">
                    {row.tool.name}
                  </span>
                  <span className="text-muted-foreground">
                    served by <span className="font-mono font-semibold">{row.connector}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {callResult ? (
        <section className="rounded-2xl border border-border/60 bg-card/40 p-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Last call: {callResult.connector}/{callResult.tool}
          </h4>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-background/70 p-3 font-mono text-[11px] text-foreground/90">
            {callResult.content}
          </pre>
          {callResult.truncated ? (
            <p className="mt-1 text-[11px] text-amber-600">Output truncated to 4 KB.</p>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {connectors?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No connectors found under <span className="font-mono">connectors/</span>. Drop a{" "}
            <span className="font-mono">ga.connector.v1</span> JSON file there and refresh.
          </p>
        ) : null}
        {(connectors ?? []).map((connector) => {
          const isOpen = expanded[connector.name] ?? false;
          const tools = toolsByConnector[connector.name] ?? [];
          return (
            <section
              key={connector.name}
              className="rounded-2xl border border-border/60 bg-card/40 p-4"
            >
              <button
                type="button"
                className="flex w-full items-start justify-between gap-3 text-left"
                onClick={() => void toggleConnector(connector)}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-mono text-xs font-semibold">
                      {connector.name}
                    </span>
                    {connector.valid ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {connector.transport}
                    {connector.transport === "stdio"
                      ? ` · ${connector.command ?? ""} ${(connector.args ?? []).join(" ")}`
                      : ` · ${connector.url ?? ""}`}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {tools.length} tools
                </span>
              </button>

              {connector.env_keys.length > 0 ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Env vars: <span className="font-mono">{connector.env_keys.join(", ")}</span>{" "}
                  (values never leave the adapter)
                </p>
              ) : null}
              {connector.redact_keys.length > 0 ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Redact keys: <span className="font-mono">{connector.redact_keys.join(", ")}</span>
                </p>
              ) : null}
              {!connector.valid && connector.error ? (
                <p className="mt-1.5 text-[11px] text-destructive">{connector.error}</p>
              ) : null}

              {isOpen ? (
                <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                  {busy === connector.name ? (
                    <p className="text-[11px] text-muted-foreground">Listing tools…</p>
                  ) : null}
                  {toolError[connector.name] ? (
                    <p className="text-[11px] text-destructive">{toolError[connector.name]}</p>
                  ) : null}
                  {tools.length === 0 && busy !== connector.name ? (
                    <p className="text-[11px] text-muted-foreground">No tools advertised.</p>
                  ) : null}
                  {tools.map((tool) => {
                    const argKeys = Object.keys(
                      (tool.input_schema?.properties as Record<string, unknown> | undefined) ?? {},
                    );
                    const toolArgs = args[`${connector.name}/${tool.name}`] ?? {};
                    const running = busy === `${connector.name}/${tool.name}`;
                    return (
                      <div
                        key={tool.name}
                        className="rounded-xl border border-border/60 bg-background/60 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] font-semibold">{tool.name}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={running}
                            onClick={() => void runTool(connector.name, tool)}
                          >
                            {running ? "Calling…" : "Call"}
                          </Button>
                        </div>
                        {tool.description ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {tool.description}
                          </p>
                        ) : null}
                        {argKeys.length > 0 ? (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            {argKeys.map((key) => (
                              <input
                                key={key}
                                value={toolArgs[key] ?? ""}
                                onChange={(event) =>
                                  setArgs((prev) => ({
                                    ...prev,
                                    [`${connector.name}/${tool.name}`]: {
                                      ...toolArgs,
                                      [key]: event.target.value,
                                    },
                                  }))
                                }
                                placeholder={key}
                                className="rounded-lg border border-border/60 bg-background/70 px-2 py-1 font-mono text-[11px] outline-none focus:border-primary/50"
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {connectors
          ? `${connectors.length} connector${connectors.length === 1 ? "" : "s"} configured.`
          : ""}{" "}
        Connectors are re-scanned on every request; schema{" "}
        <span className="font-mono">ga.connector.v1</span>, MCP protocol{" "}
        <span className="font-mono">2024-11-05</span>. Tool results are truncated at 4 KB and
        redacted through the adapter before leaving it.
      </p>
    </div>
  );
}
