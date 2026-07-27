import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = path.resolve(import.meta.dirname, "../..");
const bridgeModule = path.join(guiRoot, "src/lib/ga/GaBridgeClient.ts");
const messagesModule = path.join(guiRoot, "src/lib/ga/gaMessages.ts");

function loadTurn({ snapshots, signal, onCancel = () => undefined }) {
  let listener;
  let unsubscribed = false;
  const promptCalls = [];
  const snapshotCalls = [];
  const client = {
    events: () => ({
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribed = true;
          listener = undefined;
        };
      },
    }),
    async promptSession(sessionId, prompt) {
      promptCalls.push({ sessionId, prompt });
    },
    async cancelSession(sessionId) {
      onCancel(sessionId);
    },
    async getSessionMessages(sessionId, after, limit) {
      snapshotCalls.push({ sessionId, after, limit });
      const snapshot = snapshots.shift();
      if (!snapshot) throw new Error("test exhausted snapshots");
      return snapshot;
    },
  };
  const loader = createTsModuleLoader({
    mocks: {
      [bridgeModule]: { gaBridgeClient: client },
      [messagesModule]: {
        gaSnapshotToConversationState(baseState, snapshot) {
          return { ...baseState, marker: snapshot.status };
        },
      },
    },
  });
  const { runGaChatTurn } = loader.loadModule("src/pages/chat/runtime/runGaChatTurn.ts");
  return {
    runGaChatTurn,
    signal,
    emit: (event) => listener?.(event),
    promptCalls,
    snapshotCalls,
    wasUnsubscribed: () => unsubscribed,
  };
}

test("GA turn posts once, treats WS as a hint, and renders authoritative snapshots", async () => {
  const controller = new AbortController();
  const harness = loadTurn({
    signal: controller.signal,
    snapshots: [
      { status: "running", messages: [], msgSeq: 1 },
      { status: "idle", messages: [], msgSeq: 2 },
    ],
  });
  const rendered = [];
  const promise = harness.runGaChatTurn({
    conversationId: "ga-session-1",
    prompt: { prompt: "hello" },
    baseState: { marker: "base" },
    signal: controller.signal,
    applyState: (state) => rendered.push(state.marker),
  });
  while (harness.snapshotCalls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  harness.emit({ type: "assistant.final", sessionId: "other-session" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.snapshotCalls.length, 1);
  harness.emit({ type: "assistant.final", session_id: "ga-session-1" });

  assert.equal(await promise, "idle");
  assert.deepEqual(harness.promptCalls, [
    { sessionId: "ga-session-1", prompt: { prompt: "hello" } },
  ]);
  assert.deepEqual(rendered, ["running", "idle"]);
  assert.deepEqual(harness.snapshotCalls[0], {
    sessionId: "ga-session-1",
    after: 0,
    limit: 10_000,
  });
  assert.equal(harness.wasUnsubscribed(), true);
});

test("GA turn propagates a pre-existing abort to the authoritative cancel endpoint", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = [];
  const harness = loadTurn({
    signal: controller.signal,
    snapshots: [{ status: "cancelled", messages: [], msgSeq: 1 }],
    onCancel: (sessionId) => cancelled.push(sessionId),
  });

  const status = await harness.runGaChatTurn({
    conversationId: "ga-session-2",
    prompt: { prompt: "stop" },
    baseState: {},
    signal: controller.signal,
    applyState: () => undefined,
  });

  assert.equal(status, "cancelled");
  assert.deepEqual(cancelled, ["ga-session-2"]);
  assert.equal(harness.wasUnsubscribed(), true);
});

test("GA turn surfaces bridge terminal errors and always unsubscribes", async () => {
  const controller = new AbortController();
  const harness = loadTurn({
    signal: controller.signal,
    snapshots: [
      { status: "error", messages: [], msgSeq: 1, lastError: "sanitized failure" },
    ],
  });

  await assert.rejects(
    () =>
      harness.runGaChatTurn({
        conversationId: "ga-session-3",
        prompt: { prompt: "fail" },
        baseState: {},
        signal: controller.signal,
        applyState: () => undefined,
      }),
    /sanitized failure/,
  );
  assert.equal(harness.wasUnsubscribed(), true);
});
