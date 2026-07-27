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
const {
  formatGaAskAnswers,
  getGaAskAnswers,
  registerGaAskSender,
  submitGaAskAnswers,
} = loader.loadModule("src/lib/ga/gaAskUser.ts");

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

test("GA ask_user maps to the existing question card and carries its authoritative session", () => {
  const transcript = [
    "🛠️ Tool: `ask_user`   📥 args:",
    "````text",
    '{"question":"Pick one","candidates":["Alpha","Beta"]}',
    "````",
    "`````",
    "INTERRUPT",
    "`````",
  ].join("\n");
  const chunks = parseGaProtocol(transcript, "ga-ask", 5, "session-42");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].call.name, "AskUserQuestion");
  assert.deepEqual(chunks[0].call.arguments, {
    questions: [
      {
        id: "q1",
        prompt: "Pick one",
        options: [{ label: "Alpha" }, { label: "Beta" }],
      },
    ],
    __gaConversationId: "session-42",
  });
  assert.equal(chunks[0].result.content[0].text, "INTERRUPT");
});

test("GA ask answers use a targeted sender and become idempotently settled only after acceptance", async () => {
  const answer = {
    questionId: "q1",
    prompt: "Pick one",
    selectedLabel: "Beta",
  };
  assert.equal(formatGaAskAnswers([answer]), "Beta");
  assert.deepEqual(await submitGaAskAnswers("missing", "absent", [answer]), {
    ok: false,
    message: "GenericAgent conversation is not available.",
  });

  const prompts = [];
  const unregister = registerGaAskSender("session-42", async (prompt) => {
    prompts.push(prompt);
    return true;
  });
  assert.deepEqual(await submitGaAskAnswers("ga-ask-tool-0", "session-42", [answer]), {
    ok: true,
  });
  assert.deepEqual(getGaAskAnswers("ga-ask-tool-0"), [answer]);
  assert.deepEqual(await submitGaAskAnswers("ga-ask-tool-0", "session-42", [answer]), {
    ok: true,
  });
  assert.deepEqual(prompts, ["Beta"]);
  unregister();
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
  const firstAssistant = state.segments[0].messages[0];
  assert.equal(firstAssistant.content[1].id, "ga-s1-9-tool-0");
});
