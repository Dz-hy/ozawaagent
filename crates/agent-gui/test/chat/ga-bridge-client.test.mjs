import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const runtime = {
  status: { phase: "running", restartCount: 0, generation: 1 },
  baseUrl: "http://127.0.0.1:32123",
  token: "fixture-token-not-a-real-secret-000000000000",
};
const invokes = [];
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        invokes.push({ command, args });
        return Promise.resolve(runtime);
      },
    },
  },
});
const { GaBridgeClient } = loader.loadModule("src/lib/ga/GaBridgeClient.ts");
const { gaSessionToSidebar } = loader.loadModule("src/lib/ga/gaSidebarBackend.ts");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("client unwraps v1 envelopes and sends authenticated session CRUD", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/sessions")) {
      return response(200, { payload: { sessions: [{ id: "s1", cwd: "C:/work" }] } });
    }
    if (String(url).endsWith("/session/new")) {
      return response(200, { session: { id: "s2", cwd: "C:/space dir" } });
    }
    if (String(url).endsWith("/api/v1/commands")) {
      return response(200, {
        payload: {
          commands: [{ id: "goal", name: "/goal", description: "Run a goal" }],
        },
      });
    }
    if (String(url).endsWith("/api/v1/commands/goal%2Fsafe/execute")) {
      return response(200, {
        payload: { command_id: "goal/safe", result: { type: "prompt", prompt: "GOAL:ship" } },
      });
    }
    if (options.method === "PATCH") {
      return response(200, { session: { id: "s2", title: "renamed" } });
    }
    return response(200, { ok: true });
  };
  const client = new GaBridgeClient(fetcher);
  assert.equal((await client.listSessions()).sessions[0].id, "s1");
  assert.equal((await client.createSession({ cwd: "C:/space dir" })).id, "s2");
  assert.equal((await client.listCommands())[0].id, "goal");
  assert.equal((await client.executeCommand("goal/safe", "ship")).result.prompt, "GOAL:ship");
  await client.executeCommand("effort", "high", "s2");
  const effortCall = calls.find(({ url }) => String(url).endsWith("/api/v1/commands/effort/execute"));
  assert.deepEqual(JSON.parse(effortCall.options.body), { args_text: "high", session_id: "s2" });
  assert.equal((await client.renameSession("s2", "renamed")).title, "renamed");
  await client.deleteSession("s2");

  assert.equal(invokes[0].command, "ga_runtime_start");
  assert.deepEqual(invokes[0].args, { ga_root: null, bundled_root: null });
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${runtime.token}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { cwd: "C:/space dir" });
  assert.match(calls[2].url, /\/api\/v1\/commands$/);
  assert.match(calls[3].url, /\/api\/v1\/commands\/goal%2Fsafe\/execute$/);
  assert.equal(calls[3].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[3].options.body), { args_text: "ship" });
  assert.match(calls[4].url, /\/api\/v1\/commands\/effort\/execute$/);
  assert.equal(calls[4].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[4].options.body), { args_text: "high", session_id: "s2" });
  assert.match(calls[5].url, /\/session\/s2$/);
  assert.equal(calls[6].options.method, "DELETE");
});

