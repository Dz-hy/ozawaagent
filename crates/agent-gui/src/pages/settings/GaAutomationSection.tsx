import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaAutomation,
  GaAutomationInput,
  GaAutomationRun,
  GaAutomationsSnapshot,
  GaServiceState,
} from "../../lib/ga/types";

const SCHEDULER_SERVICE_ID = "reflect/scheduler.py";
const REPEATS = ["daily", "weekday", "weekly", "monthly", "once"] as const;
const EMPTY_FORM: GaAutomationInput = {
  id: "",
  schedule: "08:00",
  repeat: "daily",
  enabled: true,
  prompt: "",
  max_delay_hours: 6,
};

function formatRepeat(value: string) {
  return value.startsWith("every_") ? value.replace("every_", "Every ") : value;
}

type EditorState = { mode: "create" | "edit"; value: GaAutomationInput } | null;

export function GaAutomationSection() {
  const [snapshot, setSnapshot] = useState<GaAutomationsSnapshot>({
    automations: [],
    diagnostics: [],
  });
  const [editor, setEditor] = useState<EditorState>(null);
  const [runs, setRuns] = useState<{ taskId: string; items: GaAutomationRun[] } | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [scheduler, setScheduler] = useState<GaServiceState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const automations = await gaBridgeClient.listAutomations();
      setSnapshot(automations);
      try {
        const panel = await gaBridgeClient.getServices();
        setScheduler(panel.services.find((service) => service.id === SCHEDULER_SERVICE_ID) ?? null);
      } catch {
        setScheduler(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleScheduler() {
    if (!scheduler) return;
    setSchedulerBusy(true);
    setError(null);
    try {
      setScheduler(
        await gaBridgeClient.setServiceRunning(SCHEDULER_SERVICE_ID, !scheduler.running),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSchedulerBusy(false);
    }
  }

  async function saveEditor() {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.mode === "create") {
        await gaBridgeClient.createAutomation(editor.value);
      } else {
        const { id: _id, ...patch } = editor.value;
        await gaBridgeClient.updateAutomation(editor.value.id, patch);
      }
      setEditor(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function toggleTask(task: GaAutomation) {
    setError(null);
    try {
      await gaBridgeClient.updateAutomation(task.id, { enabled: !task.enabled });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteTask(id: string) {
    if (deletePending !== id) {
      setDeletePending(id);
      return;
    }
    setError(null);
    try {
      await gaBridgeClient.deleteAutomation(id);
      setDeletePending(null);
      if (runs?.taskId === id) setRuns(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function showRuns(id: string) {
    setError(null);
    try {
      setRuns({ taskId: id, items: await gaBridgeClient.listAutomationRuns(id) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10">
            <Clock3 className="h-[18px] w-[18px] text-amber-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">GenericAgent Automation</h3>
            <p className="text-xs text-muted-foreground">
              Agent Prompt tasks executed by the native GenericAgent scheduler.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={`rounded-md px-2 py-1 text-[11px] ${
              scheduler?.running
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground"
            }`}
            title={scheduler?.lastError || undefined}
          >
            Scheduler: {scheduler?.running ? "Running" : scheduler ? "Stopped" : "Unavailable"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void toggleScheduler()}
            disabled={!scheduler || schedulerBusy}
          >
            {schedulerBusy ? "Updating…" : scheduler?.running ? "Stop" : "Start"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditor({ mode: "create", value: EMPTY_FORM })}>
            <Plus className="h-3.5 w-3.5" />
            New task
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {snapshot.diagnostics.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
          {snapshot.diagnostics.length} invalid GenericAgent task definition(s) were isolated:{" "}
          {snapshot.diagnostics.map((item) => item.id).join(", ")}
        </div>
      ) : null}

      <div className="space-y-3">
        {!loading && snapshot.automations.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/60 px-6 py-12 text-center text-sm text-muted-foreground">
            No Agent Prompt tasks yet.
          </div>
        ) : null}
        {snapshot.automations.map((task) => (
          <article key={task.id} className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">{task.id}</h4>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {task.schedule} · {formatRepeat(task.repeat)}
                  </span>
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] ${
                      task.enabled
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {task.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {task.prompt}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Late-start window: {task.max_delay_hours}h
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => void toggleTask(task)}>
                  {task.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Run reports"
                  onClick={() => void showRuns(task.id)}
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Edit"
                  onClick={() => setEditor({ mode: "edit", value: { ...task } })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={deletePending === task.id ? "Click again to confirm deletion" : "Delete"}
                  className={deletePending === task.id ? "text-destructive" : undefined}
                  onClick={() => void deleteTask(task.id)}
                  onBlur={() => setDeletePending(null)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>

      {runs ? (
        <section className="rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Run reports · {runs.taskId}</h4>
            <Button variant="ghost" size="sm" onClick={() => setRuns(null)}>
              Close
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {runs.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">No completed reports.</p>
            ) : null}
            {runs.items.map((run) => (
              <div
                key={run.id}
                className="flex justify-between rounded-lg bg-muted/40 px-3 py-2 text-xs"
              >
                <span>{run.timestamp}</span>
                <span className="text-muted-foreground">{run.size} bytes</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {editor ? (
        <AutomationEditor
          state={editor}
          saving={saving}
          onChange={setEditor}
          onSave={() => void saveEditor()}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

type AutomationEditorProps = {
  state: NonNullable<EditorState>;
  saving: boolean;
  onChange: (state: NonNullable<EditorState>) => void;
  onSave: () => void;
  onClose: () => void;
};

function AutomationEditor({ state, saving, onChange, onSave, onClose }: AutomationEditorProps) {
  const update = (patch: Partial<GaAutomationInput>) =>
    onChange({ ...state, value: { ...state.value, ...patch } });
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(state.value.id) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(state.value.schedule) &&
    /^(?:daily|weekday|weekly|monthly|once|every_[1-9]\d*[mhd])$/.test(state.value.repeat) &&
    state.value.prompt.trim().length > 0 &&
    state.value.prompt.length <= 32768 &&
    Number.isFinite(state.value.max_delay_hours) &&
    state.value.max_delay_hours >= 0 &&
    state.value.max_delay_hours <= 720;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-5 shadow-2xl">
        <div>
          <h3 className="text-base font-semibold">
            {state.mode === "create" ? "New Agent Prompt task" : `Edit ${state.value.id}`}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Uses the local timezone and GenericAgent scheduler cadence.
          </p>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ga-automation-id">Task ID</Label>
            <Input
              id="ga-automation-id"
              value={state.value.id}
              disabled={state.mode === "edit"}
              maxLength={64}
              placeholder="daily-review"
              onChange={(event) => update({ id: event.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              Letters, numbers, underscore and hyphen.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ga-automation-schedule">Time</Label>
            <Input
              id="ga-automation-schedule"
              type="time"
              value={state.value.schedule}
              onChange={(event) => update({ schedule: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ga-automation-repeat">Repeat</Label>
            <Input
              id="ga-automation-repeat"
              list="ga-automation-repeat-options"
              value={state.value.repeat}
              placeholder="daily or every_30m"
              onChange={(event) => update({ repeat: event.target.value })}
            />
            <datalist id="ga-automation-repeat-options">
              {REPEATS.map((repeat) => (
                <option key={repeat} value={repeat} />
              ))}
            </datalist>
            <p className="text-[11px] text-muted-foreground">
              Preset cadence or every_Nm / every_Nh / every_Nd.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ga-automation-prompt">Agent Prompt</Label>
            <Textarea
              id="ga-automation-prompt"
              rows={7}
              maxLength={32768}
              value={state.value.prompt}
              onChange={(event) => update({ prompt: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ga-automation-delay">Late-start window (hours)</Label>
            <Input
              id="ga-automation-delay"
              type="number"
              min={0}
              max={720}
              step={0.25}
              value={state.value.max_delay_hours}
              onChange={(event) => update({ max_delay_hours: Number(event.target.value) })}
            />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={state.value.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            Enabled
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!valid || saving}>
            {saving ? "Saving…" : "Save task"}
          </Button>
        </div>
      </div>
    </div>
  );
}
