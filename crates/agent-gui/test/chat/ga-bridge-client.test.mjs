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
  assert.equal((await client.createSession("C:/space dir")).id, "s2");
  assert.equal((await client.listCommands())[0].id, "goal");
  assert.equal((await client.executeCommand("goal/safe", "ship")).result.prompt, "GOAL:ship");
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
  assert.match(calls[4].url, /\/session\/s2$/);
  assert.equal(calls[5].options.method, "DELETE");
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
    assert.deepEqual(sockets[0].protocols, [`ga-token.${runtime.token}`]);
    unsubscribe();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
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
