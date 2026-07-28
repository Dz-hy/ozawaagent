import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Pencil, Plus, RefreshCw, Trash2 } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { gaBridgeClient } from "../../lib/ga/GaBridgeClient";
import type {
  GaModelProfile,
  GaModelProfileInput,
  GaModelProfilesSnapshot,
  GaModelProtocol,
} from "../../lib/ga/types";

const EMPTY_SNAPSHOT: GaModelProfilesSnapshot = { profiles: [] };

type FormValue = {
  protocol: Exclude<GaModelProtocol, "unknown">;
  name: string;
  model: string;
  apibase: string;
  api_key: string;
  max_retries: string;
  connect_timeout: string;
  read_timeout: string;
  stream: boolean;
};

type EditorState =
  | { mode: "create"; value: FormValue }
  | { mode: "edit"; profileId: number; value: FormValue }
  | null;

function emptyForm(): FormValue {
  return {
    protocol: "oai",
    name: "",
    model: "",
    apibase: "",
    api_key: "",
    max_retries: "",
    connect_timeout: "",
    read_timeout: "",
    stream: true,
  };
}

function formFromProfile(profile: GaModelProfile): FormValue {
  return {
    protocol: profile.protocol === "claude" ? "claude" : "oai",
    name: profile.name,
    model: profile.model,
    apibase: profile.apibase ?? "",
    api_key: "",
    max_retries: profile.max_retries?.toString() ?? "",
    connect_timeout: profile.connect_timeout?.toString() ?? "",
    read_timeout: profile.read_timeout?.toString() ?? "",
    stream: profile.stream ?? true,
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function toInput(value: FormValue, creating: boolean): GaModelProfileInput {
  const input: GaModelProfileInput = {
    name: value.name.trim(),
    model: value.model.trim(),
    apibase: value.apibase.trim(),
    max_retries: optionalNumber(value.max_retries),
    connect_timeout: optionalNumber(value.connect_timeout),
    read_timeout: optionalNumber(value.read_timeout),
    stream: value.stream,
  };
  if (creating) input.protocol = value.protocol;
  if (creating || value.api_key !== "") input.api_key = value.api_key;
  return input;
}

export function GaModelProfilesSection() {
  const [snapshot, setSnapshot] = useState<GaModelProfilesSnapshot>(EMPTY_SNAPSHOT);
  const [editor, setEditor] = useState<EditorState>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.listModelProfiles());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveEditor() {
    if (!editor) return;
    const value = editor.value;
    if (!value.model.trim() || !value.apibase.trim()) {
      setError("Model and API base are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editor.mode === "create") {
        await gaBridgeClient.createModelProfile({
          ...toInput(value, true),
          protocol: value.protocol,
          model: value.model.trim(),
          apibase: value.apibase.trim(),
        });
      } else {
        await gaBridgeClient.updateModelProfile(editor.profileId, toInput(value, false));
      }
      setEditor(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(profile: GaModelProfile) {
    setBusyId(profile.id);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.setDefaultModelProfile(profile.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(profile: GaModelProfile) {
    if (!window.confirm(`Delete model profile “${profile.name}”?`)) return;
    setBusyId(profile.id);
    setError(null);
    try {
      setSnapshot(await gaBridgeClient.deleteModelProfile(profile.id));
      if (editor?.mode === "edit" && editor.profileId === profile.id) setEditor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  function updateForm<K extends keyof FormValue>(key: K, value: FormValue[K]) {
    setEditor((current) =>
      current ? { ...current, value: { ...current.value, [key]: value } } : current,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Model Profiles</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage GenericAgent runtime models. Mix-in profiles are shown read-only.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditor({ mode: "create", value: emptyForm() })}>
            <Plus className="h-4 w-4" />
            Add model
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {editor && (
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-medium">{editor.mode === "create" ? "Add model" : "Edit model"}</h3>
            <Button variant="ghost" size="sm" onClick={() => setEditor(null)} disabled={saving}>Cancel</Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="model-profile-name">Name</Label>
              <Input id="model-profile-name" value={editor.value.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Optional display name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-protocol">Protocol</Label>
              <select id="model-profile-protocol" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60" value={editor.value.protocol} disabled={editor.mode === "edit"} onChange={(event) => updateForm("protocol", event.target.value as FormValue["protocol"])}>
                <option value="oai">OpenAI compatible</option>
                <option value="claude">Claude compatible</option>
              </select>
              {editor.mode === "edit" && <p className="text-xs text-muted-foreground">Protocol cannot be changed after creation.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-model">Model *</Label>
              <Input id="model-profile-model" value={editor.value.model} onChange={(event) => updateForm("model", event.target.value)} placeholder="gpt-4.1" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-base">API base *</Label>
              <Input id="model-profile-base" value={editor.value.apibase} onChange={(event) => updateForm("apibase", event.target.value)} placeholder="https://api.example.com/v1" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="model-profile-key">API key</Label>
              <Input id="model-profile-key" type="password" autoComplete="new-password" value={editor.value.api_key} onChange={(event) => updateForm("api_key", event.target.value)} placeholder={editor.mode === "edit" ? "Leave blank to keep the configured key" : "Optional"} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-retries">Max retries</Label>
              <Input id="model-profile-retries" type="number" min="0" value={editor.value.max_retries} onChange={(event) => updateForm("max_retries", event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-connect">Connect timeout</Label>
              <Input id="model-profile-connect" type="number" min="1" value={editor.value.connect_timeout} onChange={(event) => updateForm("connect_timeout", event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-profile-read">Read timeout</Label>
              <Input id="model-profile-read" type="number" min="1" value={editor.value.read_timeout} onChange={(event) => updateForm("read_timeout", event.target.value)} />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={editor.value.stream} onChange={(event) => updateForm("stream", event.target.checked)} />
              Stream responses
            </label>
          </div>
          <div className="mt-5 flex justify-end">
            <Button onClick={() => void saveEditor()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {!loading && snapshot.profiles.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No model profiles found.</div>
        )}
        {snapshot.profiles.map((profile) => {
          const readOnly = profile.kind === "mixin";
          return (
            <div key={profile.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{profile.name || profile.model}</h3>
                    {profile.active && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600"><CheckCircle2 className="h-3 w-3" />Default</span>}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{readOnly ? "Mix-in" : profile.protocol ?? "Unknown"}</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">{profile.model}</p>
                  {profile.apibase && <p className="mt-1 truncate text-xs text-muted-foreground">{profile.apibase}</p>}
                  <p className="mt-2 text-xs text-muted-foreground">API key: {profile.api_key_configured ? "configured" : "not configured"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!profile.active && <Button variant="outline" size="sm" onClick={() => void setDefault(profile)} disabled={busyId !== null}>Set default</Button>}
                  {!readOnly && <Button variant="outline" size="sm" onClick={() => setEditor({ mode: "edit", profileId: profile.id, value: formFromProfile(profile) })} disabled={busyId !== null}><Pencil className="h-4 w-4" />Edit</Button>}
                  {!readOnly && <Button variant="destructive" size="sm" onClick={() => void remove(profile)} disabled={busyId !== null || profile.active}><Trash2 className="h-4 w-4" />Delete</Button>}
                </div>
              </div>
              {readOnly && profile.members && profile.members.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Members: {profile.members.join(", ")}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
