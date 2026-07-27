import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = path.resolve(import.meta.dirname, "../..");
const loader = createTsModuleLoader({ rootDir: guiRoot });
const { parseGaProtocol, gaProtocolToMessages } = loader.loadModule(
  "src/lib/ga/gaProtocol.ts",
);
const { gaMessageToPiMessages, gaSnapshotToConversationState } = loader.loadModule(
  "src/lib/ga/gaMessages.ts",
);

const model = { api: "openai-completions", provider: "ga", model: "genericagent" };
const toolTranscript = [
  "I will inspect it.",
  "🛠️ Tool: `file_read`   📥 args:",
  "````text",
  '{"path":"D:/work/a.txt","start":1}',
  "````",
  "`````",
  "line one\\nline two",
  "`````",
  "Done.",
].join("\n");

test("GA protocol parser preserves prose and converts closed tool blocks", () => {
  const chunks = parseGaProtocol(toolTranscript, "ga-7", 1234);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { kind: "text", text: "I will inspect it." });
  assert.equal(chunks[1].kind, "tool");
  assert.equal(chunks[1].call.id, "ga-7-tool-0");
  assert.equal(chunks[1].call.name, "file_read");
  assert.deepEqual(chunks[1].call.arguments, { path: "D:/work/a.txt", start: 1 });
  assert.equal(chunks[1].result.content[0].text, "line one\\nline two");
  assert.equal(chunks[2].text, "Done.");
});

test("GA protocol parser preserves malformed and unknown text losslessly", () => {
  const text = "before\n🛠️ Tool: `Bash`   📥 args:\n````text\n{bad";
  const chunks = parseGaProtocol(text, "ga-bad", 1);
  assert.deepEqual(chunks, [{ kind: "text", text }]);
});

test("GA protocol mapping emits adjacent assistant/tool-result messages for existing cards", () => {
  const messages = gaProtocolToMessages(
    toolTranscript,
    {
      role: "assistant",
      ...model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1234,
    },
    "ga-7",
  );
  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
  assert.equal(messages[0].content[1].type, "toolCall");
  assert.equal(messages[1].toolCallId, messages[0].content[1].id);
});

test("GA DTO and authoritative snapshots expand tool protocol into conversation messages", () => {
  const expanded = gaMessageToPiMessages(
    { id: 9, role: "assistant", content: toolTranscript, ts: 2 },
    model,
  );
  assert.equal(expanded.length, 3);
  const state = gaSnapshotToConversationState(
    {
      meta: { systemPrompt: "", tools: [] },
      segments: [
        {
          segmentIndex: 0,
          segmentId: "segment-test",
          messages: [],
          messageCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeSegmentIndex: 0,
      historyRenderItems: [],
    },
    {
      sessionId: "s1",
      status: "idle",
      messages: [{ id: 9, role: "assistant", content: toolTranscript, ts: 2 }],
      partial: null,
      msgSeq: 9,
    },
    model,
  );
  assert.deepEqual(
    state.segments[0].messages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});