test("default fetcher binds Window.fetch to globalThis", async () => {
  const previousFetch = globalThis.fetch;
  let receiver;
  try {
    globalThis.fetch = function (url, options) {
      receiver = this;
      return Promise.resolve(response(200, { payload: { sessions: [] } }));
    };
    const client = new GaBridgeClient();
    await client.listSessions();
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("client reads project memory metadata without requesting content", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response(200, {
      payload: {
        projectId: "project safe",
        status: "available",
        lineCount: 42,
        updatedAt: "2026-07-29T12:00:00+00:00",
      },
    });
  };
  const client = new GaBridgeClient(fetcher);
  assert.deepEqual(await client.getProjectMemoryStatus("project safe"), {
    projectId: "project safe",
    status: "available",
    lineCount: 42,
    updatedAt: "2026-07-29T12:00:00+00:00",
  });

  assert.match(calls[0].url, /\/api\/v1\/projects\/project%20safe\/memory-status$/);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${runtime.token}`);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.body, undefined);
});

test("client reads token stats and history through read-only GA routes", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/token-stats") {
      return response(200, {
        payload: {
          schema: "ga.token_usage.v1",
          records: [{ input: 12, output: 34, cacheCreate: 5, cacheRead: 6, model: "model-safe" }],
          truncated: false,
        },
      });
    }
    return response(200, {
      payload: {
        schema: "ga.token_usage.v1",
        history: [{
          input: 7,
          output: 8,
          cacheCreate: 9,
          cacheRead: 10,
          model: "history-model",
          timestamp: 1_720_000_000,
        }],
        truncated: false,
      },
    });
  };
  const client = new GaBridgeClient(fetcher);
  assert.equal((await client.getTokenStats()).records[0].output, 34);
  assert.equal((await client.getTokenHistory()).history[0].timestamp, 1_720_000_000);
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method ?? "GET"]), [
    ["/api/v1/token-stats", "GET"],
    ["/api/v1/token-history", "GET"],
  ]);
  for (const call of calls) {
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Authorization, `Bearer ${runtime.token}`);
  }
});

test("client preserves typed bridge failures without exposing credentials", async () => {
  const client = new GaBridgeClient(async () =>
    response(503, { payload: { code: "runtime_busy", message: "temporarily unavailable" } }),
  );
  await assert.rejects(
    () => client.listSessions(),
    (error) => {
      assert.equal(error.name, "GaBridgeError");
      assert.equal(error.code, "runtime_busy");
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(String(error).includes(runtime.token), false);
      return true;
    },
  );
});

test("WebSocket manager delivers duplicate event ids exactly once", async () => {
  const previousWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    close() {
      this.onclose?.();
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const { GaWebSocketManager } = loader.loadModule("src/lib/ga/GaBridgeClient.ts");
    const manager = new GaWebSocketManager(async () => runtime);
    const events = [];
    const unsubscribe = manager.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicate = JSON.stringify({ type: "session-state", event_id: "evt-1", sessionId: "s1" });
    sockets[0].onmessage({ data: duplicate });
    sockets[0].onmessage({ data: duplicate });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, "evt-1");
    // The runtime ws endpoint does not negotiate subprotocols; the client no
    // longer sends a "ga-token.<token>" protocol (server-side noise only).
    assert.equal(sockets[0].protocols, undefined);
    unsubscribe();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("model profile client uses safe typed adapter routes", async () => {
  const calls = [];
  const profile = {
    id: 1,
    kind: "native",
    name: "Primary",
    model: "gpt-test",
    active: true,
    protocol: "oai",
    protocol_source: "var_name_heuristic",
    apibase: "https://api.example/v1",
    api_key_configured: true,
  };
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/model-profiles" && (options.method ?? "GET") === "GET") {
      return response(200, { payload: { profiles: [profile] } });
    }
    if (path === "/api/v1/model-profiles" && options.method === "POST") {
      return response(201, { payload: { profile } });
    }
    if (path === "/api/v1/model-profiles/1" && (options.method ?? "GET") === "GET") {
      return response(200, { payload: { profile } });
    }
    if (path === "/api/v1/model-profiles/1" && options.method === "PUT") {
      return response(200, { payload: { profile } });
    }
    return response(200, { payload: { id: 1, profiles: [profile] } });
  };
  const client = new GaBridgeClient(fetcher);
  assert.deepEqual(await client.listModelProfiles(), { profiles: [profile] });
  assert.deepEqual(await client.getModelProfile(1), profile);
  assert.deepEqual(
    await client.createModelProfile({
      protocol: "oai",
      model: "gpt-test",
      apibase: "https://api.example/v1",
      api_key: "",
    }),
    profile,
  );
  assert.deepEqual(await client.updateModelProfile(1, { name: "Renamed", api_key: "" }), profile);
  assert.deepEqual(await client.setDefaultModelProfile(1), { id: 1, profiles: [profile] });
  assert.deepEqual(await client.deleteModelProfile(1), { id: 1, profiles: [profile] });
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method ?? "GET"]), [
    ["/api/v1/model-profiles", "GET"],
    ["/api/v1/model-profiles/1", "GET"],
    ["/api/v1/model-profiles", "POST"],
    ["/api/v1/model-profiles/1", "PUT"],
    ["/api/v1/model-profiles/1/default", "POST"],
    ["/api/v1/model-profiles/1", "DELETE"],
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    protocol: "oai",
    model: "gpt-test",
    apibase: "https://api.example/v1",
    api_key: "",
  });
  assert.deepEqual(JSON.parse(calls[3].options.body), { name: "Renamed", api_key: "" });
  assert.equal("api_key" in profile, false);
});

test("session mapping binds workspace and normalizes seconds to milliseconds", () => {
  const mapped = gaSessionToSidebar({
    sessionId: "ga-1",
    title: "GA session",
    cwd: "D:/项目 space",
    status: "running",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_005,
  });
  assert.equal(mapped.id, "ga-1");
  assert.equal(mapped.cwd, "D:/项目 space");
  assert.equal(mapped.createdAt, 1_700_000_000_000);
  assert.equal(mapped.updatedAt, 1_700_000_005_000);
});

test("sidebar treats WS as a hint and hydrates an authoritative session snapshot", async () => {
  let eventListener;
  const emitted = [];
  const client = {
    events: () => ({
      subscribe(listener) {
        eventListener = listener;
        return () => { eventListener = undefined; };
      },
      subscribeConnection() { return () => undefined; },
    }),
    getSession: async (id) => ({
      session: { id, cwd: "D:/workspace", title: "snapshot title", status: "running", updatedAt: 12 },
    }),
  };
  const { createGaSidebarBackend } = loader.loadModule("src/lib/ga/gaSidebarBackend.ts");
  const backend = createGaSidebarBackend(client);
  const unsubscribe = backend.subscribeEvents((event) => emitted.push(event));
  eventListener({ type: "session-state", sessionId: "s9", updatedAt: 12, title: "stale hint" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted[0].kind, "upsert");
  assert.equal(emitted[0].conversation.title, "snapshot title");
  assert.equal(emitted[1].kind, "running");
  assert.equal(emitted[1].conversationId, "s9");
  unsubscribe();
});


test("client reads the Conductor snapshot through a read-only route", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response(200, {
      payload: {
        schema: "ga.conductor.v1",
        read_only: true,
        available: true,
        subagents: [{ id: "agent-1", status: "running", prompt: "Inspect", reply: "Done" }],
        chat: [{ id: "chat-1", role: "conductor", message: "Assigned" }],
        counts: { running: 1, stopped: 0 },
      },
    });
  };
  const client = new GaBridgeClient(fetcher);
  const snapshot = await client.getConductorSnapshot();
  assert.equal(snapshot.read_only, true);
  assert.equal(snapshot.subagents[0].id, "agent-1");
  assert.equal(snapshot.chat[0].message, "Assigned");
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method ?? "GET"]), [
    ["/api/v1/conductor", "GET"],
  ]);
  assert.equal(calls[0].options.body, undefined);
});


test("client uses typed GenericAgent hooks and automation registry routes", async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/services/panel")) {
      return response(200, { services: [{ id: "reflect/scheduler.py", status: "offline", running: false }] });
    }
    if (String(url).endsWith("/services/start")) {
      return response(200, { ok: true, service: { id: "reflect/scheduler.py", status: "running", running: true } });
    }
    if (String(url).endsWith("/api/v1/hooks")) {
      return response(200, { payload: { registry_state: "loaded", events: ["tool_before"], registrations: [], observations: [] } });
    }
    if (String(url).endsWith("/runs")) {
      return response(200, { payload: { id: "daily", runs: [{ id: "r1", timestamp: "2026-07-28T08:00:00", size: 12 }] } });
    }
    if (options.method === "DELETE") return response(200, { payload: { ok: true } });
    if (options.method === "POST" || options.method === "PATCH") {
      return response(200, { payload: { id: "daily", schedule: "08:00", repeat: "daily", enabled: true, prompt: "Check", max_delay_hours: 6 } });
    }
    return response(200, { payload: { automations: [], diagnostics: [] } });
  };
  const client = new GaBridgeClient(fetcher);
  assert.equal((await client.getHooks()).registry_state, "loaded");
  assert.deepEqual(await client.listAutomations(), { automations: [], diagnostics: [] });
  await client.createAutomation({ id: "daily", schedule: "08:00", repeat: "daily", enabled: true, prompt: "Check", max_delay_hours: 6 });
  await client.updateAutomation("daily", { enabled: false });
  assert.equal((await client.listAutomationRuns("daily"))[0].id, "r1");
  await client.deleteAutomation("daily");
  assert.equal((await client.getServices()).services[0].running, false);
  assert.equal((await client.setServiceRunning("reflect/scheduler.py", true)).running, true);
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method ?? "GET"]), [
    ["/api/v1/hooks", "GET"],
    ["/api/v1/automations", "GET"],
    ["/api/v1/automations", "POST"],
    ["/api/v1/automations/daily", "PATCH"],
    ["/api/v1/automations/daily/runs", "GET"],
    ["/api/v1/automations/daily", "DELETE"],
    ["/services/panel", "GET"],
    ["/services/start", "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[3].options.body), { enabled: false });
  assert.deepEqual(JSON.parse(calls[7].options.body), { id: "reflect/scheduler.py" });
});
